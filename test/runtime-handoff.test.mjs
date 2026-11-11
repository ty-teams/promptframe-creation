import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {create as createTar} from 'tar';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CLIENT_VERSION} from '../lib/version.mjs';
import {writeCredentials} from '../lib/credentials.mjs';
import {bridgePolicy,threadA} from './fixtures/discovery.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const next=CLIENT_VERSION.split('.').map(Number);next[2]++;
const nextVersion=next.join('.');

test('built entry verifies a fixed archive then hands real MCP stdio to one runtime before any business call',{
  timeout:30000,
},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'creation-runtime-handoff-')),
    pkg=path.join(temporary,'package'),config=path.join(temporary,'credentials.json'),seen=[];
  const remote=http.createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));seen.push(body.method);
    const server=new Server({name:'own-bootstrap-platform',version:'1'},{capabilities:{tools:{},
      experimental:{'promptframe.creation':{...bridgePolicy,recommendedBridge:nextVersion}}}});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    await server.connect(transport);res.once('close',()=>{void server.close().catch(()=>{});});
    await transport.handleRequest(req,res,body);
  });
  const client=new Client({name:'own-bootstrap-host',version:'1'},{capabilities:{}});
  let parentPid,childPid,stderr='';
  try{
    const fixture=await build({stdin:{resolveDir:root,sourcefile:'own-runtime-fixture.mjs',contents:`
      import {Server} from '@modelcontextprotocol/sdk/server/index.js';
      import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
      import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
      import {readFile,writeFile} from 'node:fs/promises';
      if(process.argv.includes('--version')){
        if(process.env.OWN_PREFLIGHT_MARKER){
          await writeFile(process.env.OWN_PREFLIGHT_MARKER,String(process.pid));
          await new Promise(resolve=>setTimeout(resolve,30000));
        }
        process.stdout.write(${JSON.stringify(nextVersion)}+'\\n');
      }
      else{
        const saved=JSON.parse(await readFile(process.env.PROMPTFRAME_CREATION_CONFIG,'utf8'));
        const server=new Server({name:'own-verified-runtime',version:${JSON.stringify(nextVersion)}},{capabilities:{tools:{}}});
        server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'own_runtime_marker',inputSchema:{type:'object'}}]}));
        server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:JSON.stringify({
          version:${JSON.stringify(nextVersion)},clientId:saved.clientId,threadId:process.env.CLAUDE_CODE_SESSION_ID,
          host:process.env.CLAUDECODE,pid:process.pid,args:process.argv.slice(2)})}]}));
        await server.connect(new StdioServerTransport());
      }
    `},bundle:true,platform:'node',format:'esm',target:'node20',write:false});
    const files={'package.json':JSON.stringify({name:'@promptframe/creation',version:nextVersion,private:false,
      repository:{url:'git+https://github.com/ty-teams/promptframe-creation.git'}}),
      'README.md':'Own runtime fixture','LICENSE':'MIT','bin/promptframe-creation.mjs':"import '../dist/cli.mjs';",
      'dist/cli.mjs':fixture.outputFiles[0].contents,'dist/THIRD_PARTY_NOTICES.txt':'Own test only',
      'lib/fixture.mjs':'export {};','docs/installing.md':'Own test only',
      'skills/creation-setup/SKILL.md':'Own fixture','skills/video-creation/SKILL.md':'Own fixture',
      '.codex-plugin/plugin.json':JSON.stringify({name:'promptframe-creation',version:nextVersion}),'.mcp.json':'{}'};
    for(const[name,body]of Object.entries(files)){const dest=path.join(pkg,name);await mkdir(path.dirname(dest),{recursive:true,mode:0o700});await writeFile(dest,body,{mode:0o600});}
    const chunks=[];for await(const chunk of createTar({cwd:temporary,gzip:true,portable:true,noMtime:true},['package']))chunks.push(chunk);
    const archive=Buffer.concat(chunks),tarball='https://registry.npmjs.org/@promptframe/creation/-/creation-'+nextVersion+'.tgz';
    const archiveFile=path.join(temporary,'own-runtime.tgz'),metadataFile=path.join(temporary,'metadata.json');
    await writeFile(archiveFile,archive,{mode:0o600});
    await writeFile(metadataFile,JSON.stringify({name:'@promptframe/creation',version:nextVersion,
      dist:{tarball,integrity:'sha512-'+createHash('sha512').update(archive).digest('base64')}}),{mode:0o600});
    const preload=path.join(temporary,'registry-fixture.mjs');
    await writeFile(preload,`import {readFile} from 'node:fs/promises';
      const original=globalThis.fetch;
      globalThis.fetch=async(url,options)=>{
        if(String(url)===${JSON.stringify(tarball)})return new Response(await readFile(${JSON.stringify(archiveFile)}));
        if(String(url)==='https://registry.npmjs.org/@promptframe%2fcreation/'+${JSON.stringify(nextVersion)})
          return new Response(await readFile(${JSON.stringify(metadataFile)}),{headers:{'content-type':'application/json'}});
        if(String(url).startsWith('https://registry.npmjs.org/'))throw Error('unexpected own registry request');
        return original(url,options);
      };`,{mode:0o600});
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
    await writeCredentials({version:1,endpoint:'http://127.0.0.1:'+remote.address().port+'/api/mcp',
      token:'pf_create_'+'t'.repeat(43),clientId:'own_handoff_installation_0001',clientName:'Own fixture',createdAt:new Date().toISOString()},config);
    const before=await readFile(config,'utf8');
    const transport=new StdioClientTransport({command:process.execPath,args:['--import',preload,
      path.join(root,'bin/promptframe-creation.mjs'),'bridge','--host','claude-code','--config',config],
      env:{...process.env,NODE_OPTIONS:'--import '+preload,CLAUDECODE:'1',CLAUDE_CODE_SESSION_ID:threadA},stderr:'pipe'});
    transport.stderr.on('data',chunk=>{stderr+=chunk;});
    await client.connect(transport);parentPid=transport.pid;
    assert.equal(client.getServerVersion().version,nextVersion);
    assert.equal((await client.listTools()).tools[0].name,'own_runtime_marker');
    const marker=JSON.parse((await client.callTool({name:'own_runtime_marker',arguments:{}})).content[0].text);
    childPid=marker.pid;assert.notEqual(childPid,parentPid);
    assert.equal(marker.threadId,threadA);assert.equal(marker.host,'1');assert.equal(marker.clientId,'own_handoff_installation_0001');
    assert.deepEqual(marker.args,['bridge','--config',config,'--host','claude-code','--resolved-runtime-version',nextVersion]);
    assert.equal(await readFile(config,'utf8'),before);
    assert.equal(seen.filter(method=>method==='initialize').length,1);
    assert.ok(seen.every(method=>['initialize','notifications/initialized'].includes(method)),
      'parent transport never dispatches a tool before selecting the runtime');
    await client.close();
    for(let i=0;i<100;i++){
      if([parentPid,childPid].every(pid=>{try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}}))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    for(const pid of[parentPid,childPid])assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    assert.equal(stderr,'');

    // A separate, still-unpublished runtime preparation receives one normal
    // termination. The CLI must drain its own preflight/staging before exit.
    const interruptedConfig=path.join(temporary,'interrupted/credentials.json'),preflightMarker=path.join(temporary,'preflight.pid');
    await writeCredentials(JSON.parse(before),interruptedConfig);
    const preparing=spawn(process.execPath,['--import',preload,path.join(root,'bin/promptframe-creation.mjs'),
      'bridge','--host','claude-code','--config',interruptedConfig],{
      env:{...process.env,CLAUDECODE:'1',CLAUDE_CODE_SESSION_ID:threadA,OWN_PREFLIGHT_MARKER:preflightMarker},stdio:['pipe','pipe','pipe']});
    let output='',failure='';preparing.stdout.on('data',chunk=>{output+=chunk;});preparing.stderr.on('data',chunk=>{failure+=chunk;});
    const ended=new Promise((resolve,reject)=>{preparing.once('error',reject);preparing.once('close',(code,signal)=>resolve({code,signal}));});
    let preflightPid;
    for(let i=0;i<200;i++){
      try{preflightPid=Number(await readFile(preflightMarker,'utf8'));break;}catch(e){if(e.code!=='ENOENT')throw e;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(preflightPid,'actual fixed --version child reached its own preflight');
    assert.equal(preparing.kill('SIGTERM'),true);
    assert.deepEqual(await ended,{code:1,signal:null});
    assert.equal(output,'');assert.deepEqual(JSON.parse(failure),{error:'creation.runtime_selection_interrupted'});
    assert.deepEqual(await readdir(path.join(path.dirname(interruptedConfig),'runtime-cache')),[]);
    assert.throws(()=>process.kill(preflightPid,0),{code:'ESRCH'});
    assert.equal(await readFile(interruptedConfig,'utf8'),before);
  }finally{
    await client.close();await new Promise(resolve=>remote.close(resolve));await rm(temporary,{recursive:true});
  }
});
