import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostCallBridge} from '../lib/host-context.mjs';
import {LOCAL_UPLOAD_PROTOCOL} from '../lib/local-upload.mjs';
import {credentials,threadA,threadB,directory,wire,result} from './fixtures/discovery.mjs';

const scope={projectId:'own-project',sessionId:'own-work'};
function fixture({host={kind:'codex'},hostSession,metadata=true}={}){
  const calls=[],transfers=[],selected=[];
  const tools=directory();
  tools.tools.push({name:'upload_from_current_catalog',inputSchema:{type:'object',properties:{transfer:{type:'object'}}},
    _meta:{'promptframe.access':'controlled','promptframe.localFileUpload':{contractVersion:LOCAL_UPLOAD_PROTOCOL,
      inputSchema:{type:'object',properties:{...Object.fromEntries(['projectId','sessionId','filePath','idempotencyKey','action'].map(k=>[k,{type:'string'}]))}}}}});
  const client={listTools:async()=>tools,callTool:async p=>{calls.push(p);
    return result(p.arguments.transfer?{success:true,session:{uploadId:'own-upload'}}:{},metadata?wire(p,{host:host.kind,editor:{kind:'web'}}):undefined);}};
  const localUploads={call:async context=>{selected.push(context);await context.binding.assertCurrent();
    transfers.push(await context.send({action:'inspect',uploadId:'own-upload'}));return{success:true,status:'transferring',uploadId:'own-upload'};},close:async()=>{calls.push('local-io-joined');}};
  return{calls,selected,tools,bridge:createHostCallBridge(client,{credentials,host,hostSession,localUploads})};
}

test('local protocol is discovered by trusted metadata under any tool name and strips paths before every platform RPC',async()=>{
  const f=fixture(),listed=await f.bridge.listTools();
  assert.ok(listed.tools.find(t=>t.name==='upload_from_current_catalog').inputSchema.properties.filePath);
  const response=await f.bridge.call({name:'upload_from_current_catalog',arguments:{...scope,action:'upload',filePath:'/explicitly/selected.png',
    idempotencyKey:'own-stable-key'},_meta:{threadId:threadA}});
  assert.equal(JSON.parse(response.content[0].text).uploadId,'own-upload');
  assert.deepEqual(f.calls.map(p=>p.name),['platform_read_session','upload_from_current_catalog']);
  assert.ok(f.calls.every(call=>!JSON.stringify(call).includes('/explicitly')));
  assert.equal(f.selected[0].scope.thread,threadA);assert.equal(f.selected[0].scope.account,wire(f.calls[0]).accountDigest);
  assert.equal(f.calls[1].arguments.controlVersion,undefined,'Web retains its editor');
  await f.bridge.close();assert.equal(f.calls.at(-1),'local-io-joined');
});

test('missing/forged identity and model protocol annotations cannot open any local file',async()=>{
  const f=fixture();
  const raw={name:'upload_from_current_catalog',arguments:{...scope,action:'upload',filePath:'/selected.png',idempotencyKey:'own-stable-key'}};
  await assert.rejects(f.bridge.call(raw),/creation.host_identity_required/);
  await assert.rejects(f.bridge.call({...raw,_meta:{threadId:threadA,'promptframe.localFileUpload':LOCAL_UPLOAD_PROTOCOL}}),/transport_authority_managed/);
  assert.equal(f.selected.length,0);
  const unknown=fixture({metadata:false});
  await assert.rejects(unknown.bridge.call({...raw,_meta:{threadId:threadA}}),/creation.access_unverified/);
  assert.equal(unknown.selected.length,0);
});

test('Claude current hook binding scopes the transfer and a changed session blocks its late control RPC',async()=>{
  let current=true;
  const hostSession={begin:async raw=>({host:{kind:'claude-code',threadId:threadA},arguments:raw.arguments,epoch:3,
    assertCurrent:async()=>{if(!current)throw Error('creation.host_session_changed');}})};
  const f=fixture({host:{kind:'claude-code'},hostSession});
  await f.bridge.call({name:'upload_from_current_catalog',arguments:{...scope,action:'upload',filePath:'/selected.png',idempotencyKey:'own-stable-key'}});
  assert.equal(f.selected[0].scope.host,'claude-code');assert.equal(f.selected[0].scope.thread,threadA);
  const count=f.calls.length;current=false;
  await assert.rejects(f.selected[0].send({action:'complete',uploadId:'own-upload'}),/host_session_changed/);
  assert.equal(f.calls.length,count);
  const other=fixture();await other.bridge.call({name:'upload_from_current_catalog',arguments:{...scope,action:'status',idempotencyKey:'own-stable-key'},_meta:{threadId:threadB}});
  assert.notEqual(f.selected[0].scope.thread,other.selected[0].scope.thread);
});
