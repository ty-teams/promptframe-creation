import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostCallBridge} from '../lib/host-context.mjs';
import {resolveHostIdentity} from '../lib/host-identity.mjs';
import {credentials,threadA,threadB,directory,descriptor,wire,result,inputDigest,sha} from './fixtures/discovery.mjs';
const scope={projectId:'own-project',sessionId:'own-work'};
const request=(name,args={},thread=threadA)=>({name,arguments:{...scope,...args},_meta:{threadId:thread}});

function fixture({editor={kind:'web'},access='independent-read',transform=v=>v}={}){
  const calls=[];
  const client={listTools:async()=>directory(),callTool:async p=>{
    calls.push(p);const metadata=wire(p,{editor,...(p.name==='platform_describe_tool'?{
      resolvedAccess:{tool:p.arguments.tool,access,argumentsDigest:inputDigest(p.arguments.arguments)}}:{})});
    return result({control:{controlVersion:999,editor:{kind:'client',isCurrentClient:true}}},transform(metadata,p));
  }};
  return {calls,client,bridge:createHostCallBridge(client,{credentials})};
}

test('new business names use only the authoritative classification, including long read-only refusal',async()=>{
  const f=fixture();
  await f.bridge.call(request('platform_call_tool',{tool:'new_summary_v9',arguments:{b:2,a:1}}));
  assert.deepEqual(f.calls.map(p=>p.name),['platform_describe_tool','platform_call_tool']);
  assert.equal(f.calls[1].arguments.controlVersion,3);
  const blocked=fixture({access:'controlled'});
  await assert.rejects(blocked.bridge.call(request('platform_call_tool',{tool:'long_probe',arguments:{isReadOnly:true}})),/creation.editor_not_current/);
  assert.equal(blocked.calls.filter(p=>p.name==='platform_call_tool').length,0);
});

test('body annotations, forged fixed metadata identity, target and arguments cannot lend access',async()=>{
  for(const change of [v=>undefined,v=>({...v,sessionId:'other'}),
    v=>({...v,installationDigest:sha('other')}),v=>({...v,host:{kind:'codex',threadDigest:sha(threadB)}}),
    v=>({...v,resolvedAccess:{...v.resolvedAccess,tool:'other'}}),v=>({...v,resolvedAccess:{...v.resolvedAccess,argumentsDigest:sha('other')}})]){
    const f=fixture({transform:change});
    await assert.rejects(f.bridge.call(request('platform_call_tool',{tool:'new_read',arguments:{}})),/creation.access_unverified/);
    assert.equal(f.calls.length,1);
  }
});

test('directory roles can change names; missing and unknown category never fall back',async()=>{
  const f=fixture();const d=directory();d.tools.find(t=>t._meta['promptframe.role']==='describe-target').name='describe_v9';
  f.client.listTools=async()=>d;
  f.client.callTool=async p=>{f.calls.push(p);return result({},wire(p,{resolvedAccess:{tool:p.arguments.tool,access:'independent-read',argumentsDigest:inputDigest(p.arguments.arguments)}}));};
  await f.bridge.call(request('platform_call_tool',{tool:'new_read',arguments:{}}));
  assert.equal(f.calls[0].name,'describe_v9');
  for(const meta of [{}, {'promptframe.access':'future-category'}]){
    const bridge=createHostCallBridge({listTools:async()=>({tools:[{name:'read',inputSchema:{type:'object'},_meta:meta}]})},{credentials});
    await assert.rejects(bridge.call(request('read')),/creation.upgrade_required/);
  }
});

test('a newer Web ownership response blocks an older owned result and later old error',async()=>{
  let finishOld,finishError,version=2;const calls=[];
  const client={listTools:async()=>({tools:[descriptor('read','independent-read'),descriptor('write','controlled',{},true)]}),callTool:async p=>{
    calls.push(p);
    if(p.arguments.stage==='old')return new Promise(r=>{finishOld=()=>r(result({},wire(p,{controlVersion:2,editor:{kind:'client',isCurrentClient:true}})));});
    if(p.name==='write'&&p.arguments.stage==='old-error')return new Promise(r=>{finishError=()=>r({isError:true,...result({})});});
    return result({},wire(p,{controlVersion:version,editor:version===2?{kind:'client',isCurrentClient:true}:{kind:'web'}}));
  }};
  const bridge=createHostCallBridge(client,{credentials});
  await bridge.call(request('read'));const old=bridge.call(request('read',{stage:'old'}));
  await new Promise(r=>setImmediate(r));const late=bridge.call(request('write',{stage:'old-error'}));
  await new Promise(r=>setImmediate(r));version=3;await bridge.call(request('read'));
  finishOld();finishError();await Promise.all([old,late]);
  await assert.rejects(bridge.call(request('write')),/creation.editor_not_current/);
  assert.equal(calls.filter(p=>p.name==='write').length,1);
});

test('control is isolated by host thread and fixed account digest cannot switch',async()=>{
  const f=fixture({editor:{kind:'client',isCurrentClient:true}});
  await f.bridge.call(request('platform_read_session'));
  f.client.callTool=async p=>result({},wire(p,{accountDigest:sha('another-account')}));
  await assert.rejects(f.bridge.call(request('platform_call_tool',{tool:'new_read',arguments:{}},threadB)),/creation.access_unverified/);
});

test('catalog change notifications are observation driven, ordered and separate for outer and work catalogs',async()=>{
  let notices=0,outer=1,inner=1;
  const client={listTools:async()=>({...directory(),_meta:{'promptframe.catalogVersion':sha('outer'+outer)}}),
    callTool:async p=>result({},wire(p,{catalogVersion:sha('inner'+inner)}))};
  const bridge=createHostCallBridge(client,{credentials,onCatalogChange:()=>{notices++;}});
  await bridge.listTools();await bridge.call(request('platform_read_session'));await bridge.listTools();
  await new Promise(r=>setImmediate(r));assert.equal(notices,0);
  inner=2;await bridge.call(request('platform_read_session'));await bridge.call(request('platform_read_session'));
  outer=2;await bridge.listTools();await new Promise(r=>setImmediate(r));assert.equal(notices,2);
});

test('Claude identity uses only the frozen desktop UUID; absent fallback is per process',async()=>{
  const host=resolveHostIdentity({env:{CLAUDECODE:'1',CLAUDE_CODE_SESSION_ID:threadA.toUpperCase()}});
  assert.equal(host.threadId,threadA);
  assert.deepEqual(host,resolveHostIdentity({env:{CLAUDECODE:'1',CLAUDE_CODE_SESSION_ID:threadA}}));
  assert.notEqual(resolveHostIdentity({env:{CLAUDECODE:'1'}}).threadId,resolveHostIdentity({env:{CLAUDECODE:'1'}}).threadId);
  assert.throws(()=>resolveHostIdentity({host:'unknown'}),/creation.host_unsupported/);
  assert.throws(()=>resolveHostIdentity({env:{CLAUDECODE:'1',CLAUDE_CODE_SESSION_ID:'bad'}}),/creation.host_identity_invalid/);
  let sent;
  const bridge=createHostCallBridge({listTools:async()=>directory(),callTool:async p=>{sent=p;return result({},wire(p,{host:'claude-code'}));}},{credentials,host});
  await bridge.call({name:'platform_read_session',arguments:scope});assert.equal(sent._meta.threadId,threadA);
  await assert.rejects(bridge.call(request('platform_read_session')),/creation.transport_authority_managed_by_bridge/);
});


test('numeric property names use the exact server canonical bytes, not object enumeration order',async()=>{
  const f=fixture();
  const input={'2':'second','10':'tenth',nested:{'12':12,'3':3}};
  assert.equal(inputDigest(input),sha('{"10":"tenth","2":"second","nested":{"12":12,"3":3}}'));
  await f.bridge.call(request('platform_call_tool',{tool:'new_read',arguments:input}));
  assert.equal(f.calls.at(-1).name,'platform_call_tool');
});

test('a canonical platform identity is pinned through a supported transport alias and cannot change',async()=>{
  const f=fixture();
  const bridge=createHostCallBridge(f.client,{credentials:{...credentials,endpoint:'http://localhost:43210/api/mcp'}});
  await bridge.call(request('platform_read_session'));
  const send=f.client.callTool;
  f.client.callTool=async p=>{const r=await send(p);r._meta['promptframe.creation'].platformDigest=sha('different platform');return r;};
  await assert.rejects(bridge.call(request('platform_call_tool',{tool:'new_read',arguments:{}})),/creation.access_unverified/);
});


test('old same-generation success cannot erase a newer invalidation; reread precedes any next write',async()=>{
  let release,version=7;const calls=[];
  const client={listTools:async()=>({tools:[descriptor('read','independent-read',{'promptframe.role':'control-read'}),descriptor('write','controlled',{},true)]}),
    callTool:async p=>{
      calls.push(p.name);
      if(p.arguments.late)return new Promise(resolve=>{release=()=>resolve(result({},wire(p,{controlVersion:7,editor:{kind:'client',isCurrentClient:true}})));});
      if(p.name==='write')return {isError:true,...result({errorCode:'creation.editor_lost'})};
      return result({},wire(p,{controlVersion:version,editor:version===7?{kind:'client',isCurrentClient:true}:{kind:'web'}}));
    }};
  const bridge=createHostCallBridge(client,{credentials});await bridge.call(request('read'));
  const old=bridge.call(request('read',{late:true}));await new Promise(r=>setImmediate(r));
  await bridge.call(request('write'));version=8;release();await old;
  await assert.rejects(bridge.call(request('write')),/creation.editor_not_current/);
  assert.deepEqual(calls,['read','read','write','read']);
});

test('a fresh authoritative reread resolves a same-generation ownership conflict without changing control',async()=>{
  let conflict=false;const calls=[];
  const client={listTools:async()=>({tools:[descriptor('read','independent-read',{'promptframe.role':'control-read'}),descriptor('observe','independent-read'),descriptor('write','controlled',{},true)]}),
    callTool:async p=>{calls.push(p.name);return result({},wire(p,{controlVersion:7,
      editor:conflict&&p.name==='observe'?{kind:'web'}:{kind:'client',isCurrentClient:true}}));}};
  const bridge=createHostCallBridge(client,{credentials});await bridge.call(request('read'));
  conflict=true;await bridge.call(request('observe'));await bridge.call(request('write'));
  assert.deepEqual(calls,['read','observe','read','write']);
});
