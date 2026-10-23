import assert from 'node:assert/strict';
import test from 'node:test';
import {createHostCallBridge} from '../lib/host-context.mjs';

const base={_meta:{threadId:'01a10000-0000-7000-8000-000000000001'},
  arguments:{projectId:'own-project',sessionId:'own-work'}};
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
const reads=['read_spec','read_creative_plan','get_creative_plan','list_assets'];

test('four independent reads use the server-observed version under Web, other-thread and own control without borrowing write authority',async()=>{
  const outcomes=[];
  for(const editor of [{kind:'web'},{kind:'client',isCurrentClient:false},{kind:'client',isCurrentClient:true}]){
    for(const tool of reads){
      const calls=[],client={callTool:async params=>{
        calls.push(params);
        return result(params.name==='platform_read_session'?{sessionId:'own-work',control:{controlVersion:3,editor}}:{success:true,tool});
      }};
      const bridge=createHostCallBridge(client),request={...base,name:'platform_call_tool',arguments:{...base.arguments,
        tool,arguments:{},expectedRevision:1,idempotencyKey:'own-read-'+tool}};
      let error=null;
      try{await bridge.call(request);}catch(value){error=value.message;}
      outcomes.push({editor:editor.kind+(editor.isCurrentClient??''),tool,error});
      if(error)continue;
      assert.deepEqual(calls.map(call=>call.name),['platform_read_session','platform_call_tool']);
      assert.equal(calls[1].arguments.controlVersion,3,'metadata comes from the actual scoped authority read');
      assert.equal(calls[1]._meta.threadId,base._meta.threadId);
      if(!editor.isCurrentClient){
        await assert.rejects(bridge.call({...request,arguments:{...request.arguments,tool:'patch_spec',isReadOnly:true}}),/creation.editor_not_current/);
        assert.equal(calls.filter(call=>call.name==='platform_call_tool').length,1,'a read cannot seed an owned editor cache');
      }
    }
  }
  assert.deepEqual(outcomes.filter(row=>row.error),[],JSON.stringify(outcomes));
});

test('independent reads reject forged versions or a mismatched/missing control response, and preserve an upstream refusal',async()=>{
  const request={...base,name:'platform_call_tool',arguments:{...base.arguments,tool:'read_spec',arguments:{},expectedRevision:1,idempotencyKey:'own-read'}};
  for(const value of [
    {sessionId:'other-work',control:{controlVersion:3,editor:{kind:'web'}}},
    {sessionId:'own-work'},
    {sessionId:'own-work',control:{controlVersion:0,editor:{kind:'web'}}},
  ]){
    const calls=[],bridge=createHostCallBridge({callTool:async params=>{calls.push(params.name);return result(value);}});
    await assert.rejects(bridge.call(request),/creation.control_unverified/);
    assert.deepEqual(calls,['platform_read_session']);
  }
  let calls=0;
  const denied={isError:true,...result({success:false,errorCode:'creation.token_inactive'})};
  const bridge=createHostCallBridge({callTool:async()=>{calls++;return denied;}});
  assert.equal(await bridge.call(request),denied);assert.equal(calls,1);
  await assert.rejects(bridge.call({...request,arguments:{...request.arguments,controlVersion:3}}),/creation.transport_authority_managed_by_bridge/);
  assert.equal(calls,1,'model authority never reaches HTTP');
});
