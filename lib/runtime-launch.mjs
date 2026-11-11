import {spawn} from 'node:child_process';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';

/** Relay a new session once, before this process has consumed host stdio.
 * After spawning, any failure belongs to that runtime; it never respawns or
 * falls back to another bridge which could replay an accepted business call. */
export async function launchSelectedBridge(selection,{host,configFile,spawnImpl=spawn,env=process.env}={}){
  if(!path.isAbsolute(selection.root??'')||!path.isAbsolute(configFile??'')||!['codex','claude-code'].includes(host?.kind))
    throw new CreationClientError('creation.runtime_launch_invalid');
  let child;
  try{child=spawnImpl(process.execPath,[path.join(selection.root,'bin/promptframe-creation.mjs'),'bridge',
      '--config',configFile,'--host',host.kind,selection.locked?'--bridge-version':'--resolved-runtime-version',selection.version],
      {stdio:'inherit',windowsHide:true,env:{...env,PROMPTFRAME_CREATION_CONFIG:configFile,
        ...(host.kind==='claude-code'?{CLAUDECODE:'1',CLAUDE_CODE_SESSION_ID:host.threadId}:{})}});}
  catch{throw new CreationClientError('creation.runtime_start_unconfirmed');}
  let signaled=false;
  const forward=signal=>{if(!signaled){signaled=true;child.kill(signal);}};
  const interrupt=()=>forward('SIGINT'),terminate=()=>forward('SIGTERM');
  process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
  try{
    return await new Promise((resolve,reject)=>{
      child.once('error',()=>reject(new CreationClientError('creation.runtime_start_unconfirmed')));
      child.once('close',(code,signal)=>resolve({code:Number.isInteger(code)?code:1,signal:signal??null}));
    });
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
}
