import {createHash,randomBytes} from 'node:crypto';
import {mkdir,open,readFile,readdir,rename,rm,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';
import {inspectRuntimePackage} from './runtime-package.mjs';
import {installationFiles} from './user-installation.mjs';
import {claudeConfigRoot,readClaudeUserServer} from './claude-local-state.mjs';
import {registerClaudeFallbackHooks,verifyClaudeFallbackHooks} from './claude-hook-registration.mjs';

const {info,privateDirectory,privateRead,atomicJSON,acquire,compareVersions}=installationFiles;
const hash=body=>createHash('sha256').update(body).digest('hex');
class FallbackError extends CreationClientError{
  constructor(code,details){super('installation.'+code);this.details=details;}
}
export const fallbackErrorDetails=error=>error instanceof FallbackError?error.details:undefined;
const fail=(code,details)=>{throw new FallbackError(code,details);};
export async function claimSkillDirectory(root){
  try{await mkdir(root,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('claude_skill_requires_review');throw error;}
}
function same(a,b,depth=0){
  if(a===b)return true;if(depth>8||!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const left=Object.keys(a).sort(),right=Object.keys(b).sort();
  return left.length<=256&&left.length===right.length&&left.every((key,i)=>key===right[i]&&same(a[key],b[key],depth+1));
}
async function atomicText(file,body){
  const temporary=file+'.'+randomBytes(12).toString('hex')+'.tmp';
  try{const fd=await open(temporary,'wx',0o600);try{await fd.writeFile(body);await fd.sync();}finally{await fd.close();}
    await rename(temporary,file);const dir=await open(path.dirname(file),'r');try{await dir.sync();}finally{await dir.close();}
  }finally{if(await info(temporary))await rm(temporary);}
}
async function verifyVersion(root,record){
  const directory=await info(root);
  if(!directory?.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()||(directory.mode&0o077))fail('claude_installed_files_invalid');
  const marker=await privateRead(path.join(root,'installation.json')),payload=await inspectRuntimePackage(root);
  if(!marker||marker.host!=='claude-code'||marker.mode!=='mcp-and-skills'||marker.profile!==record.profile
    ||marker.configFile!==record.configFile||marker.version!==record.version||marker.payloadDigest!==record.payloadDigest
    ||payload.payloadDigest!==marker.payloadDigest||!path.isAbsolute(marker.nodeCommand??''))fail('claude_installed_files_invalid');
  return marker;
}
function mcpDefinition(record,nodeCommand){return{type:'stdio',command:nodeCommand,
  args:[path.join(record.versionRoot,'bin/promptframe-creation.mjs'),'bridge','--config',record.configFile,'--host','claude-code']};}
function skillBody(payload,sourceName,name){
  const file=payload.files.find(f=>f.path==='skills/'+sourceName+'/SKILL.md');if(!file)fail('package_incomplete');
  const body=file.body.toString('utf8');
  if(!body.startsWith('---\n')||!body.includes('\nname: '+sourceName+'\n'))fail('package_incomplete');
  return body.replace('\nname: '+sourceName+'\n','\nname: '+name+'\n');
}
async function observedSkill(plan,record,{allowBefore=false}={}){
  const directory=await info(plan.root);if(!directory)return false;
  if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()||(directory.mode&0o077))fail('claude_skill_requires_review');
  const names=await readdir(plan.root);
  if(names.some(n=>!['SKILL.md','promptframe-installation.json'].includes(n)))fail('claude_skill_requires_review');
  const marker=await privateRead(path.join(plan.root,'promptframe-installation.json')),file=path.join(plan.root,'SKILL.md'),s=await info(file);
  if(!marker||marker.host!=='claude-code'||marker.profile!==record.profile||marker.configFile!==record.configFile||marker.name!==plan.name)
    fail('claude_skill_requires_review');
  if(!s&&allowBefore&&plan.beforeSHA===null&&marker.sha256===null)return false;
  if(!s?.isFile()||s.isSymbolicLink()||s.size>256*1024)fail('claude_skill_requires_review');
  const digest=hash(await readFile(file));
  if(digest===plan.sha256&&marker.sha256===plan.sha256)return true;
  if(allowBefore&&(digest===plan.beforeSHA||digest===plan.sha256)&&marker.sha256===plan.beforeSHA)return false;
  fail('claude_skill_requires_review');
}

/** Used only when help positively lacks plugin commands, or for an existing
 * owned fallback. It never follows an unknown plugin-registration attempt. */
export async function installClaudeMcpFallback({sourceRoot,profile,env,configFile,signal,runClaude,checkRuntime,verifyInstalledRuntime,nodeCommand,
  writeSkill=atomicText}){
  const payload=await inspectRuntimePackage(path.resolve(sourceRoot)),suffix=profile==='default'?'':'-'+profile,
    serverName='promptframe'+suffix,root=path.resolve(env.XDG_DATA_HOME??path.join(homedir(),'.local/share'),'promptframe-creation',profile,'claude-code-mcp');
  await privateDirectory(root);const release=await acquire(root,signal),versions=path.join(root,'versions'),currentFile=path.join(root,'current.json'),
    pendingFile=path.join(root,'registration-pending.json'),versionRoot=path.join(versions,payload.version),
    temporary=path.join(versions,'.partial-'+randomBytes(12).toString('hex'));
  let writeStarted=false,newFiles=0;
  const complete={host:'claude-code',mode:'mcp-and-skills',profile,configFile,serverName,version:payload.version,versionRoot,payloadDigest:payload.payloadDigest};
  const checkBinding=record=>{
    if(record&&(record.host!=='claude-code'||record.mode!=='mcp-and-skills'||record.profile!==profile||record.configFile!==configFile
      ||record.serverName!==serverName||!/^\d+\.\d+\.\d+$/.test(record.version??'')||record.versionRoot!==path.join(versions,record.version)))fail('profile_binding_conflict');
  };
  try{
    await privateDirectory(versions);let previous=await privateRead(currentFile),pending=await privateRead(pendingFile);
    checkBinding(previous);checkBinding(pending);
    let saved=await readClaudeUserServer(serverName,env);
    complete.beforeServer=pending?.beforeServer??saved;
    const settled=async record=>{
      const ready=await verifyVersion(record.versionRoot,record);
      if(!same(record.server,mcpDefinition(record,ready.nodeCommand)))fail('claude_installed_files_invalid');
      if(!same(saved,record.server))return false;
      if(compareVersions(record.version,'0.3.1')>=0)await verifyClaudeFallbackHooks(record.hostHooks,env);
      if(!Array.isArray(record.skills)||record.skills.length!==2)fail('claude_skill_requires_review');
      for(const [i,skill]of record.skills.entries()){
        const name=['creation-setup','video-creation'][i]+suffix;
        if(skill.name!==name||skill.root!==path.join(claudeConfigRoot(env),'skills',name)||!/^[a-f0-9]{64}$/.test(skill.sha256??''))
          fail('claude_skill_requires_review');
        if(!await observedSkill(skill,record))return false;
      }
      return true;
    };
    if(pending){
      writeStarted=true;
      if(pending.version!==complete.version||pending.payloadDigest!==complete.payloadDigest)fail('registration_unconfirmed_keep_existing');
      if(pending.phase==='mcp'){
        if(!await settled(pending))fail('registration_unconfirmed_keep_existing');
        await atomicJSON(currentFile,pending);await rm(pendingFile);previous=pending;pending=null;
      }else if(pending.phase!=='skills'||!same(saved,pending.beforeServer))fail('registration_unconfirmed_keep_existing');
    }
    if(previous&&!pending){
      if(!await settled(previous))fail('claude_local_registration_unconfirmed');
      if(compareVersions(previous.version,payload.version)>=0){
        const ready=await verifyVersion(previous.versionRoot,previous);
        await verifyInstalledRuntime(previous.versionRoot,previous.version,ready.nodeCommand,{env});
        return{...previous,currentFile,registered:true,pluginInstalled:false,pluginEnabled:false,skillsInstalled:true,
          installationMode:'mcp-and-skills',reused:true,installedFiles:0,requestedVersion:payload.version,
          versionStatus:previous.version===payload.version?'current':'newer_retained',recordedRuntimeRetained:ready.nodeCommand!==nodeCommand};
      }
    }else if(saved&&!pending)fail('legacy_mcp_entry_requires_review');
    if(await info(versionRoot))await verifyVersion(versionRoot,complete);
    else{
      await mkdir(temporary,{mode:0o700});
      for(const file of payload.files){signal?.throwIfAborted();const dest=path.join(temporary,file.path);
        await mkdir(path.dirname(dest),{recursive:true,mode:0o700});const fd=await open(dest,'wx',0o600);
        try{await fd.writeFile(file.body);await fd.sync();}finally{await fd.close();}}
      await checkRuntime(temporary,payload.version);
      await atomicJSON(path.join(temporary,'installation.json'),{...complete,nodeCommand});
      signal?.throwIfAborted();await rename(temporary,versionRoot);newFiles=payload.files.length;
    }
    const ready=await verifyVersion(versionRoot,complete);complete.server=mcpDefinition(complete,ready.nodeCommand);
    if(newFiles===0)await verifyInstalledRuntime(versionRoot,payload.version,ready.nodeCommand,{env});
    const skillRoot=path.join(claudeConfigRoot(env),'skills');await mkdir(skillRoot,{recursive:true,mode:0o700});
    const parent=await lstat(skillRoot);
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.())fail('claude_skill_requires_review');
    const plans=[];
    for(const sourceName of['creation-setup','video-creation']){
      const name=sourceName+suffix,body=skillBody(payload,sourceName,name),skill={name,root:path.join(skillRoot,name),sha256:hash(body)};
      if(pending){const old=pending.skills?.find(s=>s.name===name);
        if(!old||old.root!==skill.root||old.sha256!==skill.sha256)fail('registration_unconfirmed_keep_existing');
        plans.push({...old,body});
      }else{
        const existing=await info(skill.root);let beforeSHA=null;
        if(existing){
          const marker=await privateRead(path.join(skill.root,'promptframe-installation.json'));
          if(!marker||marker.profile!==profile||marker.configFile!==configFile||marker.name!==name)fail('claude_skill_requires_review');
          const old={...skill,sha256:marker.sha256};if(!await observedSkill(old,complete))fail('claude_skill_requires_review');beforeSHA=marker.sha256;
        }
        plans.push({...skill,beforeSHA,body});
      }
    }
    complete.skills=plans.map(({body,...p})=>p);
    if(!pending){await atomicJSON(pendingFile,{...complete,phase:'skills'});writeStarted=true;}
    for(const plan of plans){
      signal?.throwIfAborted();
      if(await info(plan.root)){
        if(await observedSkill(plan,complete,{allowBefore:true}))continue;
      }else{
        if(plan.beforeSHA!==null)fail('claude_skill_requires_review');await claimSkillDirectory(plan.root);
        // A marker is written before the first body so interruption is tied to
        // this pending identity rather than an unowned existing skill.
        await atomicJSON(path.join(plan.root,'promptframe-installation.json'),{host:'claude-code',profile,configFile,name:plan.name,sha256:null});
      }
      await writeSkill(path.join(plan.root,'SKILL.md'),plan.body);
      await atomicJSON(path.join(plan.root,'promptframe-installation.json'),{host:'claude-code',profile,configFile,name:plan.name,sha256:plan.sha256});
    }
    signal?.throwIfAborted();
    if(compareVersions(payload.version,'0.3.1')>=0)complete.hostHooks=await registerClaudeFallbackHooks({record:complete,root,env,nodeCommand:ready.nodeCommand,signal});
    if(!same(await readClaudeUserServer(serverName,env),complete.beforeServer))fail('claude_local_registration_changed');
    await atomicJSON(pendingFile,{...complete,phase:'mcp'});writeStarted=true;
    await runClaude(['mcp','add-json','--scope','user',serverName,JSON.stringify(complete.server)]);
    saved=await readClaudeUserServer(serverName,env);
    if(!await settled(complete))fail('registration_unconfirmed_keep_existing');
    await atomicJSON(currentFile,complete);await rm(pendingFile);
    return{...complete,currentFile,registered:true,pluginInstalled:false,pluginEnabled:false,skillsInstalled:true,
      installationMode:'mcp-and-skills',reused:newFiles===0,installedFiles:newFiles,requestedVersion:payload.version,versionStatus:'current'};
  }catch(error){
    if(writeStarted)fail('registration_unconfirmed_keep_existing',{phase:'registration_observation',localRegistrationState:'unknown',action:'inspect_same_registration_no_second_add'});
    if(error instanceof CreationClientError)throw error;fail(signal?.aborted?'interrupted_keep_existing':'failed_keep_existing');
  }finally{await rm(temporary,{recursive:true,force:true});await release();}
}
