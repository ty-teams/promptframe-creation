import {constants} from 'node:fs';
import {open,mkdir,lstat,rename,unlink,rmdir} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {CreationClientError} from './credentials.mjs';
import {CLAUDE_HOST_PROOF} from './claude-host-session.mjs';
import {threadFormat} from './host-identity.mjs';

const hex=/^[0-9a-f]{64}$/;
const TICKET_TTL_MS=120_000;
const SESSION_TTL_MS=24*60*60*1000;
const MAX_TICKETS=256;
const MAX_SESSIONS=256;
const DEFAULT_SERVER='promptframe_pf';
const mcpToolName=/^[A-Za-z0-9_.:-]{1,200}$/;
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

function objectArgs(value){
  return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
}
function promptFrameCall(toolCall,serverName){
  if(typeof toolCall?.name!=='string')return null;
  const args=objectArgs(toolCall.args)??{};
  if(toolCall.name==='call_mcp_tool'){
    if(args.ServerName!==serverName||typeof args.ToolName!=='string'||!mcpToolName.test(args.ToolName))return null;
    const inner=args.Arguments===undefined?{}:objectArgs(args.Arguments);
    return inner?{name:args.ToolName,args:inner,lazy:true}:null;
  }
  // Match the namespaced server, the former eager prefix, or a native
  // PromptFrame tool name already reduced by the host.
  const namespacedPrefix=`mcp_${serverName}_`,oldPrefix=`mcp_${serverName.split('_')[0]}_`;
  if(toolCall.name.startsWith(namespacedPrefix)){
    const name=toolCall.name.slice(namespacedPrefix.length);
    return mcpToolName.test(name)?{name,args,lazy:false}:null;
  }
  const name=toolCall.name.startsWith(oldPrefix)?toolCall.name.slice(oldPrefix.length):toolCall.name;
  return /^(?:platform_|promptframe_local_)[a-z0-9_]+$/i.test(name)&&mcpToolName.test(name)?{name,args,lazy:false}:null;
}
function sessionId(value){
  return typeof value==='string'&&threadFormat.test(value)?value.toLowerCase():null;
}
function transcriptDigest(input){
  const file=input?.transcriptPath;
  return typeof file==='string'&&file.length<=4096&&path.isAbsolute(file)?digest(path.normalize(file)):null;
}
function toolNameMatches(hookToolName,bridgeToolName){
  if(typeof hookToolName!=='string'||typeof bridgeToolName!=='string'||!bridgeToolName)return false;
  if(hookToolName===bridgeToolName)return true;
  return hookToolName.endsWith('_'+bridgeToolName)||hookToolName.endsWith(':'+bridgeToolName);
}

async function privateDirectory(directory){
  try{await mkdir(directory,{recursive:true,mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077))throw error('host_identity_unavailable');
}
async function privateRead(file){
  let handle;try{
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();
    if(!info.isFile()||info.uid!==process.getuid?.()||(info.mode&0o077)||info.size>262144)throw error('host_identity_unavailable');
    return JSON.parse(await handle.readFile('utf8'));
  }catch(e){if(e.code==='ENOENT')return null;throw e;}finally{await handle?.close();}
}

export function antigravityConfigRoot(env=process.env){
  return path.resolve(env.ANTIGRAVITY_CONFIG_DIR??env.GEMINI_CONFIG_DIR??path.join(homedir(),'.gemini','config'));
}

/** Local host provenance for Antigravity. Supports multiple concurrent
 * conversations sharing one plugin MCP server process by binding each
 * one-use PreToolUse ticket to its conversationId UUID and exact arguments. */
export async function createAntigravityHostSession({configFile,env=process.env,root,serverName=DEFAULT_SERVER,now=()=>Date.now()}={}){
  const base=root??path.join(antigravityConfigRoot(env),'promptframe-host-sessions');
  const namespace=path.join(base,digest(path.resolve(configFile)));
  const stateFile=path.join(namespace,'state.json');

  async function readState(){
    const value=await privateRead(stateFile);
    if(!value)return {contractVersion:'antigravity-host-session/v1',tickets:{}};
    if(value.contractVersion!=='antigravity-host-session/v1'||!value.tickets||typeof value.tickets!=='object'
      ||Array.isArray(value.tickets)||Object.keys(value.tickets).length>MAX_TICKETS+32)throw error('host_identity_unavailable');
    return value;
  }

  async function transaction(work){
    await privateDirectory(base);await privateDirectory(namespace);
    const lock=path.join(namespace,'write.lock');let acquired=false;
    for(let count=0;count<100;count++)try{await mkdir(lock,{mode:0o700});acquired=true;break;}
      catch(e){if(e.code!=='EEXIST')throw e;await new Promise(resolve=>setTimeout(resolve,10));}
    if(!acquired)throw error('host_identity_unavailable');
    let temporary;
    try{
      const current=await readState();
      const next=await work(current);
      if(next===undefined)return;
      const body=JSON.stringify(next);if(Buffer.byteLength(body)>262144)throw error('host_identity_unavailable');
      temporary=path.join(namespace,'state-'+randomBytes(16).toString('hex')+'.partial');
      const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await file.writeFile(body);await file.sync();}finally{await file.close();}
      await rename(temporary,stateFile);temporary=undefined;
      const directory=await open(namespace,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{await directory.sync();}finally{await directory.close();}
    }finally{if(temporary)await unlink(temporary).catch(()=>{});await rmdir(lock).catch(()=>{});}
  }

  function pruneTickets(tickets,currentTime){
    const kept={};
    for(const [k,v] of Object.entries(tickets)){
      if(v&&typeof v==='object'&&typeof v.expiresAt==='number'&&v.expiresAt>currentTime
        &&typeof v.conversationId==='string'&&threadFormat.test(v.conversationId))kept[k]=v;
    }
    const keys=Object.keys(kept);
    while(keys.length>=MAX_TICKETS)delete kept[keys.shift()];
    return kept;
  }

  function pruneSessions(sessions,currentTime){
    const active=Object.entries(sessions??{}).filter(([id,value])=>sessionId(id)
      &&Number.isSafeInteger(value?.expiresAt)&&value.expiresAt>currentTime);
    return Object.fromEntries(active.slice(-MAX_SESSIONS));
  }

  function bindSession(sessions,id,transcript,currentTime){
    const previous=sessions[id];
    delete sessions[id];
    sessions[id]={transcriptDigest:transcript??previous?.transcriptDigest??null,expiresAt:currentTime+SESSION_TTL_MS};
    return pruneSessions(sessions,currentTime);
  }

  async function begin(raw){
    const proof=raw.arguments?.[CLAUDE_HOST_PROOF],args=withoutProof(raw.arguments);
    if(proof===undefined)return {host:{kind:'antigravity'},assertCurrent:async()=>{},arguments:args};
    if(typeof proof!=='string'||!hex.test(proof))throw error('host_identity_invalid');
    const argsHash=digest(args),currentTime=now();
    let accepted;
    try{
      await transaction(current=>{
        const ticket=current.tickets[proof];
        if(!ticket||ticket.expiresAt<=currentTime||ticket.argsDigest!==argsHash
          ||!(ticket.exactToolName?ticket.toolName===raw.name:toolNameMatches(ticket.toolName,raw.name))
          ||!threadFormat.test(ticket.conversationId??''))
          throw error('host_identity_invalid');
        accepted={threadId:ticket.conversationId.toLowerCase()};
        delete current.tickets[proof];
        current.tickets=pruneTickets(current.tickets,currentTime);
        return current;
      });
    }catch(e){if(e instanceof CreationClientError)throw e;throw error('host_identity_unavailable');}
    return {host:{kind:'antigravity',threadId:accepted.threadId},arguments:args,assertCurrent:async()=>{}};
  }

  async function hook(input,event=input?.hookEventName??'PreToolUse'){
    if(input?.hookEventName!==undefined&&input.hookEventName!==event)return {};
    const id=sessionId(input?.conversationId),transcript=transcriptDigest(input),currentTime=now();
    if(event==='SessionStart'){
      if(id)await transaction(current=>{
        current.sessions=bindSession(pruneSessions(current.sessions,currentTime),id,transcript,currentTime);
        return current;
      });
      return {};
    }
    if(event!=='PreToolUse')return {};
    const call=promptFrameCall(input?.toolCall,serverName);
    if(!call)return {decision:'allow'};
    const args=withoutProof(call.args),argsHash=digest(args);
    let token;
    await transaction(current=>{
      const sessions=pruneSessions(current.sessions,currentTime);
      // SessionStart is a fallback only for an exact, unambiguous transcript.
      // A shared bridge must never choose the most recently opened conversation.
      const matches=!id&&input?.conversationId===undefined&&transcript
        ?Object.keys(sessions).filter(key=>sessions[key].transcriptDigest===transcript):[];
      const conversationId=id??(matches.length===1?matches[0]:null);
      if(!conversationId)return;
      const tickets=pruneTickets(current.tickets,currentTime);
      token=randomBytes(32).toString('hex');
      tickets[token]={toolName:call.name,exactToolName:true,argsDigest:argsHash,conversationId,expiresAt:currentTime+TICKET_TTL_MS};
      return {contractVersion:'antigravity-host-session/v1',tickets,sessions:bindSession(sessions,conversationId,transcript,currentTime)};
    });
    if(!token)return Object.hasOwn(call.args,CLAUDE_HOST_PROOF)
      ?{decision:'deny',reason:'Missing valid Antigravity conversationId for PromptFrame proof.'}:{decision:'allow'};
    return {decision:'allow',overwrite:call.lazy
      ?{Arguments:{...args,[CLAUDE_HOST_PROOF]:token}}:{[CLAUDE_HOST_PROOF]:token}};
  }

  return {begin,hook};
}

export async function readAntigravityHookInput(input){
  const chunks=[];let bytes=0;
  for await(const value of input){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);bytes+=chunk.length;
    if(bytes>2*1024*1024+65536)throw error('host_identity_invalid');chunks.push(chunk);}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
}

export async function runAntigravityHostHook({configFile,serverName,event,input=process.stdin,output=process.stdout,env=process.env}={}){
  const body=await readAntigravityHookInput(input);
  const store=await createAntigravityHostSession({configFile,serverName,env});
  output.write(JSON.stringify(await store.hook(body,event))+'\n');
}
