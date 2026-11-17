import {open,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';

/** Only the explicitly selected private file is read. Its contents are sent as
 * transient transport data, never returned to the model or written to history. */
export async function readDevelopmentPairingFile(filePath,{signal}={}){
  const fail=()=>{throw new CreationClientError('creation.development_pairing.private_file_unavailable');};
  if(typeof filePath!=='string'||filePath.length>4096||!path.isAbsolute(filePath))fail();
  let file;
  try{
    signal?.throwIfAborted();
    file=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await file.stat();
    if(!before.isFile()||before.size<2||before.size>8192||process.platform!=='win32'
      &&((before.mode&0o077)!==0||before.uid!==process.getuid()))fail();
    const bytes=Buffer.alloc(before.size);let offset=0;
    while(offset<bytes.length){signal?.throwIfAborted();const read=await file.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)fail();offset+=read.bytesRead;}
    const after=await file.stat(),named=await stat(filePath);signal?.throwIfAborted();
    if([after,named].some(value=>value.dev!==before.dev||value.ino!==before.ino||value.size!==before.size||value.mtimeMs!==before.mtimeMs||value.ctimeMs!==before.ctimeMs))fail();
    const value=JSON.parse(bytes.toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))fail();
    // Existing CLI dev output also carries public command/playerLoaded fields.
    // They describe the terminal, not the private pairing transport.
    return Object.fromEntries(['url','connectionId','credential','studioOrigin','expiresAt','contractVersion','lifecycle']
      .filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
  }catch{fail();}finally{await file?.close();}
}
