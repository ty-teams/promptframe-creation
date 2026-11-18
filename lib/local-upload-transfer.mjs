import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {performance} from 'node:perf_hooks';
import {CreationClientError} from './credentials.mjs';
import {LOCAL_UPLOAD_READ_BYTES} from './local-upload-file.mjs';

const fail=code=>{throw new CreationClientError('creation.local_upload.'+code);};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const forbiddenHeader=/^(?:authorization|cookie|host|connection|upgrade|proxy-.*)$/i;
const defaultBudget={totalMs:300_000,firstProgressMs:30_000,idleMs:60_000};
const stages=new Set(['validating','checking_file','opening_stream','streaming','awaiting_response','finishing_stream','reading_receipt']);
const causes=new Set(['local_read_failed','local_file_changed','local_read_cancelled','dns_failure','connection_refused',
  'connection_interrupted','network_timeout','tls_rejected','transport_unconfirmed','http_rejected','byte_count_mismatch',
  'etag_missing','cancelled','first_progress_timeout','idle_timeout','deadline_elapsed','validation_refused','stream_unconfirmed']);
const localCause=error=>error instanceof CreationClientError?({
  'creation.local_upload.file_read_failed':'local_read_failed','creation.local_upload.file_changed':'local_file_changed',
  'creation.local_upload.file_read_cancelled':'local_read_cancelled',
})[error.message]:undefined;
const networkCause=error=>{
  const code=typeof error?.cause?.code==='string'?error.cause.code:error?.code;
  if(['ENOTFOUND','EAI_AGAIN'].includes(code))return 'dns_failure';
  if(code==='ECONNREFUSED')return 'connection_refused';
  if(['ECONNRESET','EPIPE','UND_ERR_SOCKET'].includes(code))return 'connection_interrupted';
  if(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code))return 'network_timeout';
  if(['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code))return 'tls_rejected';
  return 'transport_unconfirmed';
};
/** Copy only measured, bounded fields. Never serialize the original Error,
 * target URL, arbitrary cause/message/stack, headers or signed grant. */
export function safePartTransferDiagnostic(value){
  if(!value||!stages.has(value.stage)||!causes.has(value.causeCode))return;
  const result={stage:value.stage,causeCode:value.causeCode};
  for(const key of ['requestId','uploadId','assetId'])if(typeof value[key]==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value[key]))result[key]=value[key];
  for(const key of ['partNumber','expectedBytes','bytesRead','elapsedMs'])if(Number.isSafeInteger(value[key])&&value[key]>=0)result[key]=value[key];
  if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)result.httpStatus=value.httpStatus;
  return Object.freeze(result);
}

/** Consume an authenticated platform grant, never a model-supplied destination.
 * A successful PUT is a part receipt; asset readiness belongs to the platform. */
async function transferGrantedPart(file,authorization,grant,{
  expectedUploadId,expectedAssetId,signal,deadlineAtMs=Infinity,
  fetch:fetchPart=globalThis.fetch,now=Date.now,onProgress=()=>{},
  onTransferState=()=>{},
}={}){
  const session=authorization?.session;
  if(authorization?.contractVersion!=='direct-object-upload.v2'
    ||!session||session.uploadId!==expectedUploadId||session.assetId!==expectedAssetId
    ||session.sizeBytes!==file.sizeBytes||session.expectedChecksum!==file.checksum
    ||!positive(session.partSizeBytes)||!positive(session.partCount)
    ||session.partCount!==Math.ceil(file.sizeBytes/session.partSizeBytes)
    ||!['authorized','uploading'].includes(session.state))fail('authorization_invalid');
  if(!grant||grant.method!=='PUT'||grant.uploadId!==expectedUploadId||grant.assetId!==expectedAssetId
    ||!positive(grant.partNumber)||grant.partNumber>session.partCount
    ||!Array.isArray(authorization.grants)
    ||authorization.grants.filter(item=>item===grant).length!==1)fail('grant_invalid');
  let destination;
  try{destination=new URL(grant.url);}catch{fail('grant_invalid');}
  if(!['https:','http:'].includes(destination.protocol)||destination.username||destination.password
    ||destination.hash||grant.url.length>16*1024)fail('grant_invalid');
  const expires=[Date.parse(grant.expiresAt),Date.parse(session.expiresAt)];
  if(expires.some(value=>!Number.isFinite(value)))fail('grant_invalid');
  if(expires.some(value=>value<=now()))fail('grant_expired');
  const budget=authorization.transferBudget?.part??defaultBudget;
  if(!positive(budget.totalMs)||budget.totalMs>300_000||!positive(budget.firstProgressMs)
    ||budget.firstProgressMs>120_000||!positive(budget.idleMs)||budget.idleMs>120_000)
    fail('transfer_budget_invalid');
  const start=(grant.partNumber-1)*session.partSizeBytes;
  const sizeBytes=Math.min(session.partSizeBytes,file.sizeBytes-start);
  const report=(stage,extra={})=>onTransferState({stage,uploadId:session.uploadId,assetId:session.assetId,
    partNumber:grant.partNumber,expectedBytes:sizeBytes,...extra});
  const headers=new Headers();
  if(!grant.requiredHeaders||typeof grant.requiredHeaders!=='object'||Array.isArray(grant.requiredHeaders)
    ||Object.keys(grant.requiredHeaders).length>64)fail('grant_invalid');
  for(const [name,value] of Object.entries(grant.requiredHeaders)){
    if(typeof value!=='string'||value.length>8192||forbiddenHeader.test(name))fail('grant_invalid');
    try{headers.set(name,value);}catch{fail('grant_invalid');}
  }
  if(headers.has('content-length')&&headers.get('content-length')!==String(sizeBytes))fail('grant_invalid');
  headers.set('content-length',String(sizeBytes));
  const deadline=Math.min(now()+budget.totalMs,...expires,deadlineAtMs);
  if(!Number.isFinite(deadline)||deadline<=now())fail('transfer_deadline_expired');
  report('checking_file',{bytesRead:0});
  try{await file.assertUnchanged();}catch(error){report('checking_file',{causeCode:localCause(error)??'local_read_failed'});throw error;}
  if(signal?.aborted)fail('transfer_cancelled');
  const controller=new AbortController();let reason,firstTimer,idleTimer,totalTimer,bytesRead=0;
  const abort=code=>{reason??=code;onTransferState({bytesRead,causeCode:({transfer_cancelled:'cancelled',transfer_first_progress_timeout:'first_progress_timeout',
    transfer_idle_timeout:'idle_timeout',transfer_timeout:'deadline_elapsed'})[reason]});controller.abort();};
  const cancel=()=>abort('transfer_cancelled');
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const timer=(callback,ms)=>{const id=setTimeout(callback,ms);id.unref?.();return id;};
  firstTimer=timer(()=>abort('transfer_first_progress_timeout'),budget.firstProgressMs);
  totalTimer=timer(()=>abort('transfer_timeout'),Math.max(1,deadline-now()));
  let input,body,bodyDone,inputDone,response,closing=false,streamFailure=false;
  async function* chunks(){
    try{for await(const chunk of input){
      if(controller.signal.aborted)fail(reason??'transfer_cancelled');
      clearTimeout(firstTimer);clearTimeout(idleTimer);
      idleTimer=timer(()=>abort('transfer_idle_timeout'),budget.idleMs);
      bytesRead+=chunk.length;report('streaming',{bytesRead});onProgress({partNumber:grant.partNumber,bytesRead,sizeBytes});
      yield chunk;
    }report('awaiting_response',{bytesRead});}catch(error){
      if(!reason&&!closing){streamFailure=true;report('streaming',{bytesRead,causeCode:localCause(error)
        ??(['EIO','EACCES','EPERM','ESTALE','EBADF'].includes(error?.code)?'local_read_failed':'stream_unconfirmed')});}
      throw error;
    }
  }
  try{
    report('opening_stream',{bytesRead});
    input=file.streamPart({start,sizeBytes,signal:controller.signal});
    body=Readable.from(chunks(),{objectMode:false,highWaterMark:LOCAL_UPLOAD_READ_BYTES});
    bodyDone=finished(body);bodyDone.catch(()=>{});
    inputDone=finished(input);inputDone.catch(()=>{});
    response=await fetchPart(destination,{method:'PUT',headers,body,duplex:'half',redirect:'error',signal:controller.signal});
    report('finishing_stream',{bytesRead,httpStatus:response.status});
    if(!response.ok){report('finishing_stream',{bytesRead,httpStatus:response.status,causeCode:'http_rejected'});fail('part_target_rejected');}
    await bodyDone;await inputDone;
    if(bytesRead!==sizeBytes){report('finishing_stream',{bytesRead,causeCode:'byte_count_mismatch'});fail('part_transfer_unconfirmed');}
    report('checking_file',{bytesRead});
    try{await file.assertUnchanged();}catch(error){report('checking_file',{bytesRead,causeCode:localCause(error)??'local_read_failed'});throw error;}
    report('reading_receipt',{bytesRead});
    const etag=response.headers.get('etag');
    if(!etag||etag.length>512||/[\x00-\x1f\x7f]/.test(etag)){report('reading_receipt',{bytesRead,causeCode:'etag_missing'});fail('part_receipt_unconfirmed');}
    return {partNumber:grant.partNumber,etag,sizeBytes};
  }catch(error){
    if(reason)fail(reason);
    if(error instanceof CreationClientError){if(localCause(error))onTransferState({causeCode:localCause(error)});throw error;}
    // Fetch errors can include the signed URL. Keep only a safe classification.
    if(!streamFailure)onTransferState({causeCode:networkCause(error)});
    fail('part_transfer_unconfirmed');
  }finally{
    closing=true;
    controller.abort();clearTimeout(firstTimer);clearTimeout(idleTimer);clearTimeout(totalTimer);
    signal?.removeEventListener('abort',cancel);
    body?.destroy();input?.destroy();
    await Promise.allSettled([bodyDone,inputDone]);
    await response?.body?.cancel().catch(()=>{});
  }
}

const effects=new WeakMap();
const diagnostics=new WeakMap();
export const readPartTransferEffect=error=>error&&typeof error==='object'?effects.get(error):undefined;
export const readPartTransferDiagnostic=error=>error&&typeof error==='object'?diagnostics.get(error):undefined;
export async function uploadGrantedPart(file,authorization,grant,options={}){
  let dispatched=false,state={stage:'validating',bytesRead:0};
  const monotonic=options.monotonicNow??(()=>performance.now()),started=monotonic();
  try{return await transferGrantedPart(file,authorization,grant,{...options,onTransferState:value=>{state={...state,...value};},fetch:async(...args)=>{
    dispatched=true;return(options.fetch??globalThis.fetch)(...args);
  }});}catch(error){
    if(error&&typeof error==='object')effects.set(error,dispatched?'unknown':'not_dispatched');
    if(error&&typeof error==='object')diagnostics.set(error,safePartTransferDiagnostic({...state,requestId:options.requestId,
      causeCode:state.causeCode??(!dispatched&&state.stage==='validating'?'validation_refused':networkCause(error)),
      elapsedMs:Math.max(0,Math.floor(monotonic()-started))}));
    throw error;
  }
}
