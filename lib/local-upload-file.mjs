import {constants} from 'node:fs';
import {open,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {CreationClientError} from './credentials.mjs';

export const LOCAL_UPLOAD_MAX_BYTES=2*1024**3;
export const LOCAL_UPLOAD_READ_BYTES=64*1024;
const fingerprint=stat=>({dev:String(stat.dev),ino:String(stat.ino),sizeBytes:Number(stat.size),
  mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)});
const equal=(left,right)=>Object.keys(left).every(key=>left[key]===right[key]);
const failure=code=>new CreationClientError('creation.local_upload.'+code);

/** Open only the selected file. Retain the same descriptor through hashing and
 * transport; the platform still owns the upload, checksum and asset decision. */
export async function openLocalUploadFile(selectedPath,{maxBytes=LOCAL_UPLOAD_MAX_BYTES,signal,deadlineAtMs=Infinity,now=Date.now}={}){
  if(typeof selectedPath!=='string'||!selectedPath||selectedPath.includes('\0')
    ||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LOCAL_UPLOAD_MAX_BYTES)
    throw failure('file_selection_invalid');
  if(process.platform!=='win32'&&/^(?:[a-z]:[\\/]|\\\\)/i.test(selectedPath))
    throw failure('path_not_on_bridge_host');
  const selected=path.resolve(selectedPath),name=path.basename(selected);
  if(name.length>512||/[\x00-\x1f\x7f]/.test(name))throw failure('file_selection_invalid');
  let handle;
  try{handle=await open(selected,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){throw failure(error.code==='ELOOP'?'file_not_regular'
    :error.code==='EACCES'||error.code==='EPERM'?'file_read_denied':'file_not_on_bridge_host');}
  const abort=new AbortController(),streams=new Map(),reads=new Set();
  let closing=false,closed=false,original,closePromise;
  const checkSignal=other=>{
    if(closing||closed)throw failure('file_closed');
    if(signal?.aborted||other?.aborted||abort.signal.aborted)throw failure('file_read_cancelled');
    if(now()>=deadlineAtMs)throw failure('file_read_timeout');
  };
  const read=async(buffer,offset,length,position)=>{
    const pending=handle.read(buffer,offset,length,position);reads.add(pending);
    try{return await pending;}catch{throw failure('file_read_failed');}finally{reads.delete(pending);}
  };
  const assertUnchanged=async()=>{
    checkSignal();
    try{
      const [current,named]=await Promise.all([handle.stat({bigint:true}),lstat(selected,{bigint:true})]);
      if(!current.isFile()||!named.isFile()||!equal(original,fingerprint(current))
        ||!equal(original,fingerprint(named)))throw failure('file_changed');
    }catch(error){if(error instanceof CreationClientError)throw error;throw failure('file_changed');}
  };
  const close=()=>closePromise??=(async()=>{
    closing=true;abort.abort();
    for(const stream of streams.keys())stream.destroy(failure('file_read_cancelled'));
    await Promise.allSettled([...streams.values(),...reads]);
    await handle.close();closed=true;
  })();
  try{
    checkSignal();const stat=await handle.stat({bigint:true});
    if(!stat.isFile())throw failure('file_not_regular');
    if(stat.size<=0n||stat.size>BigInt(maxBytes))throw failure('file_size_limit');
    original=fingerprint(stat);await assertUnchanged();
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(LOCAL_UPLOAD_READ_BYTES);
    for(let position=0;position<original.sizeBytes;){
      checkSignal();const length=Math.min(buffer.length,original.sizeBytes-position);
      const {bytesRead}=await read(buffer,0,length,position);
      if(bytesRead===0)throw failure('file_changed');
      hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;
    }
    await assertUnchanged();const checksum='sha256:'+hash.digest('hex');
    return {
      name,sizeBytes:original.sizeBytes,checksum,fingerprint:{...original,checksum},
      assertUnchanged,close,
      streamPart({start,sizeBytes,signal:partSignal}={}){
        checkSignal(partSignal);
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(sizeBytes)||start<0||sizeBytes<1
          ||start+sizeBytes>original.sizeBytes)throw failure('part_range_invalid');
        async function* chunks(){
          await assertUnchanged();let position=start;
          while(position<start+sizeBytes){
            checkSignal(partSignal);const bytes=Buffer.allocUnsafe(Math.min(LOCAL_UPLOAD_READ_BYTES,start+sizeBytes-position));
            const result=await read(bytes,0,bytes.length,position);
            checkSignal(partSignal);if(result.bytesRead===0)throw failure('file_changed');
            position+=result.bytesRead;yield bytes.subarray(0,result.bytesRead);
          }
          await assertUnchanged();
        }
        const stream=Readable.from(chunks(),{objectMode:false,highWaterMark:LOCAL_UPLOAD_READ_BYTES});
        const done=finished(stream).finally(()=>streams.delete(stream));
        // A caller may cancel before it starts consuming the body.
        done.catch(()=>{});streams.set(stream,done);return stream;
      },
    };
  }catch(error){await close();if(error instanceof CreationClientError)throw error;throw failure('file_read_failed');}
}
