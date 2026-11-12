import {createHash,randomBytes} from 'node:crypto';
import {mkdir,open,readFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {claudeHostHooks} from './claude-hook-definition.mjs';
import {CreationClientError} from './credentials.mjs';
import {inspectRuntimePackage} from './runtime-package.mjs';
import {profileCredentialsPath,installationFiles} from './user-installation.mjs';
import {createClaudeRunner,claudeErrorDetails} from './claude-command.mjs';
import {readClaudeUserServer} from './claude-local-state.mjs';
import {installClaudeMcpFallback} from './claude-mcp-installation.mjs';

const {info,privateDirectory,privateRead,atomicJSON,acquire,runNode,checkInstalledRuntime,compareVersions,validProfile}=installationFiles;
const hash=b=>createHash('sha256').update(b).digest('hex');
const effectiveRoot=plugin=>plugin.readFromFolder??plugin.installPath;
class ClaudeInstallationError extends CreationClientError{
  constructor(code,details){super('installation.'+code);this.details=details;}
}
export const claudeInstallationDetails=error=>error instanceof ClaudeInstallationError?error.details:undefined;
const fail=(code,details)=>{throw new ClaudeInstallationError(code,details);};
async function jsonCommand(run,args){
  const body=await run(args);let value;
  try{if(typeof body!=='string'||Buffer.byteLength(body)>2*1024*1024)throw Error();value=JSON.parse(body);}catch{fail('claude_local_registration_unconfirmed');}
  if(!Array.isArray(value)||value.length>1024)fail('claude_local_registration_unconfirmed');return value;
}
async function registrations(run,pluginName,marketplace,root){
  const [plugins,markets]=await Promise.all([jsonCommand(run,['plugin','list','--json']),
    jsonCommand(run,['plugin','marketplace','list','--json'])]);
  if(plugins.some(p=>!p||typeof p.id!=='string'||!p.id||p.id.length>256||typeof p.scope!=='string'
    ||typeof p.version!=='string'||typeof p.enabled!=='boolean'||typeof p.installPath!=='string')
    ||markets.some(p=>!p||typeof p.name!=='string'||!p.name||typeof p.source!=='string'))
    fail('claude_local_registration_unconfirmed');
  const related=plugins.filter(p=>typeof p?.id==='string'&&p.id.startsWith(pluginName+'@'));
  if(related.length>1||related.some(p=>p.id!==pluginName+'@'+marketplace||p.scope!=='user'
    ||typeof p.enabled!=='boolean'||!/^\d+\.\d+\.\d+$/.test(p.version??'')||!path.isAbsolute(p.installPath??'')
    ||p.readFromFolder!==undefined&&(!path.isAbsolute(p.readFromFolder)||p.folderVersion!==p.version)))
    fail('claude_existing_registration_requires_review');
  const found=markets.filter(p=>p?.name===marketplace);
  if(found.length>1||found.some(p=>p.source!=='directory'||p.path!==root||p.installLocation!==root))
    fail('claude_existing_registration_requires_review');
  return{plugin:related[0],market:found[0]};
}
async function legacyUserMcp(env,serverName){
  // Reading configuration does not start or health-check any MCP server.
  if(await readClaudeUserServer(serverName,env))fail('legacy_mcp_entry_requires_review');
}
function transport(serverName,configFile,command=process.execPath){
  return{mcpServers:{[serverName]:{command,
    args:['${CLAUDE_PLUGIN_ROOT}/bin/promptframe-creation.mjs','bridge','--config',configFile,'--host','claude-code']}}};
}
async function verifyVersion(root,{version,profile,configFile,payloadDigest,pluginName,serverName}){
  const directory=await info(root);
  if(!directory?.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()||(directory.mode&0o077))
    fail('claude_installed_files_invalid');
  const ready=await privateRead(path.join(root,'installation.json'));
  if(!ready||ready.host!=='claude-code'||ready.version!==version||ready.profile!==profile||ready.configFile!==configFile
    ||ready.payloadDigest!==payloadDigest||!Array.isArray(ready.files)||ready.files.length>1024)fail('claude_installed_files_invalid');
  const actual=await inspectRuntimePackage(root);
  if(actual.version!==version||JSON.stringify(actual.files.map(({path,bytes,sha256})=>({path,bytes,sha256})))!==JSON.stringify(ready.files))
    fail('claude_installed_files_invalid');
  const manifest=JSON.parse(await readFile(path.join(root,'.claude-plugin/plugin.json'),'utf8'));
  if(manifest.name!==pluginName||manifest.version!==version||manifest.skills!=='./skills/'||manifest.mcpServers!=='./.claude-mcp.json')
    fail('claude_installed_files_invalid');
  let runtimeCommand;
  for(const file of['.mcp.json','.claude-mcp.json']){
    const mcp=JSON.parse(await readFile(path.join(root,file),'utf8'));
    const command=mcp.mcpServers?.[serverName]?.command;
    if(!path.isAbsolute(command??'')||runtimeCommand!==undefined&&command!==runtimeCommand
      ||JSON.stringify(mcp)!==JSON.stringify(transport(serverName,configFile,command)))fail('claude_installed_files_invalid');
    runtimeCommand=command;
  }
  if(compareVersions(version,'0.3.1')>=0&&JSON.stringify(manifest.hooks)!==JSON.stringify(claudeHostHooks({pluginName,configFile,nodeCommand:runtimeCommand})))
    fail('claude_installed_files_invalid');
  return{...ready,runtimeCommand};
}

/** Official local-directory marketplace only. The host loads immutable version
 * directories in place; this adapter never updates/prunes host caches or starts
 * Claude model sessions. Codex registration and credentials stay independent. */
export async function installForClaudeUser(options={}){
  const profile=options.profile??'default',env=options.env??process.env;validProfile(profile);
  // One installer-owned mode guard covers selection and registration for this
  // host/profile. It does not lock Claude's configuration or other clients.
  const modeRoot=path.resolve(env.XDG_DATA_HOME??path.join(homedir(),'.local/share'),'promptframe-creation',profile,'claude-code-mode');
  await privateDirectory(modeRoot);const release=await acquire(modeRoot,options.signal);
  try{return await installClaudeUserLocked(options);}finally{await release();}
}
async function installClaudeUserLocked({sourceRoot,profile='default',env=process.env,
  configFile=profileCredentialsPath(profile,env),executable,signal,
  runClaude=createClaudeRunner({env,executable,signal}),checkRuntime=runNode,verifyInstalledRuntime=checkInstalledRuntime,
  nodeCommand=process.execPath}={}){
  validProfile(profile);
  if(!path.isAbsolute(nodeCommand))fail('runtime_command_invalid');
  const hostVersion=(await runClaude(['--version'])).trim().match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
  if(!hostVersion||compareVersions(hostVersion[1],'2.1.295')<0)fail('claude_21295_required');
  const help=await runClaude(['--help']);
  if(typeof help!=='string'||Buffer.byteLength(help)>128*1024)fail('claude_capabilities_unconfirmed');
  const hasPlugin=/^\s+plugin(?:\|plugins)?\s/m.test(help),hasMcp=/^\s+mcp\s/m.test(help);
  const base=path.resolve(env.XDG_DATA_HOME??path.join(homedir(),'.local/share'),'promptframe-creation',profile),
    fallbackRoot=path.join(base,'claude-code-mcp'),pluginRoot=path.join(base,'claude-code');
  const pluginPending=await info(path.join(pluginRoot,'registration-pending.json')),pluginCurrent=await info(path.join(pluginRoot,'current.json')),
    fallbackState=await info(path.join(fallbackRoot,'current.json'))||await info(path.join(fallbackRoot,'registration-pending.json'));
  if((!hasPlugin||fallbackState)&&(pluginPending||pluginCurrent))fail('registration_unconfirmed_keep_existing');
  if(!hasPlugin||fallbackState){
    if(!hasMcp)fail('claude_capabilities_unconfirmed');
    return installClaudeMcpFallback({sourceRoot,profile,env,configFile,signal,runClaude,checkRuntime,verifyInstalledRuntime,nodeCommand});
  }
  const payload=await inspectRuntimePackage(path.resolve(sourceRoot));
  if(!payload.files.some(f=>f.path==='.claude-plugin/plugin.json')||!payload.files.some(f=>f.path==='.claude-mcp.json'))
    fail('claude_package_incomplete');
  const root=path.resolve(env.XDG_DATA_HOME??path.join(homedir(),'.local/share'),'promptframe-creation',profile,'claude-code');
  await privateDirectory(root);const release=await acquire(root,signal);
  const suffix=profile==='default'?'':'-'+profile,pluginName='promptframe-creation'+suffix,
    marketplace='promptframe-creation-user'+suffix,pluginId=pluginName+'@'+marketplace,serverName='promptframe'+suffix;
  const versions=path.join(root,'versions'),currentFile=path.join(root,'current.json'),pendingFile=path.join(root,'registration-pending.json'),
    catalogFile=path.join(root,'.claude-plugin/marketplace.json'),versionRoot=path.join(versions,payload.version),
    temporary=path.join(versions,'.partial-'+randomBytes(12).toString('hex'));
  let registrationStarted=false,newFiles=0;
  try{
    signal?.throwIfAborted();await privateDirectory(versions);await privateDirectory(path.dirname(catalogFile));
    await legacyUserMcp(env,serverName);
    let previous=await privateRead(currentFile),pending=await privateRead(pendingFile),state=await registrations(runClaude,pluginName,marketplace,root);
    const binding={profile,configFile,pluginId,pluginName,serverName,host:'claude-code'};
    const checkBinding=record=>{if(record&&(record.profile!==profile||record.configFile!==configFile||record.pluginId!==pluginId
      ||record.host!=='claude-code'||!/^\d+\.\d+\.\d+$/.test(record.version??'')
      ||record.versionRoot!==path.join(versions,record.version)))fail('profile_binding_conflict');};
    checkBinding(previous);checkBinding(pending);
    const runtimeCommands=new Map();
    const observed=async record=>{
      if(!state.market||!state.plugin||state.plugin.enabled!==true||state.plugin.version!==record.version||effectiveRoot(state.plugin)!==record.versionRoot)return false;
      const ready=await verifyVersion(record.versionRoot,{...record,pluginName,serverName});
      runtimeCommands.set(record.versionRoot,ready.runtimeCommand);return true;
    };
    if(pending){
      if(await observed(pending)){
        await atomicJSON(currentFile,pending);await rm(pendingFile);previous=pending;pending=null;
      }else if(pending.phase!=='marketplace'||!state.market||state.plugin)
        fail('registration_unconfirmed_keep_existing',{phase:'registration_observation',localRegistrationState:'unknown',action:'inspect_same_registration_no_second_add'});
    }
    if(state.plugin&&!previous&&!pending)fail('claude_existing_registration_requires_review');
    if(previous&&(!await observed(previous))&&!pending)fail('claude_local_registration_unconfirmed');
    if(previous&&compareVersions(previous.version,payload.version)>0){
      const recorded=runtimeCommands.get(previous.versionRoot);
      await verifyInstalledRuntime(previous.versionRoot,previous.version,recorded,{env});
      return{...previous,currentFile,reused:true,installedFiles:0,registered:true,pluginInstalled:true,versionStatus:'newer_retained',
        requestedVersion:payload.version,recordedRuntimeRetained:recorded!==nodeCommand};
    }
    const complete={...binding,version:payload.version,versionRoot,payloadDigest:payload.payloadDigest};
    if(pending&&(pending.version!==complete.version||pending.payloadDigest!==complete.payloadDigest))
      fail('registration_unconfirmed_keep_existing');
    if(await info(versionRoot)){
      const ready=await verifyVersion(versionRoot,{...complete,pluginName,serverName});runtimeCommands.set(versionRoot,ready.runtimeCommand);
    }
    else{
      await mkdir(temporary,{mode:0o700});
      for(const file of payload.files){signal?.throwIfAborted();const dest=path.join(temporary,file.path);
        await mkdir(path.dirname(dest),{recursive:true,mode:0o700});const fd=await open(dest,'wx',0o600);
        try{await fd.writeFile(file.body);await fd.sync();}finally{await fd.close();}}
      const manifest=JSON.parse(await readFile(path.join(temporary,'.claude-plugin/plugin.json'),'utf8'));manifest.name=pluginName;
      if(manifest.hooks)manifest.hooks=claudeHostHooks({pluginName,configFile,nodeCommand});
      await atomicJSON(path.join(temporary,'.claude-plugin/plugin.json'),manifest);
      for(const file of['.mcp.json','.claude-mcp.json'])await atomicJSON(path.join(temporary,file),transport(serverName,configFile,nodeCommand));
      await checkRuntime(temporary,payload.version);
      const installed=await inspectRuntimePackage(temporary);
      await atomicJSON(path.join(temporary,'installation.json'),{...binding,version:payload.version,payloadDigest:payload.payloadDigest,
        files:installed.files.map(({path,bytes,sha256})=>({path,bytes,sha256}))});
      signal?.throwIfAborted();await rename(temporary,versionRoot);newFiles=payload.files.length;
    }
    if(newFiles===0)await verifyInstalledRuntime(versionRoot,payload.version,runtimeCommands.get(versionRoot),{env});
    const already=previous?.version===payload.version&&previous.payloadDigest===payload.payloadDigest&&await observed(complete);
    if(!already){
      await atomicJSON(catalogFile,{name:marketplace,owner:{name:'PromptFrame'},plugins:[{name:pluginName,source:'./versions/'+payload.version}]});
      if(!state.market){
        if(pending)fail('registration_unconfirmed_keep_existing');
        await atomicJSON(pendingFile,{...complete,phase:'marketplace'});registrationStarted=true;
        await runClaude(['plugin','marketplace','add',root,'--scope','user','--json']);
        state=await registrations(runClaude,pluginName,marketplace,root);
        if(!state.market)fail('claude_registration_unconfirmed');
      }
      await atomicJSON(pendingFile,{...complete,phase:'plugin'});registrationStarted=true;
      await runClaude(['plugin','install',pluginId,'--scope','user','--json']);
      state=await registrations(runClaude,pluginName,marketplace,root);
      if(!await observed(complete))fail('claude_registration_unconfirmed');
      await atomicJSON(currentFile,complete);await rm(pendingFile);
    }
    return{...complete,currentFile,reused:newFiles===0,installedFiles:newFiles,registered:true,pluginInstalled:true,
      reloadRequired:!already,versionStatus:'current',requestedVersion:payload.version,
      recordedRuntimeRetained:runtimeCommands.has(versionRoot)&&runtimeCommands.get(versionRoot)!==nodeCommand};
  }catch(error){
    if(registrationStarted)fail('registration_unconfirmed_keep_existing',{...claudeErrorDetails(error),
      phase:'registration_observation',localRegistrationState:'unknown',action:'inspect_same_registration_no_second_add'});
    if(error instanceof CreationClientError)throw error;
    fail(signal?.aborted?'interrupted_keep_existing':'failed_keep_existing');
  }finally{await rm(temporary,{recursive:true,force:true});await release();}
}
