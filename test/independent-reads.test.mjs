import assert from 'node:assert/strict';
import test from 'node:test';
import {createHostCallBridge} from '../lib/host-context.mjs';

const base={_meta:{threadId:'01a10000-0000-7000-8000-000000000001'},
  arguments:{projectId:'own-project',sessionId:'own-work'}};
import {credentials,directory,wire,result,inputDigest} from './fixtures/discovery.mjs';
const reads=['read_spec','read_creative_plan','get_creative_plan','list_assets','read_creation_consumption','skills_list','read_skill','skill_view'];

test('supported independent reads use the server-observed version under Web, other-thread and own control without borrowing write authority',async()=>{
  const outcomes=[];
  for(const editor of [{kind:'web'},{kind:'client',isCurrentClient:false},{kind:'client',isCurrentClient:true}]){
    for(const tool of reads){
      const calls=[],client={listTools:async()=>directory(),callTool:async params=>{
        if(params.name==='platform_describe_tool')return result({},wire(params,{editor,resolvedAccess:{tool:params.arguments.tool,access:reads.includes(params.arguments.tool)?'independent-read':'controlled',argumentsDigest:inputDigest(params.arguments.arguments)}}));
        calls.push(params);
        return result(params.name==='platform_read_session'?{sessionId:'own-work',control:{controlVersion:3,editor}}:{success:true,tool},wire(params,{editor}));
      }};
      const bridge=createHostCallBridge(client,{credentials}),request={...base,name:'platform_call_tool',arguments:{...base.arguments,
        tool,arguments:{},expectedRevision:1,idempotencyKey:'own-read-'+tool}};
      let error=null;
      try{await bridge.call(request);}catch(value){error=value.message;}
      outcomes.push({editor:editor.kind+(editor.isCurrentClient??''),tool,error});
      if(error)continue;
      assert.deepEqual(calls.map(call=>call.name),['platform_call_tool']);
      assert.equal(calls[0].arguments.controlVersion,3,'metadata comes from the actual scoped authority read');
      assert.equal(calls[0]._meta.threadId,base._meta.threadId);
      if(!editor.isCurrentClient){
        await assert.rejects(bridge.call({...request,arguments:{...request.arguments,tool:'patch_spec',isReadOnly:true}}),/creation.editor_not_current/);
        assert.equal(calls.filter(call=>call.name==='platform_call_tool').length,1,'a read cannot seed an owned editor cache');
      }
    }
  }
  assert.deepEqual(outcomes.filter(row=>row.error),[],JSON.stringify(outcomes));
});

test('project onboarding needs no work or host editor; Skill use cannot borrow a read version',async()=>{
  const calls=[],bridge=createHostCallBridge({listTools:async()=>directory(),callTool:async params=>{
    if(params.name==='platform_describe_tool')return result({},wire(params,{resolvedAccess:{tool:params.arguments.tool,access:'controlled',argumentsDigest:inputDigest(params.arguments.arguments)}}));
    calls.push(params);return result(params.name==='platform_read_session'
      ?{sessionId:'own-work',control:{controlVersion:3,editor:{kind:'web'}}}:{baseline:{version:'own'}},wire(params));
  }},{credentials});
  const read=await bridge.call({name:'platform_read_onboarding',arguments:{projectId:'own-project'}});
  assert.ok(read);assert.deepEqual(calls.map(call=>call.name),['platform_read_onboarding']);
  for(const usage of ['use','invalid',{},null]){
    await assert.rejects(bridge.call({...base,name:'platform_call_tool',arguments:{...base.arguments,
      tool:'skill_view',arguments:{usage},expectedRevision:1,idempotencyKey:'own-use'}}),/creation.editor_not_current/);
  }
  assert.equal(calls.filter(call=>call.name==='platform_call_tool').length,0);
});

test('independent reads reject forged versions or a mismatched/missing control response, and preserve an upstream refusal',async()=>{
  const request={...base,name:'platform_call_tool',arguments:{...base.arguments,tool:'read_creation_consumption',arguments:{},expectedRevision:1,idempotencyKey:'own-read'}};
  for(const value of [
    {sessionId:'other-work',control:{controlVersion:3,editor:{kind:'web'}}},
    {sessionId:'own-work'},
    {sessionId:'own-work',control:{controlVersion:0,editor:{kind:'web'}}},
  ]){
    const calls=[],bridge=createHostCallBridge({listTools:async()=>directory(),callTool:async params=>{
      calls.push(params.name);
      return result(value,wire(params,{sessionId:value.sessionId,control:value.control,
        ...(params.name==='platform_describe_tool'?{resolvedAccess:{tool:params.arguments.tool,
          access:'independent-read',argumentsDigest:inputDigest(params.arguments.arguments)}}:{})}));
    }},{credentials});
    await assert.rejects(bridge.call(request),/creation.(control|access)_unverified/);
    assert.equal(calls.filter(name=>name==='platform_call_tool').length,0);
    assert.equal(calls[0],'platform_describe_tool');
  }
  let calls=0;
  const denied={isError:true,...result({success:false,errorCode:'creation.token_inactive'})};
  const bridge=createHostCallBridge({listTools:async()=>directory(),callTool:async()=>{calls++;return denied;}},{credentials});
  assert.equal(await bridge.call(request),denied);assert.equal(calls,1);
  await assert.rejects(bridge.call({...request,arguments:{...request.arguments,controlVersion:3}}),/creation.transport_authority_managed_by_bridge/);
  assert.equal(calls,1,'model authority never reaches HTTP');
});
