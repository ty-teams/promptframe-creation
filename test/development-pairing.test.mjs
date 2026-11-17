import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,symlink,chmod,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readDevelopmentPairingFile} from '../lib/development-pairing.mjs';
import {createHostCallBridge} from '../lib/host-context.mjs';
import {credentials,directory,wire,result,inputDigest} from './fixtures/discovery.mjs';

test('private pairing reads only an explicit stable private file and keeps terminal metadata out of transport',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'own-pairing-'));
 try{
  const file=path.join(root,'pairing.json'),value={url:'http://127.0.0.1:24000',credential:'a'.repeat(64),connectionId:'b'.repeat(32),
   studioOrigin:'https://studio.example.test',contractVersion:'promptframe-development.v2',lifecycle:{mode:'until_stopped',idleTimeoutSeconds:1800,heartbeatSeconds:25}};
  await writeFile(file,JSON.stringify({command:'dev.workspace',playerLoaded:false,...value}),{mode:0o600});
  assert.deepEqual(await readDevelopmentPairingFile(file),value);
  await symlink(file,path.join(root,'alias.json'));await assert.rejects(readDevelopmentPairingFile(path.join(root,'alias.json')),/private_file_unavailable/);
  await chmod(file,0o644);if(process.platform!=='win32')await assert.rejects(readDevelopmentPairingFile(file),/private_file_unavailable/);
  await assert.rejects(readDevelopmentPairingFile('relative.json'),/private_file_unavailable/);
  await assert.rejects(readDevelopmentPairingFile(file,{signal:AbortSignal.abort()}),/private_file_unavailable/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('controller admission precedes local pairing IO, and only supported transport receives the secret',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'own-pairing-bridge-'));
 try{
  const file=path.join(root,'pairing.json'),secret='f'.repeat(64);await writeFile(file,JSON.stringify({credential:secret}),{mode:0o600});
  for(const owned of [false,true]){
   const sent=[],editor={kind:'client',isCurrentClient:owned},client={listTools:async()=>{
    const value=directory();value.tools.find(row=>row.name==='platform_call_tool')._meta['promptframe.localDevelopmentPairing']='creation-development-pairing/v1';return value;
   },callTool:async params=>{
    if(params.name==='platform_describe_tool')return result({},wire(params,{editor,resolvedAccess:{tool:'studio_preview',access:'controlled',argumentsDigest:inputDigest(params.arguments.arguments)}}));
    sent.push(params);return result({success:true},wire(params,{editor}));
   }};
   const bridge=createHostCallBridge(client,{credentials});
   const call={name:'platform_call_tool',_meta:{threadId:'01a10000-0000-7000-8000-000000000001'},arguments:{projectId:'own-project',sessionId:'own-work',
    tool:'studio_preview',arguments:{action:'connect_development',connectionFile:owned?file:path.join(root,'missing.json')},expectedRevision:1,idempotencyKey:'pair'}};
   if(!owned){await assert.rejects(bridge.call(call),/editor_not_current/);assert.equal(sent.filter(row=>row.name==='platform_call_tool').length,0);}
   else{
    const response=await bridge.call(call);assert(!JSON.stringify(response).includes(secret));
    const outgoing=sent.find(row=>row.name==='platform_call_tool');assert.equal(outgoing.arguments.developmentPairing.credential,secret);assert.equal(outgoing.arguments.controlVersion,3);
    await assert.rejects(bridge.call({...call,arguments:{...call.arguments,developmentPairing:{credential:secret}}}),/authority_managed/);
   }
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
