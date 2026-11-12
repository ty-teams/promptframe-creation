import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {connectPlatform} from '../lib/connection.mjs';
import {writeCredentials} from '../lib/credentials.mjs';
import {bridgeErrorDetails} from '../lib/bridge-negotiation.mjs';
import {CLIENT_VERSION} from '../lib/version.mjs';
import {readPlatformBridgePolicy,assertBridgeCompatible,compareBridgeVersions,declaredHostContentCapabilities} from '../lib/bridge-negotiation.mjs';

const policy={contractVersion:'creation-bridge-capabilities/v1',minBridge:'0.2.7',recommendedBridge:'0.3.0',
  contentTypes:['text','image','audio','resource_link','resource'],blockMaxBytes:400000,responseMaxBytes:2000000};
const capabilities={experimental:{'promptframe.creation':policy}};
test('authenticated platform bridge bounds compare real versions without using native receipt versions',()=>{
  assert.deepEqual(readPlatformBridgePolicy(capabilities),policy);
  assert.throws(()=>assertBridgeCompatible(capabilities,'0.2.5'),error=>{
    assert.equal(error.message,'creation.upgrade_required');
    assert.deepEqual(error.bridgeFacts,{currentVersion:'0.2.5',minimumVersion:'0.2.7',recommendedVersion:'0.3.0',action:'upgrade_bridge_in_new_session'});
    return true;
  });
  assert.deepEqual(assertBridgeCompatible(capabilities,'0.2.7'),policy);
  assert.deepEqual(assertBridgeCompatible(capabilities,'0.10.0'),policy);
  assert.equal(compareBridgeVersions('0.10.0','0.3.0'),1);
  assert.equal(readPlatformBridgePolicy({}),null,'legacy platform has no claimed policy');
  assert.equal(bridgeErrorDetails({bridgeFacts:{token:'private'}}),undefined,'only the constructed safe error exposes details');
});
test('malformed policy and unbounded/misordered minimum-recommendation fields fail closed',()=>{
  for(const change of [{minBridge:'0.3.0',recommendedBridge:'0.2.7'},{minBridge:'v0.2.7'},
    {minBridge:'99999999999999999999.0.0'},{blockMaxBytes:400001},{contentTypes:['text','new-kind']},
    {contentTypes:['text','text']}])
    assert.throws(()=>readPlatformBridgePolicy({experimental:{'promptframe.creation':{...policy,...change}}}),/creation.bridge_policy_invalid/);
});
test('only host initialize capabilities declare media support; missing/unknown claims keep explicit text fallback',()=>{
  assert.deepEqual(declaredHostContentCapabilities({}),{types:['text'],source:'text-fallback'});
  assert.deepEqual(declaredHostContentCapabilities({experimental:{'promptframe.contentTypes':['image','audio']}}),
    {types:['text','image','audio'],source:'declared'});
  assert.deepEqual(declaredHostContentCapabilities({experimental:{'promptframe.contentTypes':['image','new-kind']}}),
    {types:['text'],source:'text-fallback'});
});

test('completed MCP initialization retains standard image/resource results without a private extension',()=>{
  // Captured Claude 2.1.321 initialize: roots + elicitation, protocol 2025-11-25.
  const capabilities={roots:{listChanged:true},elicitation:{form:{},url:{}}};
  assert.deepEqual(declaredHostContentCapabilities(capabilities),{types:['text'],source:'text-fallback'});
  assert.deepEqual(declaredHostContentCapabilities(capabilities,{initialized:true,standardContent:true}),
    {types:['text','image','resource'],source:'mcp-protocol'});
  assert.deepEqual(declaredHostContentCapabilities(capabilities,{initialized:true}),
    {types:['text'],source:'text-fallback'},'an older platform never receives an unsupported capability-source header');
  assert.deepEqual(declaredHostContentCapabilities({experimental:{'promptframe.contentTypes':['text']}},{initialized:true,standardContent:true}),
    {types:['text'],source:'declared'},'explicit host limits override the standard baseline');
  assert.deepEqual(declaredHostContentCapabilities({experimental:{'promptframe.contentTypes':['image','unknown']}},{initialized:true,standardContent:true}),
    {types:['text'],source:'text-fallback'},'a malformed explicit declaration is not replaced by broader support');
});

test('only an authenticated compatible platform enables standard result negotiation',()=>{
  const next={...policy,standardContentTypes:['text','image','resource']};
  assert.deepEqual(readPlatformBridgePolicy({experimental:{'promptframe.creation':next}}),next);
  for(const types of [true,['text','image'],['text','image','audio'],['text','image','resource','resource']])
    assert.throws(()=>readPlatformBridgePolicy({experimental:{'promptframe.creation':{...next,standardContentTypes:types}}}),/creation.bridge_policy_invalid/);
});

test('real authenticated initialize rejects a higher minimum before any tool call without fetching another package',async()=>{
  const nextMajor=(Number(CLIENT_VERSION.split('.')[0])+1)+'.0.0';
  let minimum=nextMajor,lists=0;const seen=[];
  const remote=http.createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
    seen.push({method:body.method,types:req.headers['x-promptframe-content-types'],source:req.headers['x-promptframe-content-source']});
    const server=new Server({name:'own-policy-fixture',version:'1'},{capabilities:{tools:{},experimental:{'promptframe.creation':{...policy,minBridge:minimum,recommendedBridge:nextMajor}}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>{lists++;return{tools:[]};});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    await server.connect(transport);res.on('close',()=>{void server.close().catch(()=>{});});await transport.handleRequest(req,res,body);
  });
  let client,temporary;
  try{
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
    const credentials={endpoint:'http://127.0.0.1:'+remote.address().port+'/api/mcp',token:'own-fixture',clientId:'own_policy_client_001',clientName:'Own fixture'};
    await assert.rejects(connectPlatform(credentials,{host:{kind:'codex'}}),/creation.upgrade_required/);
    assert.equal(lists,0);assert.ok(seen.every(r=>['initialize','notifications/initialized'].includes(r.method)));
    temporary=await mkdtemp(path.join(os.tmpdir(),'creation-policy-cli-'));
    const config=path.join(temporary,'credentials.json');
    await writeCredentials({...credentials,version:1,token:'pf_create_'+'k'.repeat(43),createdAt:new Date().toISOString()},config);
    const fetchFixture=path.join(temporary,'fetch-fixture.mjs');
    await import('node:fs/promises').then(fs=>fs.writeFile(fetchFixture,
      'const original=globalThis.fetch;globalThis.fetch=(u,o)=>new URL(u).hostname==="registry.npmjs.org"?Promise.resolve(new Response("",{status:404})):original(u,o);\n',{mode:0o600}));
    const child=spawn(process.execPath,['--import',fetchFixture,fileURLToPath(new URL('../bin/promptframe-creation.mjs',import.meta.url)),'bridge','--host','codex'],
      {env:{...process.env,PROMPTFRAME_CREATION_CONFIG:config},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});child.stdin.end();
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(code,1);assert.equal(stdout,'');
    assert.deepEqual(JSON.parse(stderr),{currentVersion:CLIENT_VERSION,minimumVersion:nextMajor,recommendedVersion:nextMajor,
      action:'upgrade_bridge_in_new_session',error:'creation.upgrade_required'});
    assert.equal(lists,0);
    minimum='0.2.7';client=await connectPlatform(credentials,{host:{kind:'codex'}});await client.listTools();
    assert.equal(lists,1);assert.ok(seen.every(r=>r.types==='["text"]'&&r.source==='text-fallback'));
  }finally{await client?.close();await new Promise(resolve=>remote.close(resolve));if(temporary)await rm(temporary,{recursive:true});}
});
