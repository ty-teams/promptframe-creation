import {constants} from 'node:fs';
import {open,mkdir,lstat,rename,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {CreationClientError} from './credentials.mjs';
import {claudeHostProcess} from './claude-host-process.mjs';

export const CLAUDE_HOST_PROOF='_promptframeHostProof';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hex=/^[0-9a-f]{64}$/;
const error=code=>new CreationClientError('creation.'+code);
const canonical=value=>{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)))
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 throw error('request_invalid');
};
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const withoutProof=args=>Object.fromEntries(Object.entries(args??{}).filter(([key])=>key!==CLAUDE_HOST_PROOF));
const later=(a,b)=>BigInt(a.birth)>BigInt(b.birth)||a.birth===b.birth&&a.pid>b.pid;
async function privateDirectory(directory){
 try{await mkdir(directory,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const info=await lstat(directory);
 if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077))throw error('host_identity_unavailable');
}
async function privateRead(file){
 let handle;try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();
  if(!info.isFile()||info.uid!==process.getuid?.()||(info.mode&0o077)||info.size>196608)throw error('host_identity_unavailable');
  return JSON.parse(await handle.readFile('utf8'));
 }catch(e){if(e.code==='ENOENT')return null;throw e;}finally{await handle?.close();}
}

/** Local host provenance only. No Token, platform permission or editor lease is
 * stored here. Every controlled call needs its own unguessable, one-use ticket
 * delivered by the host's PreToolUse hook; a SessionStart record alone cannot
 * lend authority to a later call when its hook failed or was disabled. */
export async function createClaudeHostSession({configFile,env=process.env,root,association,hookProcess=false}={}){
 const owner=association===undefined?await claudeHostProcess({env,purpose:hookProcess?'hook':'bridge'}):association;
 const base=root??path.join(env.CLAUDE_CONFIG_DIR??path.join(homedir(),'.claude'),'promptframe-host-sessions');
 const namespace=owner?path.join(base,digest([owner.digest,path.resolve(configFile)])):null;
 const stateFile=namespace&&path.join(namespace,'state.json');
 async function state(){
  if(!owner||!await owner.isCurrent())return null;
  const value=await privateRead(stateFile);
  if(!value)return null;
  if(value.contractVersion!=='claude-host-session/v1'||value.binding!==owner.digest||!Number.isSafeInteger(value.epoch)
   ||value.epoch<1||!value.order||!/^\d+$/.test(value.order.birth)||!Number.isSafeInteger(value.order.pid)
   ||value.sessionId!==null&&!uuid.test(value.sessionId)||!value.tickets||typeof value.tickets!=='object'
   ||Array.isArray(value.tickets)||Object.keys(value.tickets).length>128)throw error('host_identity_unavailable');
  return value;
 }
 async function transaction(work){
  if(!owner||!await owner.isCurrent())throw error('host_identity_unavailable');
  await privateDirectory(base);await privateDirectory(namespace);
  const lock=path.join(namespace,'write.lock');let acquired=false;
  for(let count=0;count<100;count++)try{await mkdir(lock,{mode:0o700});acquired=true;break;}
   catch(e){if(e.code!=='EEXIST')throw e;await new Promise(resolve=>setTimeout(resolve,10));}
  if(!acquired)throw error('host_identity_unavailable');
  let temporary;
  try{
   if(!await owner.isCurrent())throw error('host_identity_unavailable');
   const current=await state(),next=await work(current);
   if(next===undefined)return;
   if(next===null){if(current)await unlink(stateFile);return;}
   const body=JSON.stringify(next);if(Buffer.byteLength(body)>196608)throw error('host_identity_unavailable');
   temporary=path.join(namespace,'state-'+randomBytes(16).toString('hex')+'.partial');
   const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(body);await file.sync();}finally{await file.close();}
   if(!await owner.isCurrent())throw error('host_identity_unavailable');
   await rename(temporary,stateFile);temporary=undefined;
   const directory=await open(namespace,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
   try{await directory.sync();}finally{await directory.close();}
  }finally{if(temporary)await unlink(temporary).catch(()=>{});await rmdir(lock);}
 }
 async function begin(raw){
  const proof=raw.arguments?.[CLAUDE_HOST_PROOF],args=withoutProof(raw.arguments);
  if(proof===undefined)return{host:{kind:'claude-code'},assertCurrent:async()=>{},arguments:args};
  if(typeof proof!=='string'||!hex.test(proof))throw error('host_identity_invalid');
  let accepted;
  try{await transaction(current=>{
   const ticket=current?.tickets[proof];
   if(!current?.sessionId||!ticket||ticket.epoch!==current.epoch||ticket.sessionId!==current.sessionId
    ||ticket.digest!==digest([raw.name,args]))throw error('host_identity_invalid');
   accepted={threadId:current.sessionId,epoch:current.epoch};delete current.tickets[proof];return current;
  });}catch(e){if(e instanceof CreationClientError)throw e;throw error('host_identity_unavailable');}
  return{host:{kind:'claude-code',threadId:accepted.threadId},arguments:args,epoch:accepted.epoch,async assertCurrent(){
   try{const current=await state();if(current?.epoch!==accepted.epoch||current.sessionId!==accepted.threadId)
     throw error('host_session_changed');}
   catch(e){if(e instanceof CreationClientError)throw e;throw error('host_identity_unavailable');}
  }};
 }
 async function hook(input){
  const event=input?.hook_event_name;
  if(!['SessionStart','PreToolUse','SessionEnd'].includes(event))throw error('host_identity_invalid');
  const valid=typeof input.session_id==='string'&&uuid.test(input.session_id),sessionId=valid?input.session_id.toLowerCase():null;
  const rawArgs=input.tool_input;
  if(event==='PreToolUse'&&(!rawArgs||typeof rawArgs!=='object'||Array.isArray(rawArgs)
   ||typeof input.tool_name!=='string'||!/^mcp__[A-Za-z0-9_.:-]+__[A-Za-z0-9_.:-]+$/.test(input.tool_name)))throw error('host_identity_invalid');
  if(!owner)return event==='PreToolUse'&&Object.hasOwn(rawArgs,CLAUDE_HOST_PROOF)
   ?{hookSpecificOutput:{hookEventName:event,updatedInput:withoutProof(rawArgs)}}:{};
  let result={};
  await transaction(current=>{
   if(current&&later(current.order,owner.eventOrder))return undefined;
   if(event==='SessionEnd'){
    if(current?.sessionId===sessionId&&['prompt_input_exit','logout','other','bypass_permissions_disabled'].includes(input.reason))return null;
    if(!current||current.sessionId!==sessionId)return undefined;
   }
   if(event==='SessionStart'&&!['startup','resume','fork','clear','compact'].includes(input.source))throw error('host_identity_invalid');
   const inconsistent=event==='PreToolUse'&&current?.sessionId!==sessionId
    ||event==='SessionStart'&&input.source==='compact'&&current?.sessionId!==sessionId
    ||event==='SessionStart'&&input.source==='startup'&&current?.sessionId&&current.sessionId!==sessionId;
   const nextId=event==='SessionEnd'||inconsistent?null:sessionId;
   const same=current&&current.sessionId===nextId;
   const next={contractVersion:'claude-host-session/v1',binding:owner.digest,epoch:(current?.epoch??0)+(same?0:1),
    order:owner.eventOrder,sessionId:nextId,tickets:same?current.tickets:{}};
   if(event!=='PreToolUse')return next;
   const args=withoutProof(rawArgs),tool=input.tool_name.slice(input.tool_name.lastIndexOf('__')+2),key=digest([tool,args]);
   if(!nextId){result={hookSpecificOutput:{hookEventName:event,updatedInput:args}};return next;}
   const existing=rawArgs[CLAUDE_HOST_PROOF],prior=typeof existing==='string'&&next.tickets[existing];
   // Auto mode can review the changed input before dispatch. Preserve a still
   // unused exact ticket on that retry; never approve the tool or change its
   // business arguments. The bridge consumes the ticket only on actual call.
   if(prior&&prior.digest===key&&prior.epoch===next.epoch&&prior.sessionId===nextId){result={};return next;}
   // Bounded unused local tickets are not accepted platform work. Evicting
   // one can only refuse a late not-yet-dispatched call, never cancel a task.
   if(Object.keys(next.tickets).length>=128)delete next.tickets[Object.keys(next.tickets)[0]];
   const token=randomBytes(32).toString('hex');
   next.tickets[token]={digest:key,epoch:next.epoch,sessionId:nextId};
   result={hookSpecificOutput:{hookEventName:event,updatedInput:{...args,[CLAUDE_HOST_PROOF]:token}}};return next;
  });
  if(event==='SessionEnd')try{await rmdir(namespace);}catch(e){if(!['ENOTEMPTY','ENOENT'].includes(e.code))throw e;}
  return result;
 }
 return{begin,hook};
}

export async function readClaudeHookInput(input){
 const chunks=[];let bytes=0;
 for await(const value of input){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);bytes+=chunk.length;
  if(bytes>2*1024*1024+65536)throw error('host_identity_invalid');chunks.push(chunk);}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
}
export async function runClaudeHostHook({configFile,input=process.stdin,output=process.stdout,env=process.env}={}){
 const body=await readClaudeHookInput(input);
 const store=await createClaudeHostSession({configFile,env,hookProcess:true});
 output.write(JSON.stringify(await store.hook(body))+'\n');
}
