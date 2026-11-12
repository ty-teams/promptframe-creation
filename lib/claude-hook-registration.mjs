import {createHash} from 'node:crypto';
import {open,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {installationFiles} from './user-installation.mjs';
import {claudeConfigRoot} from './claude-local-state.mjs';
import {claudeHostHooks} from './claude-hook-definition.mjs';
import {CreationClientError} from './credentials.mjs';
const {privateDirectory,privateRead,atomicJSON,acquire}=installationFiles;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=()=>{throw new CreationClientError('installation.claude_hooks_require_review');};
async function settings(file){
 let handle;try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();
  if(!info.isFile()||info.uid!==process.getuid?.()||info.size>512*1024)fail();
  const value=JSON.parse(await handle.readFile('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||value.hooks!==undefined&&(!value.hooks||typeof value.hooks!=='object'||Array.isArray(value.hooks)))fail();
  return value;
 }catch(e){if(e.code==='ENOENT')return{};throw e;}finally{await handle?.close();}
}
const contains=(value,entries)=>Object.entries(entries).every(([event,wanted])=>Array.isArray(value.hooks?.[event])
 &&wanted.every(entry=>value.hooks[event].filter(actual=>digest(actual)===digest(entry)).length===1));
export async function verifyClaudeFallbackHooks(record,env){
 if(!record?.settingsFile||record.settingsFile!==path.join(claudeConfigRoot(env),'settings.json')||!record.entries)fail();
 if(!contains(await settings(record.settingsFile),record.entries))fail();
 return true;
}
/** The existing installer owns only these exact hook entries. Preserve all
 * unrelated settings; edited/missing owned entries and unknown ACKs are read,
 * never overwritten or followed by a second configuration write. */
export async function registerClaudeFallbackHooks({record,root,env,nodeCommand,signal}){
 const directory=claudeConfigRoot(env),file=path.join(directory,'settings.json');
 const guard=path.resolve(env.XDG_DATA_HOME??path.join(homedir(),'.local/share'),'promptframe-creation',
  'claude-hook-writer-'+digest(directory));
 await privateDirectory(guard);const release=await acquire(guard,signal);
 const markerFile=path.join(root,'hooks-current.json'),pendingFile=path.join(root,'hooks-pending.json');
 try{
  await privateDirectory(directory);
  const entries=claudeHostHooks({serverName:record.serverName,configFile:record.configFile,nodeCommand,runtimeRoot:record.versionRoot});
  const expected={contractVersion:'creation-claude-hooks/v1',settingsFile:file,profile:record.profile,entries};
  const pending=await privateRead(pendingFile),previous=await privateRead(markerFile),before=await settings(file);
  if(pending){
   if(digest(pending)!==digest(expected)||!contains(before,entries))throw new CreationClientError('installation.registration_unconfirmed_keep_existing');
   await atomicJSON(markerFile,expected);await rm(pendingFile);return expected;
  }
  if(previous){
   if(previous.contractVersion!==expected.contractVersion||previous.profile!==record.profile||previous.settingsFile!==file)fail();
   await verifyClaudeFallbackHooks(previous,env);
   if(digest(previous)===digest(expected))return previous;
  }
  const next={...before,hooks:{...before.hooks}};
  for(const [event,wanted]of Object.entries(entries)){
   const actual=next.hooks[event]??[];if(!Array.isArray(actual))fail();
   const owned=new Set((previous?.entries[event]??[]).map(digest));
   // A matching destination without our ownership record is not adopted.
   if(wanted.some(entry=>actual.some(value=>digest(value)===digest(entry))&&!owned.has(digest(entry))))fail();
   next.hooks[event]=[...actual.filter(entry=>!owned.has(digest(entry))),...wanted];
  }
  signal?.throwIfAborted();await atomicJSON(pendingFile,expected);
  if(digest(await settings(file))!==digest(before))fail();
  await atomicJSON(file,next);
  if(!contains(await settings(file),entries))throw new CreationClientError('installation.registration_unconfirmed_keep_existing');
  await atomicJSON(markerFile,expected);await rm(pendingFile);return expected;
 }finally{await release();}
}
