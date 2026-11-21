import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bridgePolicy, sha, wire, descriptor, threadA, threadB } from './fixtures/discovery.mjs';
import { writeCredentials } from '../lib/credentials.mjs';
import { recordLocalAuthorization, localAccountKey, localAgentDigest } from '../lib/local-accounts.mjs';

test('two independent SDK/stdio bridges keep their original profiles through ten calls each, then switch only one selected host',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'creation-account-stdio-'));
  const store=path.join(root,'accounts'),fileA=path.join(root,'a.json'),fileB=path.join(root,'b.json');
  const a={version:1,token:'pf_create_'+'a'.repeat(43),clientId:'own_stdio_installation_a_0001',clientName:'Own A'},
    b={version:1,token:'pf_create_'+'b'.repeat(43),clientId:'own_stdio_installation_b_0001',clientName:'Own B'};
  let endpoint;
  const identities={},seen=[],initializations=[];
  const remote=http.createServer(async(req,res)=>{
    const who=req.headers.authorization==='Bearer '+a.token?'a':req.headers.authorization==='Bearer '+b.token?'b':null;
    if(!who){res.writeHead(401);res.end();return;}
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks));
      if(body.method==='initialize')initializations.push(who);
      const identity=identities[who];
      const server=new Server({name:'own-account-http-fixture',version:'1'},
        {capabilities:{tools:{},experimental:{'promptframe.creation':bridgePolicy,'promptframe.accountIdentity':identity}}});
      server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[descriptor('observe_account','independent-read')]}));
      server.setRequestHandler(CallToolRequestSchema,async request=>{
        seen.push({who,thread:request.params._meta?.threadId});
        return{content:[{type:'text',text:JSON.stringify({account:localAccountKey(identity)})}],
          _meta:{'promptframe.creation':wire(request.params,{platformDigest:identity.platformDigest,
            accountDigest:identity.accountDigest,installationDigest:sha(req.headers['x-promptframe-client-id'])})}};
      });
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await server.connect(transport);res.once('close',()=>{void server.close().catch(()=>{});});
      await transport.handleRequest(req,res,body);
    }catch{if(!res.headersSent)res.writeHead(500);res.end();}
  });
  const clientA=new Client({name:'own-host-a-stdio-fixture',version:'1'},{capabilities:{}}),
    clientB=new Client({name:'own-host-b-stdio-fixture',version:'1'},{capabilities:{}});
  try{
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));endpoint='http://127.0.0.1:'+remote.address().port+'/api/mcp';
    for(const who of ['a','b'])identities[who]={contractVersion:'promptframe-account-identity/v1',
      platformDigest:sha(endpoint),accountDigest:sha(JSON.stringify(['own-tenant',who]))};
    a.endpoint=b.endpoint=endpoint;
    await writeCredentials(a,fileA);await writeCredentials(b,fileB);
    for(const[who,credential,file]of[['a',a,fileA],['b',b,fileB]])await recordLocalAuthorization({root:store,identity:identities[who],
      client:'creation',configFile:file,endpoint,token:credential.token,profile:who});
    const originalA=await readFile(fileA),originalB=await readFile(fileB);
    for(const[client,file]of[[clientA,fileA],[clientB,fileB]])await client.connect(new StdioClientTransport({command:process.execPath,
      args:[fileURLToPath(new URL('../bin/promptframe-creation.mjs',import.meta.url)),'bridge','--config',file,'--host','codex'],
      env:{...process.env,PROMPTFRAME_CREATION_CONFIG:file,PROMPTFRAME_ACCOUNT_DIRECTORY:store},stderr:'pipe'}));
    const tools=(await clientA.listTools()).tools;
    assert(tools.some(tool=>tool.name==='promptframe_local_accounts'));
    assert(tools.some(tool=>tool.name==='promptframe_local_select_account'));
    const call=(thread,name,args={})=>(thread===threadA?clientA:clientB).callTool({name,arguments:args,_meta:{threadId:thread}});
    const decode=result=>{assert(!result.isError,result.content?.[0]?.text);return JSON.parse(result.content[0].text);};
    const accounts=decode(await call(threadA,'promptframe_local_accounts'));
    assert.equal(accounts.accounts.length,2);assert.doesNotMatch(JSON.stringify(accounts),/pf_create_|configFile|credentialDigest/);
    for(const[thread,who]of[[threadA,'a'],[threadB,'b']])decode(await call(thread,'promptframe_local_select_account',{identityKey:localAccountKey(identities[who])}));
    const choiceB=path.join(store,'selections','codex-'+localAgentDigest({kind:'codex',sessionId:threadB}).slice(7)+'.json');
    const originalChoiceB=await readFile(choiceB);
    for(let i=0;i<10;i++){
      assert.equal(decode(await call(threadA,'observe_account')).account,localAccountKey(identities.a));
      assert.equal(decode(await call(threadB,'observe_account')).account,localAccountKey(identities.b));
    }
    decode(await call(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(identities.b)}));
    for(let i=0;i<10;i++){
      assert.equal(decode(await call(threadA,'observe_account')).account,localAccountKey(identities.b));
      assert.equal(decode(await call(threadB,'observe_account')).account,localAccountKey(identities.b));
    }
    assert.equal(seen.length,40);assert.equal(seen.filter(row=>row.who==='a'&&row.thread===threadA).length,10);
    assert.equal(seen.filter(row=>row.who==='b'&&row.thread===threadB).length,20);
    assert.deepEqual(await readFile(choiceB),originalChoiceB);
    assert.deepEqual(await readFile(fileA),originalA);assert.deepEqual(await readFile(fileB),originalB);
    assert.deepEqual(initializations,['a','b','b']);
  }finally{
    await Promise.allSettled([clientA.close(),clientB.close()]);
    await new Promise(resolve=>remote.close(resolve));await rm(root,{recursive:true,force:true});
  }
});
