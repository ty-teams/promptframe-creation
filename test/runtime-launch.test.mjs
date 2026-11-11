import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {launchSelectedBridge} from '../lib/runtime-launch.mjs';

const host={kind:'claude-code',threadId:'01a10000-0000-7000-8000-000000000001'};
test('new runtime receives the same frozen host session and credential path with inherited stdio exactly once',async()=>{
  const child=new EventEmitter(),calls=[];child.kill=()=>{throw Error('unexpected signal');};
  const selection={root:'/own/runtime',version:'0.3.0',locked:true};
  const running=launchSelectedBridge(selection,{host,configFile:'/own/config/credentials.json',env:{OWN_FIXTURE:'1'},
    spawnImpl:(node,args,options)=>{calls.push({node,args,options});queueMicrotask(()=>child.emit('close',0,null));return child;}});
  assert.deepEqual(await running,{code:0,signal:null});assert.equal(calls.length,1);
  assert.equal(calls[0].node,process.execPath);assert.deepEqual(calls[0].args,[
    '/own/runtime/bin/promptframe-creation.mjs','bridge','--config','/own/config/credentials.json','--host','claude-code','--bridge-version','0.3.0']);
  assert.equal(calls[0].options.stdio,'inherit');assert.equal(calls[0].options.env.CLAUDE_CODE_SESSION_ID,host.threadId);
  assert.equal(calls[0].options.env.PROMPTFRAME_CREATION_CONFIG,'/own/config/credentials.json');
});
test('start failure or abnormal runtime exit never respawns or falls back to another bridge',async()=>{
  let calls=0;
  await assert.rejects(launchSelectedBridge({root:'/own/runtime',version:'0.3.0'},
    {host,configFile:'/own/config.json',spawnImpl:()=>{calls++;throw Error('failed');}}),/creation.runtime_start_unconfirmed/);
  assert.equal(calls,1);
  const child=new EventEmitter();child.kill=()=>{};
  const result=await launchSelectedBridge({root:'/own/runtime',version:'0.3.0'},{host,configFile:'/own/config.json',
    spawnImpl:()=>{calls++;queueMicrotask(()=>child.emit('close',null,'SIGTERM'));return child;}});
  assert.deepEqual(result,{code:1,signal:'SIGTERM'});assert.equal(calls,2);
});
