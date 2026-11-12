import {constants} from 'node:fs';
import {open,mkdir,lstat,rename,unlink,rmdir,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {CreationClientError} from './credentials.mjs';

const fail=()=>{throw new CreationClientError('creation.local_upload.recovery_state_unavailable');};
const flags=constants.O_NOFOLLOW;
const maxBytes=1024*1024,maxRecords=100,retentionMs=24*60*60*1000;
async function directory(root){
  try{await mkdir(root,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const info=await lstat(root);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)||process.getuid&&info.uid!==process.getuid())fail();
}
async function read(file){
  let fd;
  try{
    fd=await open(file,constants.O_RDONLY|flags);const info=await fd.stat();
    if(!info.isFile()||(info.mode&0o077)||info.size>maxBytes||process.getuid&&info.uid!==process.getuid())fail();
    return JSON.parse(await fd.readFile('utf8'));
  }catch(e){if(e.code==='ENOENT')return null;fail();}finally{await fd?.close();}
}
async function syncDirectory(root){
  // Windows does not expose POSIX directory fsync. File sync still precedes
  // rename; an uncertain crash record is observed through the original key.
  if(process.platform==='win32')return;
  const fd=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|flags);
  try{await fd.sync();}finally{await fd.close();}
}
async function birth(pid){
  if(process.platform!=='linux')return null;
  try{
    const stat=await readFile(`/proc/${pid}/stat`,'utf8'),end=stat.lastIndexOf(')');
    return{boot:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),start:stat.slice(end+2).split(' ')[19]};
  }catch(e){if(e.code==='ENOENT')return false;fail();}
}

/** Private transport recovery only. The platform upload session remains the
 * business authority. No credentials, paths or signed grants are stored. */
export async function localUploadState(root,{now=Date.now}={}){
  try{await directory(root);}catch{fail();}
  const ownBirth=await birth(process.pid),owner={pid:process.pid,birth:ownBirth,nonce:randomBytes(16).toString('hex')};
  const file=key=>{if(!/^[a-f0-9]{64}$/.test(key))fail();return path.join(root,key+'.json');};
  async function write(key,value){
    const body=JSON.stringify(value);if(Buffer.byteLength(body)>maxBytes)fail();
    const destination=file(key),temporary=path.join(root,key+'-'+randomBytes(12).toString('hex')+'.partial');
    let fd;
    try{fd=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|flags,0o600);
      await fd.writeFile(body);await fd.sync();await fd.close();fd=undefined;
      const current=await lstat(destination).catch(e=>{if(e.code!=='ENOENT')throw e;});
      if(current&&(!current.isFile()||current.isSymbolicLink()||(current.mode&0o077)))fail();
      await rename(temporary,destination);await syncDirectory(root);
    }catch{fail();}finally{await fd?.close();await unlink(temporary).catch(()=>{});}
  }
  async function lock(key){
    const target=path.join(root,key+'.lock');file(key);
    const reclaiming=async()=> (await readdir(root)).some(name=>name.startsWith(key+'.reclaim-'));
    for(let attempt=0;attempt<2;attempt++){
      if(await reclaiming())throw new CreationClientError('creation.local_upload.transfer_owned_by_another_bridge');
      const staging=path.join(root,key+'-'+randomBytes(12).toString('hex')+'.claim');
      await mkdir(staging,{mode:0o700});
      const prepared=await open(path.join(staging,'owner.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|flags,0o600);
      try{await prepared.writeFile(JSON.stringify(owner));await prepared.sync();}finally{await prepared.close();}
      await syncDirectory(staging);
      try{await rename(staging,target);}

      catch(e){
        await unlink(path.join(staging,'owner.json'));await rmdir(staging);
        if(!['EEXIST','ENOTEMPTY'].includes(e.code))fail();
        const info=await lstat(target);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077))fail();
        const old=await read(path.join(target,'owner.json'));
        if(!old||!Number.isSafeInteger(old.pid)||old.pid<1||!old.birth||process.platform!=='linux')
          throw new CreationClientError('creation.local_upload.transfer_owned_by_another_bridge');
        const current=await birth(old.pid);
        if(current&&current.boot===old.birth.boot&&current.start===old.birth.start)
          throw new CreationClientError('creation.local_upload.transfer_owned_by_another_bridge');
        // Serialize retirement of this exact dead birth. Contenders check the
        // marker again after acquiring, before any state or transport effect.
        if(!/^[a-f0-9]{32}$/.test(old.nonce))fail();
        const marker=path.join(root,key+'.reclaim-'+old.nonce);
        try{await mkdir(marker,{mode:0o700});}catch{throw new CreationClientError('creation.local_upload.transfer_owned_by_another_bridge');}
        try{
          const again=await read(path.join(target,'owner.json'));
          if(JSON.stringify(again)!==JSON.stringify(old))fail();
          await unlink(path.join(target,'owner.json'));await rmdir(target);await syncDirectory(root);
        }finally{await rmdir(marker);await syncDirectory(root);}
        continue;
      }
      if(await reclaiming()){
        const current=await read(path.join(target,'owner.json'));if(current?.nonce!==owner.nonce)fail();
        await unlink(path.join(target,'owner.json'));await rmdir(target);
        throw new CreationClientError('creation.local_upload.transfer_owned_by_another_bridge');
      }
      await syncDirectory(root);
      return async()=>{
        const current=await read(path.join(target,'owner.json'));
        if(current?.nonce!==owner.nonce)fail();
        await unlink(path.join(target,'owner.json'));await rmdir(target);await syncDirectory(root);
      };
    }
    fail();
  }
  async function cleanup({admitNew=false}={}){
    const names=await readdir(root);let records=0;
    for(const name of names){
      if(/^[a-f0-9]{64}\.json$/.test(name)){
        const key=name.slice(0,-5),value=await read(file(key));records++;
        const cutoff=Date.parse(value?.expiresAt??'')+retentionMs;
        if(!Number.isFinite(cutoff)||now()<cutoff)continue;
        let release;
        try{release=await lock(key);}catch(e){if(e instanceof CreationClientError)continue;throw e;}
        try{const latest=await read(file(key));if(JSON.stringify(latest)===JSON.stringify(value)){await unlink(file(key));records--;}}
        finally{await release();}
      }else if(/^[a-f0-9]{64}-[a-f0-9]{24}\.claim$/.test(name)){
        const target=path.join(root,name),info=await lstat(target);
        if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)||now()-info.mtimeMs<=retentionMs)continue;
        const old=await read(path.join(target,'owner.json'));
        if(!old||process.platform!=='linux')continue;
        const current=await birth(old.pid);
        if(current&&current.boot===old.birth?.boot&&current.start===old.birth?.start)continue;
        if(JSON.stringify(await read(path.join(target,'owner.json')))!==JSON.stringify(old))continue;
        await unlink(path.join(target,'owner.json'));await rmdir(target);
      }else if(/^[a-f0-9]{64}-[a-f0-9]{24}\.partial$/.test(name)){
        const info=await lstat(path.join(root,name));
        if(info.isFile()&&!info.isSymbolicLink()&&(!process.getuid||info.uid===process.getuid())
          &&!(info.mode&0o077)&&now()-info.mtimeMs>retentionMs){
          let release;try{release=await lock(name.slice(0,64));}catch{continue;}
          try{await unlink(path.join(root,name));}finally{await release();}
        }
      }
    }
    await syncDirectory(root);
    if(admitNew&&records>=maxRecords)throw new CreationClientError('creation.local_upload.local_recovery_limit');
  }
  return{read:async key=>read(file(key)),write,lock,cleanup};
}
