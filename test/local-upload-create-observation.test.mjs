import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createLocalUploadManager} from '../lib/local-upload.mjs';
import {CreationClientError} from '../lib/credentials.mjs';

const scope={environment:'https://owned.invalid/api',tokenDigest:'owned-token-binding',hostKind:'owned-host',clientId:'owned-client'};
const input={projectId:'own-project',sessionId:'own-session',idempotencyKey:'own-original-create-key',action:'upload'};
const envelope=body=>({structuredContent:body});
async function fixture(t,{outcome='unknown',acceptLate=false}={}){
  const root=await mkdtemp(path.join(tmpdir(),'creation-create-observation-')),filePath=path.join(root,'selected.png');
  await writeFile(filePath,Buffer.alloc(20,1));let clock=Date.now(),session,creates=0,puts=0,completes=0;
  const calls=[];const send=async request=>{
    calls.push(structuredClone(request));
    if(request.action==='create'){
      creates++;
      session={...request.request,uploadId:'upload_original',assetId:'asset_original',state:'authorized',
        scope:{projectId:input.projectId,sessionId:input.sessionId},partSizeBytes:5*1024**2,partCount:1,
        expiresAt:new Date(clock+30*60000).toISOString()};
      if(outcome==='refused')session=undefined;
      throw new CreationClientError(outcome==='refused'?'creation.direct_object_upload.concurrent_multipart_quota_exceeded':'creation.local_upload.control_unconfirmed');
    }
    if(request.action==='inspect_create')return envelope({success:true,found:acceptLate&&Boolean(session),
      idempotencyKey:request.request.idempotencyKey,observedAt:new Date(clock).toISOString(),...(acceptLate&&session?{session}:{} )});
    if(request.action==='inspect')return envelope({success:true,session});
    if(request.action==='resume')return envelope({success:true,authorization:{contractVersion:'direct-object-upload.v2',session,
      uploadedParts:[],grants:[{uploadId:session.uploadId,assetId:session.assetId,partNumber:1,method:'PUT',
        url:'https://owned.invalid/part',expiresAt:new Date(clock+60000).toISOString(),requiredHeaders:{}}]}});
    if(request.action==='complete'){completes++;throw Error('controlled completion not used');}
    throw Error('unexpected '+request.action);
  };
  const manager=createLocalUploadManager({stateRoot:path.join(root,'state'),now:()=>clock,
    fetch:async()=>{puts++;throw Error('no test PUT');}});
  t.after(async()=>{await manager.close();await rm(root,{recursive:true,force:true});});
  const call=extra=>manager.call({input:{...input,filePath,...extra},scope,send,binding:{assertCurrent:async()=>{}}});
  return{call,calls,manager,send,filePath,stateRoot:path.join(root,'state'),advance:()=>{clock+=11*60000;},
    counts:()=>({creates,puts,completes})};
}

test('a definite admission refusal plus fresh original-key absence is a terminal query result, never a file timeout',async t=>{
  const f=await fixture(t,{outcome:'refused'});
  await assert.rejects(f.call(),/concurrent_multipart_quota_exceeded/);f.advance();
  for(const action of ['status','resume','cancel','upload']){
    const result=await f.call({action,filePath:'/not-readable-and-must-not-open'});
    assert.equal(result.success,true);assert.equal(result.status,'create_rejected');
    assert.equal(result.uploadId,null);assert.equal(result.errorCode,'creation.direct_object_upload.concurrent_multipart_quota_exceeded');
    assert.equal(result.creation.found,false);assert.match(result.next,/explicitly use a new key/);
  }
  assert.deepEqual(f.counts(),{creates:1,puts:0,completes:0});
  assert(f.calls.slice(1).every(row=>row.action==='inspect_create'));
});

test('a lost create ACK observes only the original key, including after the file deadline; absence remains unknown',async t=>{
  const f=await fixture(t);await assert.rejects(f.call(),/control_unconfirmed/);f.advance();
  for(const action of ['status','resume','cancel','upload']){
    const result=await f.call({action,filePath:'/must-not-open'});
    assert.equal(result.status,'creation_unconfirmed');assert.equal(result.creation.found,false);
    assert.equal(result.errorCode,'creation.local_upload.create_unconfirmed_observe_original_key');
    assert.doesNotMatch(JSON.stringify(result),/file_read_timeout/);assert.match(result.next,/same original key/);
  }
  assert.deepEqual(f.counts(),{creates:1,puts:0,completes:0});
});

test('a late original session can be recovered across bridges by read-only lookup, without a second create or upload',async t=>{
  const f=await fixture(t,{acceptLate:true});await assert.rejects(f.call(),/control_unconfirmed/);await f.manager.close();
  const second=createLocalUploadManager({stateRoot:f.stateRoot});t.after(()=>second.close());
  const result=await second.call({input:{...input,action:'status'},scope,send:f.send,binding:{assertCurrent:async()=>{}}});
  assert.equal(result.uploadId,'upload_original');assert.equal(result.assetId,'asset_original');
  assert.deepEqual(f.counts(),{creates:1,puts:0,completes:0});
});

test('wrong-key, mismatched session and unavailable lookup never turn uncertainty into a new create',async t=>{
  for(const mode of ['key','asset','unavailable']){
    const f=await fixture(t,{acceptLate:true});await assert.rejects(f.call(),/control_unconfirmed/);
    const send=async request=>{
      const response=await f.send(request);
      if(request.action==='inspect_create'){
        if(mode==='key')response.structuredContent.idempotencyKey='another-original-key';
        if(mode==='asset')response.structuredContent.session.expectedChecksum='sha256:'+'f'.repeat(64);
        if(mode==='unavailable')throw new CreationClientError('creation.local_upload.request_invalid');
      }
      return response;
    };
    await assert.rejects(f.manager.call({input:{...input,action:'resume'},scope,send,binding:{assertCurrent:async()=>{}}}));
    assert.deepEqual(f.counts(),{creates:1,puts:0,completes:0});
  }
});

