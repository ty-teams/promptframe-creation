import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {CreationClientError} from './credentials.mjs';
import {LOCAL_UPLOAD_READ_BYTES} from './local-upload-file.mjs';

const fail=code=>{throw new CreationClientError('creation.local_upload.'+code);};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const forbiddenHeader=/^(?:authorization|cookie|host|connection|upgrade|proxy-.*)$/i;
const defaultBudget={totalMs:300_000,firstProgressMs:30_000,idleMs:60_000};

/** Consume an authenticated platform grant, never a model-supplied destination.
 * A successful PUT is a part receipt; asset readiness belongs to the platform. */
export async function uploadGrantedPart(file,authorization,grant,{
  expectedUploadId,expectedAssetId,signal,deadlineAtMs=Infinity,
  fetch:fetchPart=globalThis.fetch,now=Date.now,onProgress=()=>{},
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
  await file.assertUnchanged();
  if(signal?.aborted)fail('transfer_cancelled');
  const controller=new AbortController();let reason,firstTimer,idleTimer,totalTimer,bytesRead=0;
  const abort=code=>{reason??=code;controller.abort();};
  const cancel=()=>abort('transfer_cancelled');
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const timer=(callback,ms)=>{const id=setTimeout(callback,ms);id.unref?.();return id;};
  firstTimer=timer(()=>abort('transfer_first_progress_timeout'),budget.firstProgressMs);
  totalTimer=timer(()=>abort('transfer_timeout'),Math.max(1,deadline-now()));
  let input,body,bodyDone,inputDone,response;
  async function* chunks(){
    for await(const chunk of input){
      if(controller.signal.aborted)fail(reason??'transfer_cancelled');
      clearTimeout(firstTimer);clearTimeout(idleTimer);
      idleTimer=timer(()=>abort('transfer_idle_timeout'),budget.idleMs);
      bytesRead+=chunk.length;onProgress({partNumber:grant.partNumber,bytesRead,sizeBytes});
      yield chunk;
    }
  }
  try{
    input=file.streamPart({start,sizeBytes,signal:controller.signal});
    body=Readable.from(chunks(),{objectMode:false,highWaterMark:LOCAL_UPLOAD_READ_BYTES});
    bodyDone=finished(body);bodyDone.catch(()=>{});
    inputDone=finished(input);inputDone.catch(()=>{});
    response=await fetchPart(destination,{method:'PUT',headers,body,duplex:'half',redirect:'error',signal:controller.signal});
    if(!response.ok)fail('part_target_rejected');
    await bodyDone;await inputDone;
    if(bytesRead!==sizeBytes)fail('part_transfer_unconfirmed');
    await file.assertUnchanged();
    const etag=response.headers.get('etag');
    if(!etag||etag.length>512||/[\x00-\x1f\x7f]/.test(etag))fail('part_receipt_unconfirmed');
    return {partNumber:grant.partNumber,etag,sizeBytes};
  }catch(error){
    if(reason)fail(reason);
    if(error instanceof CreationClientError)throw error;
    // Fetch errors can include the signed URL. Keep only a safe classification.
    fail('part_transfer_unconfirmed');
  }finally{
    controller.abort();clearTimeout(firstTimer);clearTimeout(idleTimer);clearTimeout(totalTimer);
    signal?.removeEventListener('abort',cancel);
    body?.destroy();input?.destroy();
    await Promise.allSettled([bodyDone,inputDone]);
    await response?.body?.cancel().catch(()=>{});
  }
}
