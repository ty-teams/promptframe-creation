import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile,chmod,symlink,unlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createClaudeHostSession,CLAUDE_HOST_PROOF,readClaudeHookInput} from '../lib/claude-host-session.mjs';
import {claudeHostProcess} from '../lib/claude-host-process.mjs';
import {createHostCallBridge} from '../lib/host-context.mjs';
import {claudeHostHooks} from '../lib/claude-hook-definition.mjs';
import {credentials,threadA,threadB,directory,result,wire,inputDigest,descriptor} from './fixtures/discovery.mjs';
const scope={projectId:'own-project',sessionId:'own-work'};
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'creation-host-session-'));let order=1,live=true,time=Date.now();
 const association=birth=>({digest:'a'.repeat(64),eventOrder:{birth:String(birth),pid:100+birth},isCurrent:async()=>live});
 const options={configFile:'/own/config/credentials.json',root,now:()=>time};
 const bridgeStore=await createClaudeHostSession({...options,association:association(1)});
 const event=async(input,birth=++order)=>(await createClaudeHostSession({...options,association:association(birth)})).hook(input);
 const start=(id,source='startup',birth)=>event({hook_event_name:'SessionStart',session_id:id,source},birth);
 const call=async(id,name,args=scope,birth)=>{
  const changed=await event({hook_event_name:'PreToolUse',session_id:id,
   tool_name:'mcp__plugin_promptframe-creation_promptframe__'+name,tool_input:args},birth);
  return{name,arguments:changed.hookSpecificOutput?.updatedInput??args};
 };
 return{root,bridgeStore,event,start,call,setLive:v=>live=v,advance:ms=>time+=ms,
  stateFile:async()=>path.join(root,(await readdir(root))[0],'state.json'),close:()=>rm(root,{recursive:true,force:true})};
}
test('startup/resume/fork/clear use current hook UUID on the same bridge; compact does not switch identity',async()=>{
 const f=await fixture();try{
  await f.start(threadA);const first=await f.bridgeStore.begin(await f.call(threadA,'read'));
  assert.equal(first.host.threadId,threadA);await first.assertCurrent();
  await f.start(threadA,'resume');await first.assertCurrent();
  await f.start(threadB,'fork');await assert.rejects(first.assertCurrent(),/host_session_changed/);
  const second=await f.bridgeStore.begin(await f.call(threadB,'read'));
  await f.start(threadB,'compact');await second.assertCurrent();
  await f.start(threadA,'clear');await assert.rejects(second.assertCurrent(),/host_session_changed/);
  assert.equal((await f.bridgeStore.begin(await f.call(threadA,'read'))).host.threadId,threadA);
 }finally{await f.close();}
});
test('a SessionStart record, missing ID or invalid ID cannot lend a controller without a current call ticket',async()=>{
 const f=await fixture();try{
  await f.start(threadA);assert.equal((await f.bridgeStore.begin({name:'read',arguments:scope})).host.threadId,undefined);
  for(const id of[undefined,'not-a-uuid']){
   await f.start(id);const raw=await f.call(id,'read');
   assert.equal(raw.arguments[CLAUDE_HOST_PROOF],undefined);
   assert.equal((await f.bridgeStore.begin(raw)).host.threadId,undefined);
  }
 }finally{await f.close();}
});
test('one-use proof binds exact tool/arguments and does not travel to the platform or expire during host review',async()=>{
 const f=await fixture();try{
  await f.start(threadA);const raw=await f.call(threadA,'read',{...scope,nested:{'2':'two','10':'ten'}});
  assert.match(raw.arguments[CLAUDE_HOST_PROOF],/^[a-f0-9]{64}$/);
  await assert.rejects(f.bridgeStore.begin({...raw,name:'write'}),/host_identity_invalid/);
  await assert.rejects(f.bridgeStore.begin({...raw,arguments:{...raw.arguments,nested:{'2':'changed'}}}),/host_identity_invalid/);
  const accepted=await f.bridgeStore.begin(raw);assert.equal(accepted.arguments[CLAUDE_HOST_PROOF],undefined);
  await assert.rejects(f.bridgeStore.begin(raw),/host_identity_invalid/);
  const reviewed=await f.call(threadA,'read');f.advance(3600000);
  assert.equal((await f.bridgeStore.begin(reviewed)).host.threadId,threadA);
  await assert.rejects(f.bridgeStore.begin({name:'read',arguments:{...scope,[CLAUDE_HOST_PROOF]:'0'.repeat(64)}}),/host_identity_invalid/);
 }finally{await f.close();}
});
test('unused call tickets have a fixed count bound; overflow never releases or repeats platform work',async()=>{
 const f=await fixture();try{
  await f.start(threadA);const first=await f.call(threadA,'read',{...scope,index:0});let last;
  for(let index=1;index<=128;index++)last=await f.call(threadA,'read',{...scope,index});
  const state=JSON.parse(await readFile(await f.stateFile(),'utf8'));assert.equal(Object.keys(state.tickets).length,128);
  await assert.rejects(f.bridgeStore.begin(first),/host_identity_invalid/);
  assert.equal((await f.bridgeStore.begin(last)).host.threadId,threadA);
 }finally{await f.close();}
});
test('late old hook cannot overwrite clear or leave a usable old proof',async()=>{
 const f=await fixture();try{
  await f.start(threadA,'startup',10);const old=await f.call(threadA,'read',scope,11);
  await f.start(threadB,'clear',20);await f.start(threadA,'startup',12);
  const late=await f.call(threadA,'read',scope,13);assert.equal(late.arguments[CLAUDE_HOST_PROOF],undefined);
  await assert.rejects(f.bridgeStore.begin(old),/host_identity_invalid/);
  assert.equal((await f.bridgeStore.begin(await f.call(threadB,'read',scope,21))).host.threadId,threadB);
 }finally{await f.close();}
});
test('symlink, public mode, corrupt state and reused host process fail closed without startup fallback',async()=>{
 for(const change of['mode','symlink','json','birth']){
  const f=await fixture();try{
   await f.start(threadA);const raw=await f.call(threadA,'read'),file=await f.stateFile();
   if(change==='mode')await chmod(file,0o644);
   if(change==='symlink'){await unlink(file);await symlink('/does-not-exist',file);}
   if(change==='json')await writeFile(file,'{broken');
   if(change==='birth')f.setLive(false);
   await assert.rejects(f.bridgeStore.begin(raw),/host_identity_(?:unavailable|invalid)/);
   assert.equal((await f.bridgeStore.begin({name:'read',arguments:scope})).host.threadId,undefined);
  }finally{await f.close();}
 }
});
test('host policy review retry keeps the unused exact proof and never auto-approves; changed or consumed input gets a new proof',async()=>{
 const f=await fixture();try{
  await f.start(threadA);const raw=await f.call(threadA,'read');
  const retry=await f.event({hook_event_name:'PreToolUse',session_id:threadA,
   tool_name:'mcp__plugin_promptframe-creation_promptframe__read',tool_input:raw.arguments});
  assert.deepEqual(retry,{});await f.bridgeStore.begin(raw);
  const next=await f.call(threadA,'read',raw.arguments);assert.notEqual(next.arguments[CLAUDE_HOST_PROOF],raw.arguments[CLAUDE_HOST_PROOF]);
  assert.equal(JSON.stringify(retry).includes('permissionDecision'),false);
 }finally{await f.close();}
});
test('unknown host may resolve a new independent target; controlled, authority and a fake target classification still refuse',async()=>{
 const calls=[];let access='independent-read';
 const client={listTools:async()=>directory(),callTool:async p=>{calls.push(p);return result({},wire(p,{host:'claude-code',
  ...(p.name==='platform_describe_tool'?{resolvedAccess:{tool:p.arguments.tool,access,argumentsDigest:inputDigest(p.arguments.arguments)}}:{})}));}};
 const bridge=createHostCallBridge(client,{credentials,host:{kind:'claude-code'}});
 const read={name:'platform_call_tool',arguments:{...scope,tool:'new_read',arguments:{x:1}}};
 await bridge.call(read);assert.deepEqual(calls.map(p=>p.name),['platform_describe_tool','platform_call_tool']);
 assert.equal(calls[1].arguments.controlVersion,3);assert.equal(calls[1]._meta?.threadId,undefined);
 access='controlled';await assert.rejects(bridge.call(read),/host_identity_unavailable/);
 await assert.rejects(bridge.call({name:'platform_create_session',arguments:scope}),/host_identity_unavailable/);
 await assert.rejects(bridge.call({...read,_meta:{threadId:threadA}}),/transport_authority_managed_by_bridge/);
 assert.equal(calls.filter(p=>p.name==='platform_call_tool').length,1);
 access='unknown';await assert.rejects(bridge.call(read),/access_unverified/);
});
test('clear fences an in-flight old response before controller/version adoption and preserves the new owner read',async()=>{
 const f=await fixture();try{
  let finishOld;const calls=[];
  const client={listTools:async()=>({...directory(),tools:[...directory().tools,descriptor('write','controlled',{},true)]}),callTool:async p=>{
   calls.push(p);if(p.arguments.old)return await new Promise(resolve=>{finishOld=()=>resolve(result({},wire(p,
    {host:'claude-code',controlVersion:999,editor:{kind:'client',isCurrentClient:true}})));});
   return result({},wire(p,{host:'claude-code',controlVersion:4,editor:{kind:'web'}}));
  }};
  const bridge=createHostCallBridge(client,{credentials,host:{kind:'claude-code'},hostSession:f.bridgeStore});
  await f.start(threadA);const old=bridge.call(await f.call(threadA,'platform_read_session',{...scope,old:true}));
  await new Promise(resolve=>setImmediate(resolve));
  while(!finishOld)await new Promise(resolve=>setImmediate(resolve));
  await f.start(threadB,'clear');await bridge.call(await f.call(threadB,'platform_read_session'));
  finishOld();await assert.rejects(old,/host_session_changed/);
  assert.deepEqual(calls.map(p=>p._meta.threadId),[threadA,threadB]);
  await assert.rejects(bridge.call(await f.call(threadB,'write')),/editor_not_current/);
  assert.equal(calls.filter(p=>p.name==='write').length,0);
  assert.ok(calls.every(p=>!Object.hasOwn(p.arguments,CLAUDE_HOST_PROOF)));
 }finally{await f.close();}
});
test('hook input preserves split UTF8 and normal large brief/Spec arguments within the existing RPC budget',async()=>{
 const value={hook_event_name:'PreToolUse',session_id:threadA,tool_input:{text:'中文🙂'.repeat(24000)}};
 const body=Buffer.from(JSON.stringify(value)),chunks=[];for(let offset=0;offset<body.length;offset+=13)chunks.push(body.subarray(offset,offset+13));
 assert.deepEqual(await readClaudeHookInput(chunks),value);
 await assert.rejects(readClaudeHookInput([Buffer.from([0xff])]),/encoded data|encoding|UTF-8/);
 await assert.rejects(readClaudeHookInput([Buffer.alloc(2*1024*1024+65537)]),/host_identity_invalid/);
});
test('ending a current host session removes only its namespace; an old end cannot clear another identity',async()=>{
 const f=await fixture();try{
  await f.start(threadA);await f.start(threadB,'clear');
  await f.event({hook_event_name:'SessionEnd',session_id:threadA,reason:'prompt_input_exit'});
  assert.equal((await f.bridgeStore.begin(await f.call(threadB,'read'))).host.threadId,threadB);
  await f.event({hook_event_name:'SessionEnd',session_id:threadB,reason:'prompt_input_exit'});
  assert.deepEqual(await readdir(f.root),[]);
 }finally{await f.close();}
});
test('process association walks intermediaries, verifies native executable and fences PID/boot reuse',async()=>{
 let birth='20',boot='own-boot';const uid=process.getuid();
 const records={100:{pid:100,ppid:80,birth:'40',uid,device:1,inode:1,exe:'/usr/bin/node'},
  80:{pid:80,ppid:60,birth:'30',uid,device:1,inode:2,exe:'/bin/sh'},
  60:{pid:60,ppid:1,birth:'20',uid,device:2,inode:3,exe:'/own/.claude/remote/ccd-cli/current-release'}};
 const options={pid:100,env:{CLAUDECODE:'1'},home:'/own',readBirth:async pid=>({...records[pid],...(pid===60?{birth}:{})}),
  readExecutable:async()=>({uid,mode:0o755,dev:2,ino:3,isFile:()=>true}),readBoot:async()=>boot};
 const owner=await claudeHostProcess(options);assert.ok(owner);assert.deepEqual(owner.eventOrder,{birth:'30',pid:80});
 assert.equal(await owner.isCurrent(),true);birth='21';assert.equal(await owner.isCurrent(),false);
 birth='20';boot='new-boot';assert.equal(await owner.isCurrent(),false);
 assert.equal(await claudeHostProcess({...options,readExecutable:async()=>({uid,mode:0o777,dev:2,ino:3,isFile:()=>true})}),null);
 records[60].exe='/workspace/claude';assert.equal(await claudeHostProcess(options),null);
});
test('plugin hooks are synchronous, use the same bundled runtime and block failed pre-call hooks without permission overrides',()=>{
 const hooks=claudeHostHooks();
 for(const event of Object.values(hooks))for(const entry of event)for(const hook of entry.hooks){
  assert.equal(hook.async,undefined);assert.equal(hook.args[1],'claude-host-hook');assert.equal(hook.timeout,5);
 }
 assert.equal(hooks.PreToolUse[0].hooks[0].onFailure,'block');
 assert.match('mcp__plugin_promptframe-creation_promptframe__platform_call_tool',new RegExp(hooks.PreToolUse[0].matcher));
 assert.doesNotMatch('mcp__other__call',new RegExp(hooks.PreToolUse[0].matcher));
});
