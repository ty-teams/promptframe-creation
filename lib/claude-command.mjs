import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,lstat,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';

const execute=promisify(execFile);
class ClaudeCommandError extends CreationClientError{
  constructor(code,details){super('installation.'+code);this.details=details;}
}
export const claudeErrorDetails=error=>error instanceof ClaudeCommandError?error.details:undefined;
export async function resolveClaudeCommand({env=process.env,homeDirectory=homedir(),executable}={}){
  const selected=executable??env.PROMPTFRAME_CLAUDE_BIN;
  if(selected){
    if(!path.isAbsolute(selected))throw new CreationClientError('installation.claude_executable_invalid');
    await access(selected,constants.X_OK);return selected;
  }
  for(const directory of(env.PATH??'').split(path.delimiter).filter(path.isAbsolute)){
    const file=path.join(directory,process.platform==='win32'?'claude.exe':'claude');
    try{await access(file,constants.X_OK);return file;}catch(e){if(!['ENOENT','EACCES','ENOTDIR'].includes(e.code))throw e;}
  }
  // Desktop-managed remote builds have no PATH entry. Select by the actual
  // semantic version present, never by a compiled-in desktop build filename.
  const root=path.join(homeDirectory,'.claude/remote/ccd-cli');let entries;
  try{entries=await readdir(root);}catch(e){if(e.code==='ENOENT')throw new CreationClientError('installation.claude_required');throw e;}
  if(entries.length>32)throw new CreationClientError('installation.claude_executable_unconfirmed');
  const candidates=[];
  for(const name of entries){
    const match=name.match(/^(\d+)\.(\d+)\.(\d+)-[a-f0-9]{6,40}$/);if(!match)continue;
    const file=path.join(root,name),s=await lstat(file);
    if(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid?.()){await access(file,constants.X_OK);candidates.push({file,version:match.slice(1).map(Number)});}
  }
  candidates.sort((a,b)=>b.version[0]-a.version[0]||b.version[1]-a.version[1]||b.version[2]-a.version[2]);
  if(!candidates.length)throw new CreationClientError('installation.claude_required');
  if(candidates[1]&&JSON.stringify(candidates[0].version)===JSON.stringify(candidates[1].version))
    throw new CreationClientError('installation.claude_executable_unconfirmed');
  return candidates[0].file;
}
export function createClaudeRunner({env=process.env,executable,signal,resolve=resolveClaudeCommand}={}){
  let command;
  return async args=>{
    command??=resolve({env,executable});const binary=await command;
    const write=args[0]==='mcp'&&args[1]==='add-json'
      ||args[0]==='plugin'&&(args[1]==='install'||args[1]==='marketplace'&&args[2]==='add');
    const kind=args[0]==='--version'?'host_version':args[1]==='marketplace'
      ?write?'marketplace_register':'marketplace_read':args[0]==='mcp'?'mcp_register':write?'plugin_register':'plugin_read';
    const timeoutMs=write?30000:5000,start=performance.now();
    try{return(await execute(binary,args,{env,signal,encoding:'utf8',windowsHide:true,timeout:timeoutMs,maxBuffer:2*1024*1024})).stdout;}
    catch(e){throw new ClaudeCommandError(e.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'command_output_limit'
      :e.killed?'command_timeout':'command_failed',{phase:write?'registration':'local_check',commandKind:kind,
      elapsedMs:Math.round(performance.now()-start),timeoutMs,exitCode:Number.isInteger(e.code)?e.code:null,
      signal:['SIGTERM','SIGKILL','SIGINT'].includes(e.signal)?e.signal:null,localRegistrationState:'unknown',
      action:write?'observe_same_registration_before_retry':'retry_local_read'});}
  };
}
