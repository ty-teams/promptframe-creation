import {readFile,readlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounded=async file=>{const value=await readFile(file);if(value.length>65536)throw Error('host_process_invalid');return value;};
export async function processBirth(pid){
 const data=(await bounded(`/proc/${pid}/stat`)).toString(),end=data.lastIndexOf(')'),fields=data.slice(end+2).split(' ');
 if(end<0||fields.length<20||!/^\d+$/.test(fields[19]))throw Error('host_process_invalid');
 const info=await stat(`/proc/${pid}`),exe=await stat(`/proc/${pid}/exe`),name=await readlink(`/proc/${pid}/exe`);
 return{pid,ppid:Number(fields[1]),birth:fields[19],uid:info.uid,device:exe.dev,inode:exe.ino,exe:name};
}
/** Find the actual native CLI ancestor, including shell/relay intermediaries.
 * A process name or a bare parent PID never establishes this association. */
export async function claudeHostProcess({pid=process.pid,env=process.env,home=homedir(),readBirth=processBirth,
 readExecutable=stat,readBoot=async()=>(await bounded('/proc/sys/kernel/random/boot_id')).toString().trim(),purpose='bridge',
 entryFile=process.argv[1],readCommand=async pid=>(await bounded(`/proc/${pid}/cmdline`)).toString().split('\0')}={}){
 if(process.platform!=='linux'||env.CLAUDECODE!=='1')return null;
 try{
  const uid=process.getuid(),boot=await readBoot();
  let child=await readBirth(pid),visited=new Set();
  for(let depth=0;depth<32&&child.ppid>1;depth++){
   if(visited.has(child.ppid))return null;visited.add(child.ppid);
   const host=await readBirth(child.ppid);
   const roots=[path.join(home,'.claude','remote','ccd-cli'),path.join(home,'.local','share','claude','versions')];
   if(roots.some(root=>path.dirname(host.exe)===root)){
    const executable=await readExecutable(host.exe);
    if(host.uid!==uid||![uid,0].includes(executable.uid)||!executable.isFile()||(executable.mode&0o022)
     ||host.inode!==executable.ino||host.device!==executable.dev)return null;
    if(purpose==='hook'){
     const command=await readCommand(child.pid);
     if(!entryFile||!command.some(arg=>arg.includes(entryFile))
      ||!command.some(arg=>arg==='claude-host-hook'||arg.includes(' claude-host-hook')))return null;
    }
    const binding={pid:host.pid,birth:host.birth,uid,device:host.device,inode:host.inode,exe:host.exe,boot};
    const digest=hash(binding);
    return{binding,digest,eventOrder:{birth:child.birth,pid:child.pid},async isCurrent(){
     try{const current=await readBirth(binding.pid);return current.birth===binding.birth&&current.uid===uid
      &&current.device===binding.device&&current.inode===binding.inode&&current.exe===binding.exe
      &&await readBoot()===boot;}catch{return false;}
    }};
   }
   child=host;
  }
 }catch{}
 return null;
}
