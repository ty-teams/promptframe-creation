import {createHash} from 'node:crypto';
import {hostname,platform} from 'node:os';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';
import {openLocalUploadFile} from './local-upload-file.mjs';
import {uploadGrantedPart} from './local-upload-transfer.mjs';
import {localUploadState} from './local-upload-state.mjs';

export const LOCAL_UPLOAD_PROTOCOL='creation-local-file-upload/v1';
const wire='direct-object-upload.v2',digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=code=>{throw new CreationClientError('creation.local_upload.'+code);};
const knownError=error=>error instanceof CreationClientError&&/^creation\.[a-z0-9_.:-]{1,180}$/.test(error.message)
  ?error.message:'creation.local_upload.control_unconfirmed';
const typeByExtension={'.png':['image','image/png'],'.jpg':['image','image/jpeg'],'.jpeg':['image','image/jpeg'],
  '.webp':['image','image/webp'],'.gif':['image','image/gif'],'.wav':['audio','audio/wav'],'.mp3':['audio','audio/mpeg'],
  '.m4a':['audio','audio/mp4'],'.flac':['audio','audio/flac'],'.mp4':['video','video/mp4'],'.mov':['video','video/quicktime'],
  '.webm':['video','video/webm'],'.pdf':['document','application/pdf']};
const terminal=new Set(['ready','aborted','expired','rejected']);
const sessionCheck=(session,state)=>{
  if(!session||session.uploadId!==state.uploadId||session.assetId!==state.assetId
    ||session.sizeBytes!==state.file.sizeBytes||session.expectedChecksum!==state.file.checksum
    ||session.originalName!==state.file.name||session.scope?.projectId!==state.projectId
    ||session.scope?.sessionId!==state.sessionId)fail('session_identity_unconfirmed');
  return session;
};
function receiptsForSession(session,parts,state){
  sessionCheck(session,state);
  if(!Array.isArray(parts)||!Number.isSafeInteger(session.partSizeBytes)||session.partSizeBytes<1
    ||session.partCount!==Math.ceil(state.file.sizeBytes/session.partSizeBytes))fail('authorization_invalid');
  const seen=new Set();
  for(const part of parts){
    if(!Number.isSafeInteger(part.partNumber)||part.partNumber<1||part.partNumber>session.partCount
      ||seen.has(part.partNumber)||typeof part.etag!=='string'||!part.etag||part.etag.length>512
      ||/[\x00-\x1f\x7f]/.test(part.etag)
      ||part.sizeBytes!==Math.min(session.partSizeBytes,state.file.sizeBytes-(part.partNumber-1)*session.partSizeBytes))
      fail('part_receipt_unconfirmed');
    seen.add(part.partNumber);
  }
  return new Map(parts.map(part=>[part.partNumber,part]));
}
function partReceipts(authorization,state){
  if(authorization?.contractVersion!==wire||!Array.isArray(authorization.grants)||authorization.grants.length>2)
    fail('authorization_invalid');
  return receiptsForSession(authorization.session,authorization.uploadedParts,state);
}

/** Process-local transport tasks for the platform's existing upload sessions.
 * No daemon, business queue or second asset registry is created. */
export function createLocalUploadManager({stateRoot,fetch=globalThis.fetch,now=Date.now}={}){
  if(!stateRoot)fail('recovery_state_unavailable');
  let storePromise,closing=false,closePromise;
  const jobs=new Map(),activeCalls=new Set(),callControllers=new Set();
  const store=()=>storePromise??=localUploadState(stateRoot,{now});
  const view=(state,job)=>({success:true,contractVersion:LOCAL_UPLOAD_PROTOCOL,
    idempotencyKey:state.idempotencyKey,projectId:state.projectId,sessionId:state.sessionId,
    file:{name:state.file.name,sizeBytes:state.file.sizeBytes,checksum:state.file.checksum},
    fileHost:{os:platform(),machine:hostname(),location:'bridge_host'},
    status:job?'transferring':['creating','transferring','completing','cancelling'].includes(state.phase)?'observation_required':state.phase,
    phase:state.phase,transport:{activeInThisBridge:!!job},uploadId:state.uploadId??null,assetId:state.assetId??null,
    progress:{uploadedBytes:state.parts.reduce((sum,p)=>sum+p.sizeBytes,0)+(job?.progress??0),totalBytes:state.file.sizeBytes},
    ...(state.jobId?{jobId:state.jobId}:{}),...(state.errorCode?{errorCode:state.errorCode}:{}),
    ...(state.result?{result:state.result}:{}),
    automaticReplayAllowed:false,
    next:job?'Read status using this same key.':state.phase==='ready'?'Use this asset in the same Studio project.':
      state.phase==='derivatives_pending'?'Read status for the original asset validation and derivatives.':
      'Observe status or explicitly resume/cancel this same key. Do not create a replacement upload.'});
  async function rpc(send,transfer,options){
    const response=await send(transfer,options);
    const result=response?.result??response;
    if(result?.isError){
      let body;try{body=JSON.parse(result.content?.find(block=>block.type==='text')?.text);}catch{}
      if(typeof body?.errorCode==='string'&&/^creation\.[a-z0-9_.:-]{1,180}$/.test(body.errorCode))throw new CreationClientError(body.errorCode);
      fail('control_unconfirmed');
    }
    let body;
    try{body=result.structuredContent??JSON.parse(result.content?.find(block=>block.type==='text')?.text);}catch{fail('control_unconfirmed');}
    if(!body||body.success!==true)fail('control_unconfirmed');
    return body;
  }
  async function observe(state,send,persist){
    if(!state.uploadId)return{state,session:undefined};
    const session=sessionCheck((await rpc(send,{action:'inspect',uploadId:state.uploadId})).session,state);
    state.expiresAt=session.expiresAt;state.lastObservedUploadState=session.state;
    if(session.state==='uploaded_unverified'){state.phase='completion_unconfirmed';state.errorCode='creation.local_upload.completion_requires_resume';}
    if(['aborted','expired','rejected'].includes(session.state)){state.phase=session.state;delete state.errorCode;}
    else if(session.state==='finalized'){
      state.jobId??=`direct-upload:${state.uploadId}`;
      const response=await send({action:'derivation',jobId:state.jobId});
      const result=response?.result??response;
      let body;try{body=result.structuredContent??JSON.parse(result.content?.find(block=>block.type==='text')?.text);}catch{fail('control_unconfirmed');}
      if(result.isError)fail('control_unconfirmed');
      if(body?.success===true&&body.uploadId===state.uploadId&&body.assetId===state.assetId){
        state.phase=body.status==='ready'?'ready':body.status==='failed'?'derivation_failed':'derivatives_pending';
        state.result={success:true,status:body.status,uploadId:state.uploadId,assetId:state.assetId,jobId:state.jobId};
        delete state.errorCode;
      }else if(body?.errorCode==='media_derivation.job_not_found'){
        state.phase='completion_unconfirmed';state.errorCode='creation.local_upload.completion_unconfirmed';
      }else fail('session_identity_unconfirmed');
    }
    if(persist)await persist();return{state,session};
  }
  function assertOriginalDeadline(state){
    if(!Number.isFinite(state.deadlineAtMs)||!Number.isFinite(Date.parse(state.expiresAt))
      ||Math.min(state.deadlineAtMs,Date.parse(state.expiresAt))<=now())fail('transfer_deadline_expired');
  }
  async function completeOriginal(state,session,send,binding,signal,save){
    await binding.assertCurrent();signal?.throwIfAborted();assertOriginalDeadline(state);
    const parts=receiptsForSession(session,state.parts,state);
    if(parts.size!==session.partCount||state.completeKey!=='complete-'+state.key)fail('original_completion_receipts_required');
    state.phase='completing';await save();
    const timeout=Math.max(1,Math.min(30000,state.deadlineAtMs-now(),Date.parse(state.expiresAt)-now()));
    const boundedSignal=AbortSignal.any([AbortSignal.timeout(timeout),...(signal?[signal]:[])]);
    const completed=await rpc(send,{action:'complete',request:{contractVersion:wire,uploadId:state.uploadId,
      idempotencyKey:state.completeKey,parts:state.parts}},{signal:boundedSignal,timeout});
    assertOriginalDeadline(state);
    sessionCheck(completed.session,state);
    if(completed.session.state!=='finalized'||completed.jobId!==`direct-upload:${state.uploadId}`)fail('completion_unconfirmed');
    state.jobId=completed.jobId;state.phase='derivatives_pending';delete state.errorCode;await save();
  }
  async function transfer(job,authorization,send,binding){
    const {state,file,abort,save}=job;
    const fileBudget=authorization?.transferBudget?.file?.totalMs??600_000;
    if(!Number.isSafeInteger(fileBudget)||fileBudget<1||fileBudget>1_800_000)fail('transfer_budget_invalid');
    state.deadlineAtMs=Math.min(state.deadlineAtMs,(state.startedAtMs??now())+fileBudget,Date.parse(state.expiresAt));await save();
    if(state.deadlineAtMs<=now())fail('transfer_deadline_expired');
    let envelope=authorization;
    while(true){
      await binding.assertCurrent();abort.signal.throwIfAborted();await file.assertUnchanged();
      const session=sessionCheck(envelope.session,state);
      if(session.state==='finalized')break;
      if(!['authorized','uploading'].includes(session.state))fail('session_not_transferable');
      const parts=partReceipts(envelope,state);
      state.parts=[...parts.values()].sort((a,b)=>a.partNumber-b.partNumber);await save();
      if(parts.size===session.partCount)break;
      if(!envelope.grants.length)fail('authorization_invalid');
      for(const grant of envelope.grants){
        if(parts.has(grant.partNumber))fail('authorization_invalid');
        await binding.assertCurrent();abort.signal.throwIfAborted();
        // Persist the attempted part before PUT. An uncertain result is never
        // automatically sent twice; an explicit resume re-observes the store.
        state.phase='transferring';state.pendingPart=grant.partNumber;await save();
        const part=await uploadGrantedPart(file,envelope,grant,{expectedUploadId:state.uploadId,expectedAssetId:state.assetId,
          signal:abort.signal,deadlineAtMs:state.deadlineAtMs,fetch,now,onProgress:progress=>{job.progress=progress.bytesRead;}});
        state.parts.push(part);state.parts.sort((a,b)=>a.partNumber-b.partNumber);job.progress=0;delete state.pendingPart;await save();
      }
      await binding.assertCurrent();abort.signal.throwIfAborted();
      envelope=(await rpc(send,{action:'resume',uploadId:state.uploadId})).authorization;
    }
    await binding.assertCurrent();abort.signal.throwIfAborted();await file.assertUnchanged();
    await completeOriginal(state,envelope.session,send,binding,abort.signal,save);
  }
  async function callCore({input,scope,send,binding,signal}){
    if(closing)fail('bridge_closing');
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>
      !['projectId','sessionId','action','idempotencyKey','filePath','assetKind','mimeType'].includes(key))
      ||!['upload','resume','status','cancel'].includes(input.action)||typeof input.idempotencyKey!=='string'
      ||input.idempotencyKey.length<8||input.idempotencyKey.length>200)fail('request_invalid');
    if(!scope||Object.values(scope).some(value=>typeof value!=='string'||!value)||!binding?.assertCurrent)fail('scope_unverified');
    await binding.assertCurrent();
    const key=digest([LOCAL_UPLOAD_PROTOCOL,scope,input.idempotencyKey]),persistence=await store();
    let job=jobs.get(key),state=job?.state??await persistence.read(key);
    if(state&&(state.contractVersion!==LOCAL_UPLOAD_PROTOCOL||state.key!==key||state.projectId!==input.projectId
      ||state.sessionId!==input.sessionId||!Array.isArray(state.parts)))fail('recovery_state_unavailable');
    if(job&&input.action==='status')return view(state,job);
    if(job&&input.action==='cancel'){job.abort.abort();await job.done;job=undefined;state=await persistence.read(key);}
    if(job) return view(state,job);
    if(!state&&input.action!=='upload')fail('original_upload_not_found');
    if(input.action==='status'){
      // A live transport in another bridge retains its exclusive local state.
      // Status remains a pure platform observation and never overwrites it.
      const copy=structuredClone(state);await observe(copy,send);return view(copy);
    }
    if(jobs.size>=2&&!['status','cancel'].includes(input.action))fail('bridge_transfer_limit');
    await persistence.cleanup({admitNew:!state});const release=await persistence.lock(key);
    let file;
    try{
      state=await persistence.read(key)??state;
      if(input.action==='cancel'){
        if(['ready','derivatives_pending','derivation_failed'].includes(state.phase))
          return view((await observe(state,send,()=>persistence.write(key,state))).state);
        if(!state.uploadId)fail('create_unconfirmed_observe_original_key');
        state.phase='cancelling';await persistence.write(key,state);
        const result=await rpc(send,{action:'abort',request:{contractVersion:wire,uploadId:state.uploadId,
          idempotencyKey:state.abortKey,reasonCode:'user_cancelled'}});
        sessionCheck(result.session,state);state.phase=result.session.state;delete state.errorCode;
        await persistence.write(key,state);return view(state);
      }
      if(state&&terminal.has(state.phase))return view((await observe(state,send,()=>persistence.write(key,state))).state);
      if(state?.uploadId){
        const observed=await observe(state,send,()=>persistence.write(key,state));
        if(terminal.has(state.phase)||state.phase==='derivatives_pending'||state.phase==='derivation_failed')return view(state);
        if(['uploaded_unverified','finalized'].includes(observed.session.state)){
          // Explicit recovery reuses the original complete request. A read
          // never enqueues, and a completed multipart is never resumed or PUT.
          assertOriginalDeadline(state);
          if(input.filePath!==undefined){
            if(typeof input.filePath!=='string'||input.filePath.length>4096)fail('file_selection_required');
            file=await openLocalUploadFile(input.filePath,{signal,deadlineAtMs:state.deadlineAtMs,now});
            if(JSON.stringify(state.file.fingerprint)!==JSON.stringify(file.fingerprint)||state.file.name!==file.name)fail('file_changed');
          }
          if(input.assetKind!==undefined&&input.assetKind!==state.request.assetKind
            ||input.mimeType!==undefined&&input.mimeType!==state.request.mimeType)fail('file_changed');
          await completeOriginal(state,observed.session,send,binding,signal,()=>persistence.write(key,state));
          return view(state);
        }
      }
      if(typeof input.filePath!=='string'||input.filePath.length>4096)fail('file_selection_required');
      const startedAtMs=state?.startedAtMs??now(),deadlineAtMs=state?.deadlineAtMs??startedAtMs+600_000;
      file=await openLocalUploadFile(input.filePath,{signal,deadlineAtMs,now});
      const inferred=typeByExtension[path.extname(file.name).toLowerCase()]??[];
      const assetKind=input.assetKind??inferred[0],mimeType=input.mimeType??inferred[1];
      if(!['image','audio','video','document'].includes(assetKind)||typeof mimeType!=='string'
        ||!/^\S+\/\S+$/.test(mimeType)||mimeType.length>255)fail('file_type_required');
      if(state&&(JSON.stringify(state.file.fingerprint)!==JSON.stringify(file.fingerprint)
        ||state.file.name!==file.name||state.request.assetKind!==assetKind||state.request.mimeType!==mimeType))fail('file_changed');
      if(!state){
        state={contractVersion:LOCAL_UPLOAD_PROTOCOL,key,projectId:input.projectId,sessionId:input.sessionId,
          idempotencyKey:input.idempotencyKey,startedAtMs,deadlineAtMs,completeKey:'complete-'+key,abortKey:'abort-'+key,
          file:{name:file.name,sizeBytes:file.sizeBytes,checksum:file.checksum,fingerprint:file.fingerprint},
          request:{contractVersion:wire,originalName:file.name,purpose:'project-asset',assetKind,mimeType,
            sizeBytes:file.sizeBytes,expectedChecksum:file.checksum,idempotencyKey:'create-'+key},
          phase:'creating',parts:[],expiresAt:new Date(now()+30*60*1000).toISOString()};
        await persistence.write(key,state);
      }
      await binding.assertCurrent();let authorization;
      if(!state.uploadId){
        const created=await rpc(send,{action:'create',request:state.request});authorization=created.authorization;
        const session=authorization?.session;
        if(!session||typeof session.uploadId!=='string'||typeof session.assetId!=='string')fail('authorization_invalid');
        state.uploadId=session.uploadId;state.assetId=session.assetId;sessionCheck(session,state);
        state.expiresAt=session.expiresAt;await persistence.write(key,state);
      }else{
        authorization=(await rpc(send,{action:'resume',uploadId:state.uploadId})).authorization;
      }
      signal?.throwIfAborted();
      const abort=new AbortController();job={state,file,abort,progress:0,save:()=>persistence.write(key,state)};
      jobs.set(key,job);file=undefined;
      // The accepted ID is returned before multipart work. Closing this bridge
      // cancels and joins only this transport; the platform keeps its session.
      job.done=Promise.resolve().then(()=>transfer(job,authorization,(transfer,options)=>send(transfer,{signal:abort.signal,...options}),binding)).catch(async error=>{
        state.phase='paused';state.errorCode=abort.signal.aborted?'creation.local_upload.transfer_cancelled':knownError(error);
        await job.save();
      }).finally(async()=>{try{await job.file.close();}finally{try{await release();}finally{jobs.delete(key);}}});
      job.done.catch(()=>{});return view(state,job);
    }catch(error){if(state){state.phase='paused';state.errorCode=knownError(error);await persistence.write(key,state);}throw error;}
    finally{if(!jobs.has(key)){await file?.close();await release();}}
  }
  return{call(options){
    if(closing)fail('bridge_closing');
    const controller=new AbortController(),abort=()=>controller.abort();
    if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});
    callControllers.add(controller);
    const send=(transfer,extra={})=>options.send(transfer,{signal:controller.signal,...extra});
    const pending=callCore({...options,send,signal:controller.signal}).finally(()=>{
      activeCalls.delete(pending);callControllers.delete(controller);options.signal?.removeEventListener('abort',abort);
    });activeCalls.add(pending);return pending;
  },close(){return closePromise??=(async()=>{
    closing=true;for(const controller of callControllers)controller.abort();
    for(const job of jobs.values())job.abort.abort();
    await Promise.allSettled([...activeCalls]);
    for(const job of jobs.values())job.abort.abort();
    await Promise.allSettled([...jobs.values()].map(job=>job.done));
  })();}};
}
