import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import {lstat,mkdir,readdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {CreationClientError,credentialsPath} from './credentials.mjs';

const execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new CreationClientError('installation.'+code);};
const entries=['package.json','README.md','LICENSE','bin','dist','lib','skills','docs','.codex-plugin','.mcp.json'];
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function validProfile(profile){if(typeof profile!=='string'||!/^[a-z][a-z0-9-]{0,31}$/.test(profile))fail('profile_invalid');return profile;}
export function profileCredentialsPath(profile='default',env=process.env){
 validProfile(profile);
 return profile==='default'?credentialsPath(env):path.resolve(env.XDG_CONFIG_HOME??path.join(homedir(),'.config'),
  'promptframe-creation','profiles',profile,'credentials.json');
}
async function info(file){try{return await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function privateDirectory(dir){
 await mkdir(dir,{recursive:true,mode:0o700});const s=await lstat(dir);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))fail('private_owner_required');
}
async function privateRead(file){
 const s=await info(file);if(!s)return null;
 if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>512*1024)fail('state_invalid');
 return json(file);
}
async function packageJSON(file){
 const s=await info(file);
 if(!s?.isFile()||s.isSymbolicLink()||s.size>512*1024)fail('installed_files_invalid');
 return json(file);
}
function sameTransport(actual,expected){
 return actual?.type==='stdio'&&actual.command===expected.command
  &&typeof actual.cwd==='string'&&path.resolve(actual.cwd)===path.resolve(expected.cwd)
  &&JSON.stringify(actual.args)===JSON.stringify(expected.args)
  &&JSON.stringify(actual.env_vars??[])===JSON.stringify(expected.env_vars??[])
  &&!Object.keys(actual.env??{}).length;
}
async function managedTransport(installed,versions,serverName,profile,configFile){
 if(!installed)return null;
 const root=installed.source?.path;
 if(installed.source?.source!=='local'||typeof root!=='string'
  ||!/^\d+\.\d+\.\d+$/.test(installed.version??'')||root!==path.join(versions,installed.version))fail('existing_registration_requires_review');
 const directory=await info(root),definition=await info(path.join(root,'.mcp.json'));
 if(!directory?.isDirectory()||directory.isSymbolicLink()||!definition?.isFile()||definition.isSymbolicLink())fail('installed_files_invalid');
 const ready=await privateRead(path.join(root,'installation.json'));
 if(!ready||ready.profile!==profile||ready.configFile!==configFile||ready.version!==installed.version)fail('existing_registration_requires_review');
 const bytes=await readFile(path.join(root,'.mcp.json')),entry=ready.files?.find(x=>x.path==='.mcp.json');
 if(!entry||entry.bytes!==bytes.length||entry.sha256!==hash(bytes))fail('installed_files_invalid');
 const mcp=JSON.parse(bytes).mcpServers?.[serverName];
 if(!mcp||typeof mcp.command!=='string'||!mcp.command||mcp.cwd!==root
  ||JSON.stringify(mcp.args)!==JSON.stringify([path.join(root,'bin/promptframe-creation.mjs'),'bridge','--config',configFile]))fail('existing_registration_requires_review');
 return mcp;
}
async function officialNpmInstallation(installed,servers,env,profile,configFile){
 if(profile!=='default'||configFile!==profileCredentialsPath('default',env))return null;
 const candidates=installed.filter(p=>p.enabled===true&&p.name==='promptframe-creation'
  &&p.pluginId==='promptframe-creation@'+p.marketplaceName&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,140}$/.test(p.marketplaceName??'')
  &&/^\d+\.\d+\.\d+$/.test(p.version??'')&&p.source?.source==='npm'
  &&p.source.package==='@promptframe/creation'&&p.source.version===p.version
  &&['https://registry.npmjs.org','https://registry.npmjs.org/'].includes(p.source.registry));
 if(candidates.length>1)fail('existing_registration_requires_review');
 if(!candidates.length)return null;
 const p=candidates[0],root=path.join(path.resolve(env.CODEX_HOME??path.join(homedir(),'.codex')),'plugins/cache',p.marketplaceName,p.name,p.version);
 const directory=await info(root);if(!directory?.isDirectory()||directory.isSymbolicLink())fail('installed_files_invalid');
 const pkg=await packageJSON(path.join(root,'package.json')),manifest=await packageJSON(path.join(root,'.codex-plugin/plugin.json'));
 if(pkg.name!=='@promptframe/creation'||pkg.version!==p.version||manifest.name!==p.name||manifest.version!==p.version)fail('installed_files_invalid');
 const definition=(await packageJSON(path.join(root,'.mcp.json'))).mcpServers?.promptframe;
 if(!definition||definition.command!=='node'||definition.cwd!=='.'
  ||JSON.stringify(definition.args)!==JSON.stringify(['bin/promptframe-creation.mjs','bridge'])
  ||JSON.stringify(definition.env_vars)!==JSON.stringify(['PROMPTFRAME_CREATION_CONFIG','XDG_CONFIG_HOME']))fail('legacy_mcp_entry_requires_review');
 if(servers.length!==1||servers[0].enabled!==true||!sameTransport(servers[0].transport,{...definition,cwd:root})
  ||JSON.stringify(servers[0].transport.env_vars)!==JSON.stringify(definition.env_vars))fail('legacy_mcp_entry_requires_review');
 // Keep the host's verified npm registration and running cache. Do not create a
 // second effective plugin or delete an active cache to migrate it.
 return{version:p.version,profile,configFile,pluginId:p.pluginId,versionRoot:root,currentFile:null,
  reused:true,installedFiles:0,registered:true,reloadRequired:false};
}
async function atomicJSON(file,value){
 const temp=file+'.'+randomBytes(12).toString('hex')+'.tmp';
 try{await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temp,file);}
 finally{await rm(temp,{force:true});}
}
async function packageFiles(root){
 const files=[];let bytes=0;
 async function walk(relative){
  const s=await info(path.join(root,relative));
  if(!s||s.isSymbolicLink())fail('package_file_invalid');
  if(s.isDirectory()){
   for(const name of (await readdir(path.join(root,relative))).sort()){
    if(name==='node_modules'||name==='credentials.json'||name.startsWith('.env'))fail('package_file_invalid');
    await walk(path.join(relative,name));
   }
  }else if(s.isFile()){
   if(s.size>32*1024*1024)fail('package_too_large');
   const body=await readFile(path.join(root,relative));bytes+=body.length;
   if(files.length>=1024||bytes>32*1024*1024)fail('package_too_large');
   files.push({path:relative,bytes:body.length,sha256:hash(body),body});
  }else fail('package_file_invalid');
 }
 for(const name of entries)await walk(name);
 for(const name of ['dist/cli.mjs','dist/THIRD_PARTY_NOTICES.txt','skills/creation-setup/SKILL.md','skills/video-creation/SKILL.md'])
  if(!files.some(f=>f.path===name))fail('package_incomplete');
 const pkg=JSON.parse(files.find(f=>f.path==='package.json').body),plugin=JSON.parse(files.find(f=>f.path==='.codex-plugin/plugin.json').body);
 if(pkg.name!=='@promptframe/creation'||!/^\d+\.\d+\.\d+$/.test(pkg.version)||plugin.version!==pkg.version)fail('package_identity_invalid');
 return{files,version:pkg.version,payloadDigest:hash(JSON.stringify(files.map(({path,bytes,sha256})=>({path,bytes,sha256}))))};
}
async function acquire(root,signal){
 const lock=path.join(root,'install.lock');
 const end=Date.now()+30_000;let owned=false;
 while(!owned){
  signal?.throwIfAborted();
  try{await mkdir(lock,{mode:0o700});owned=true;}
  catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>=end)fail('in_progress_or_interrupted_keep_existing');await pause(50);}
 }
 try{await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});}
 catch(e){await rm(lock,{recursive:true,force:true});throw e;}
 return()=>rm(lock,{recursive:true,force:true});
}
export async function runCodexCommand(args,{env=process.env}={}){
 try{return(await execute('codex',args,{env,encoding:'utf8',timeout:30_000,maxBuffer:2*1024*1024})).stdout;}
 catch(e){throw new CreationClientError(e.code==='ENOENT'?'installation.codex_required':'installation.codex_command_unconfirmed');}
}
async function runNode(root,version){
 try{const result=await execute(process.execPath,[path.join(root,'bin/promptframe-creation.mjs'),'--version'],{encoding:'utf8',timeout:10_000,maxBuffer:8192});
  if(result.stdout.trim()!==version)fail('runtime_version_mismatch');
 }catch(e){if(e instanceof CreationClientError)throw e;fail('runtime_check_failed');}
}

/** No daemon or global environment switch. All writes are confined to this
 * user's managed profile. Host registration uses Codex's ordinary commands.
 * Completed versions are retained: a running bridge may still use any of them. */
export async function installForUser({sourceRoot,profile='default',env=process.env,
 configFile=profileCredentialsPath(profile,env),runCodex=args=>runCodexCommand(args,{env}),
 checkRuntime=runNode,signal}={}){
 validProfile(profile);
 const versionOutput=await runCodex(['--version']);
 const match=versionOutput.match(/codex-cli (\d+)\.(\d+)\.(\d+)/);
 if(!match||Number(match[1])===0&&Number(match[2])<160)fail('codex_0160_required');
 const payload=await packageFiles(path.resolve(sourceRoot));
 const root=path.resolve(env.XDG_DATA_HOME??path.join(homedir(),'.local/share'),'promptframe-creation',profile);
 await privateDirectory(root);const release=await acquire(root,signal);
 const versions=path.join(root,'versions'),currentFile=path.join(root,'current.json');
 const marketplaceFile=path.join(root,'.agents/plugins/marketplace.json');
 const pluginName='promptframe-creation'+(profile==='default'?'':'-'+profile),marketplace='promptframe-creation-user'+(profile==='default'?'':'-'+profile);
 const pluginId=pluginName+'@'+marketplace;
 const versionRoot=path.join(versions,payload.version),temporary=path.join(versions,'.partial-'+randomBytes(12).toString('hex'));
 let previousCatalog,previous,registrationStarted=false,newFiles=0;
 try{
  signal?.throwIfAborted();await privateDirectory(versions);await privateDirectory(path.dirname(marketplaceFile));
  previous=await privateRead(currentFile);previousCatalog=await privateRead(marketplaceFile);
  if(previous&&(previous.profile!==profile||previous.pluginId!==pluginId||previous.configFile!==configFile))fail('profile_binding_conflict');
  const state=JSON.parse(await runCodex(['plugin','list','--json']));
  const installed=state.installed?.find(x=>x.pluginId===pluginId);
  const legacy=JSON.parse(await runCodex(['mcp','list','--json']));
  const serverName='promptframe'+(profile==='default'?'':'-'+profile);
  const servers=legacy.filter(x=>x.name===serverName);
  const official=await officialNpmInstallation(state.installed??[],servers,env,profile,configFile);
  if(official){if(installed||previous)fail('existing_registration_requires_review');return official;}
  const recorded=await managedTransport(installed,versions,serverName,profile,configFile);
  if(legacy.some(x=>{
   if(x.name!==serverName)return false;
   return !recorded||!sameTransport(x.transport,recorded);
  }))fail('legacy_mcp_entry_requires_review');
  const target=await info(versionRoot);
  if(target){
   if(!target.isDirectory()||target.isSymbolicLink())fail('version_content_conflict');
   const ready=await privateRead(path.join(versionRoot,'installation.json'));
   if(!ready||ready.payloadDigest!==payload.payloadDigest||ready.profile!==profile||ready.configFile!==configFile)fail('version_content_conflict');
   for(const f of ready.files){
    if(!payload.files.some(p=>p.path===f.path))fail('installed_files_invalid');
    const file=path.join(versionRoot,f.path),s=await info(file);
    if(!s?.isFile()||s.isSymbolicLink()||s.size!==f.bytes||hash(await readFile(file))!==f.sha256)fail('installed_files_invalid');
   }
   if(ready.files.length!==payload.files.length)fail('installed_files_invalid');
  }else{
   await mkdir(temporary,{mode:0o700});
   for(const f of payload.files){signal?.throwIfAborted();await mkdir(path.dirname(path.join(temporary,f.path)),{recursive:true,mode:0o700});await writeFile(path.join(temporary,f.path),f.body,{flag:'wx',mode:0o600});}
   const manifest=await json(path.join(temporary,'.codex-plugin/plugin.json'));manifest.name=pluginName;
   await writeFile(path.join(temporary,'.codex-plugin/plugin.json'),JSON.stringify(manifest,null,2)+'\n');
   const mcp={mcpServers:{['promptframe'+(profile==='default'?'':'-'+profile)]:{
    command:process.execPath,args:[path.join(versionRoot,'bin/promptframe-creation.mjs'),'bridge','--config',configFile],cwd:versionRoot,
   }}};
   await writeFile(path.join(temporary,'.mcp.json'),JSON.stringify(mcp,null,2)+'\n');
   await checkRuntime(temporary,payload.version);
   const files=[];for(const f of payload.files){const body=await readFile(path.join(temporary,f.path));files.push({path:f.path,bytes:body.length,sha256:hash(body)});}
   await atomicJSON(path.join(temporary,'installation.json'),{version:payload.version,profile,configFile,payloadDigest:payload.payloadDigest,files});
   signal?.throwIfAborted();await rename(temporary,versionRoot);newFiles=payload.files.length;
  }
  const complete={version:payload.version,profile,configFile,pluginId,versionRoot,payloadDigest:payload.payloadDigest};
  const already=previous?.version===payload.version&&previous.payloadDigest===payload.payloadDigest&&installed?.version===payload.version&&installed.enabled===true;
  if(!already){
   const catalog={name:marketplace,interface:{displayName:'PromptFrame Creation'},plugins:[{name:pluginName,
    source:{source:'local',path:'./versions/'+payload.version},policy:{installation:'AVAILABLE',authentication:'ON_USE'},category:'Productivity'}]};
   await atomicJSON(marketplaceFile,catalog);signal?.throwIfAborted();registrationStarted=true;
   await runCodex(['plugin','marketplace','add',root,'--json']);
   await runCodex(['plugin','add',pluginId,'--json']);
   const observed=JSON.parse(await runCodex(['plugin','list','--json'])).installed?.find(x=>x.pluginId===pluginId);
   if(observed?.version!==payload.version||observed.enabled!==true)fail('registration_unconfirmed');
   await atomicJSON(currentFile,complete);
  }
  return{...complete,currentFile,reused:newFiles===0,installedFiles:newFiles,registered:true,reloadRequired:!already,
   recordedRuntimeRetained:Boolean(already&&recorded&&recorded.command!==process.execPath)};
 }catch(error){
  if(registrationStarted){
   // A lost command result may already have installed the complete candidate.
   // Keep all versions and the old default; never delete a possibly running copy.
   if(previousCatalog){
    await atomicJSON(marketplaceFile,previousCatalog);
    // Compensate only our exact earlier registration. If the command outcome
    // cannot be verified, report pending; the old files/default remain intact.
    if(previous){try{
     await runCodex(['plugin','add',pluginId,'--json']);
     const restored=JSON.parse(await runCodex(['plugin','list','--json'])).installed?.find(x=>x.pluginId===pluginId);
     if(restored?.version!==previous.version||restored.enabled!==true)fail('registration_unconfirmed');
    }catch{ /* No deletion, retry loop, token replacement or claim of restoration. */ }}
   }
   else await rm(marketplaceFile,{force:true});
   fail('registration_unconfirmed_keep_existing');
  }
  if(error instanceof CreationClientError)throw error;
  if(signal?.aborted)fail('interrupted_keep_existing');
  fail('failed_keep_existing');
 }finally{await rm(temporary,{recursive:true,force:true});await release();}
}
