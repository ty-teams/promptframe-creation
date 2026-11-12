import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListResourcesRequestSchema,ReadResourceRequestSchema,ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,GetPromptRequestSchema,ListToolsRequestSchema,ResourceListChangedNotificationSchema,
  McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {createHostCallBridge} from '../lib/host-context.mjs';
import {writeCredentials} from '../lib/credentials.mjs';
import {credentials,threadA,bridgePolicy} from './fixtures/discovery.mjs';

const sha=n=>'sha256:'+n.toString(16).padStart(64,'0');
const uri='promptframe://creation-guides/opaque-project-version';
const result=n=>({contents:[{uri,mimeType:'text/markdown',text:'同一公开基线正文'}],
  _meta:{'promptframe.guideVersion':sha(n)}});

test('standard reads keep host identity, content and version while avoiding editor/tool dispatch',async()=>{
  const seen=[],notified=[];let version=1;
  const client={getServerCapabilities:()=>({resources:{},prompts:{}}),
    readResource:async p=>{seen.push(p);return result(version);},
    getPrompt:async p=>{seen.push(p);return{messages:[{role:'user',content:{type:'text',text:'公开正文'}}]};}};
  const bridge=createHostCallBridge(client,{credentials,host:{kind:'claude-code',threadId:threadA},onKnowledgeChange:k=>notified.push(k)});
  assert.deepEqual(bridge.knowledgeCapabilities,{resources:{listChanged:true},prompts:{listChanged:true}});
  assert.deepEqual(await bridge.readResource({uri}),result(1));
  version=2;assert.deepEqual(await bridge.readResource({uri}),result(2));await Promise.resolve();
  assert.deepEqual(notified,['resources']);assert.equal(seen.length,2);
  assert.deepEqual(seen[0],{uri});
  await bridge.getPrompt({name:'video-creation',arguments:{projectId:'project-a'}});
  await assert.rejects(bridge.readResource({uri,_meta:{threadId:threadA}}),/creation.transport_authority_managed_by_bridge/);
  assert.equal(seen.length,3,'forged host metadata never reaches the upstream reader');
});

test('capability negotiation, bounded responses and out-of-order observations never poll or retry',async()=>{
  const unsupported=createHostCallBridge({getServerCapabilities:()=>({})},{credentials});
  assert.deepEqual(unsupported.knowledgeCapabilities,{});
  await assert.rejects(unsupported.readResource({uri}),/creation.knowledge_unsupported/);
  let resolveOld,calls=0;const changes=[];
  const bridge=createHostCallBridge({getServerCapabilities:()=>({resources:{}}),readResource:async()=>{
    calls++;if(calls===1)return new Promise(resolve=>{resolveOld=resolve;});return result(calls);
  }},{credentials,onKnowledgeChange:k=>changes.push(k)});
  const old=bridge.readResource({uri});await bridge.readResource({uri});resolveOld(result(1));await old;
  await Promise.resolve();assert.deepEqual(changes,[],'late older read does not roll back the observed generation');
  await bridge.readResource({uri});await Promise.resolve();assert.deepEqual(changes,['resources']);assert.equal(calls,3);
  let reads=0;
  const large=createHostCallBridge({getServerCapabilities:()=>({resources:{}}),readResource:async()=>{
    reads++;return{contents:[{uri,text:'汉'.repeat(134000)}]};}},{credentials});
  await assert.rejects(large.readResource({uri}),/creation.content_budget_exceeded/);assert.equal(reads,1);
});

test('built stdio bridge forwards standard resources/prompts, safe errors and observed list_changed over real HTTP',{
  timeout:30000,
},async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),temporary=await mkdtemp(path.join(os.tmpdir(),'creation-knowledge-'));
  const config=path.join(temporary,'credentials.json'),seen=[],requests=[],token='pf_create_'+'k'.repeat(43);let version=1;
  const remote=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
    if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
    requests.push({method:body.method,types:req.headers['x-promptframe-content-types'],source:req.headers['x-promptframe-content-source']});
    const server=new Server({name:'own-knowledge-fixture',version:'1'},{capabilities:{tools:{},resources:{},prompts:{},experimental:{'promptframe.creation':bridgePolicy}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
    server.setRequestHandler(ListResourcesRequestSchema,async request=>{
      seen.push(request.params);return{resources:[{uri,name:'Public guide',mimeType:'text/markdown'}],_meta:{'promptframe.guideDirectoryVersion':sha(version)}};
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema,async()=>({resourceTemplates:[]}));
    server.setRequestHandler(ReadResourceRequestSchema,async request=>{
      seen.push(request.params);
      if(request.params.uri==='promptframe://denied')throw new McpError(ErrorCode.InvalidParams,'creation.project_scope_denied',{errorCode:'creation.project_scope_denied'});
      if(request.params.uri==='promptframe://unsafe')throw Error('private-credential-fixture');
      return result(version);
    });
    server.setRequestHandler(ListPromptsRequestSchema,async()=>({prompts:[{name:'video-creation',arguments:[{name:'projectId',required:true}]}]}));
    server.setRequestHandler(GetPromptRequestSchema,async request=>{seen.push(request.params);return{
      messages:[{role:'user',content:{type:'text',text:'同一公开基线正文'}}],_meta:{'promptframe.guideVersion':sha(version)}};});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    await server.connect(transport);res.on('close',()=>{void server.close().catch(()=>{});});
    await transport.handleRequest(req,res,body);
  });
  const client=new Client({name:'own-host-fixture',version:'1'},{capabilities:{experimental:{'promptframe.contentTypes':['text','image','audio']}}});let notifications=0;
  client.setNotificationHandler(ResourceListChangedNotificationSchema,()=>{notifications++;});
  try{
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
    await writeCredentials({version:1,endpoint:'http://127.0.0.1:'+remote.address().port+'/api/mcp',
      token,clientId:'own_knowledge_installation_0001',clientName:'Own fixture',createdAt:new Date().toISOString()},config);
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'bin/promptframe-creation.mjs'),'bridge','--host','claude-code'],
      env:{...process.env,PROMPTFRAME_CREATION_CONFIG:config,CLAUDECODE:'1',CLAUDE_CODE_SESSION_ID:threadA},stderr:'pipe'}));
    assert.equal(client.getServerCapabilities().resources.listChanged,true);
    assert.equal((await client.listResources()).resources[0].uri,uri);
    assert.deepEqual((await client.listResourceTemplates()).resourceTemplates,[]);
    assert.deepEqual(await client.readResource({uri}),result(1));
    version=2;assert.deepEqual(await client.readResource({uri}),result(2));
    for(let i=0;i<20&&!notifications;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(notifications,1);
    assert.equal((await client.listPrompts()).prompts[0].name,'video-creation');
    assert.equal((await client.getPrompt({name:'video-creation',arguments:{projectId:'project-a'}})).messages[0].content.text,'同一公开基线正文');
    await assert.rejects(client.readResource({uri:'promptframe://denied'}),error=>{
      assert.equal(error.code,ErrorCode.InvalidParams);
      assert.deepEqual(error.data,{errorCode:'creation.project_scope_denied'});return true;
    });
    await assert.rejects(client.readResource({uri:'promptframe://unsafe'}),error=>{
      assert.equal(error.code,ErrorCode.InternalError);
      assert.deepEqual(error.data,{errorCode:'creation.connection_unresolved'});
      assert.match(String(error),/creation.connection_unresolved/);assert.doesNotMatch(String(error),/private-credential/);return true;
    });
    assert.ok(seen.every(p=>p?._meta?.threadId===undefined),'independent knowledge never binds a stale startup UUID');
    assert.deepEqual(JSON.parse(requests.find(p=>p.method==='initialize').types),['text']);
    assert.equal(requests.find(p=>p.method==='initialize').source,'text-fallback');
    assert.ok(requests.filter(p=>p.method==='resources/read').every(p=>p.source==='declared'
      &&JSON.stringify(JSON.parse(p.types))===JSON.stringify(['text','image','audio'])));
  }finally{
    await client.close();await new Promise(resolve=>remote.close(resolve));await rm(temporary,{recursive:true});
  }
});
