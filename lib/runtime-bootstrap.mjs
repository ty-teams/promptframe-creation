import {createHash,randomBytes} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {list as listTar} from 'tar';
import {lstat,mkdir,open,readFile,readdir,rename,rm,statfs} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';
import {compareBridgeVersions,assertBridgeCompatible,readPlatformBridgePolicy} from './bridge-negotiation.mjs';
import {inspectRuntimePackage,RUNTIME_PACKAGE_ENTRIES} from './runtime-package.mjs';

const PACKAGE='@promptframe/creation',REGISTRY='https://registry.npmjs.org';
const MAX_ARCHIVE=8*1024*1024,MAX_PAYLOAD=32*1024*1024,MAX_TAR=36*1024*1024;
const hash=b=>createHash('sha256').update(b).digest('hex'),execute=promisify(execFile);
const error=code=>new CreationClientError('creation.'+code);
const version=v=>{compareBridgeVersions(v,v);return v;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const roots=new Set([...RUNTIME_PACKAGE_ENTRIES,'.agents']);
class RuntimeSelectionError extends CreationClientError{
  constructor(code,currentVersion,lockedVersion,policy,action){
    super('creation.'+code);this.runtimeFacts=Object.freeze({currentVersion,...(lockedVersion?{lockedVersion}:{}),
      ...(policy?{minimumVersion:policy.minBridge,recommendedVersion:policy.recommendedBridge}:{}),action});
  }
}
export const runtimeErrorDetails=error=>error instanceof RuntimeSelectionError?error.runtimeFacts:undefined;
const snapshot=payload=>({version:payload.version,payloadDigest:payload.payloadDigest,
  files:payload.files.map(({path,bytes,sha256})=>({path,bytes,sha256}))});
async function info(file){try{return await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function privateDirectory(dir){
  await mkdir(dir,{recursive:true,mode:0o700});const s=await lstat(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw error('runtime_cache_owner_invalid');
}
async function privateJSON(file){
  const s=await info(file);if(!s)return null;
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>512*1024)throw error('runtime_cache_invalid');
  return JSON.parse(await readFile(file,'utf8'));
}
async function syncDirectory(dir){const fd=await open(dir,'r');try{await fd.sync();}finally{await fd.close();}}
async function exclusiveJSON(file,value){
  const fd=await open(file,'wx',0o600);try{await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();}finally{await fd.close();}
}

/** Only the fixed public package/version is resolved. Metadata never supplies
 * executable arguments, an alternative registry, credentials or a download command. */
export function checkedRuntimeMetadata(value,expectedVersion){
  version(expectedVersion);
  const tarball=REGISTRY+'/@promptframe/creation/-/creation-'+expectedVersion+'.tgz';
  if(value?.name!==PACKAGE||value.version!==expectedVersion||value.dist?.tarball!==tarball
    ||typeof value.dist.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value.dist.integrity))
    throw error('runtime_registry_identity_invalid');
  const encoded=value.dist.integrity.slice(7);
  if(Buffer.from(encoded,'base64').toString('base64')!==encoded)throw error('runtime_registry_identity_invalid');
  return{version:expectedVersion,integrity:value.dist.integrity,tarball};
}

async function boundedGet(url,{fetchImpl=fetch,signal,maxBytes,timeoutMs}){
  const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();let response;
  try{
    response=await fetchImpl(url,{signal:controller.signal,redirect:'error'});
    if(response.status!==200||Number(response.headers.get('content-length')??0)>maxBytes||!response.body)throw error('runtime_fetch_unavailable');
    const chunks=[];let count=0;
    for await(const chunk of response.body){count+=chunk.length;if(count>maxBytes)throw error('runtime_download_capacity');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks,count);
  }catch(e){await response?.body?.cancel().catch(()=>{});if(e instanceof CreationClientError)throw e;throw error('runtime_fetch_unavailable');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

/** tar handles archive parsing, while this function only creates regular files
 * itself. Links, special entries, duplicate/escaping paths and expansion bombs
 * are rejected before any payload is written to a private staging directory. */
export async function readRuntimeArchive(archive,metadata){
  if(!Buffer.isBuffer(archive)||archive.length>MAX_ARCHIVE
    ||'sha512-'+createHash('sha512').update(archive).digest('base64')!==metadata.integrity)throw error('runtime_integrity_invalid');
  let raw;try{raw=gunzipSync(archive,{maxOutputLength:MAX_TAR});}catch{throw error('runtime_archive_invalid');}
  const files=[],names=new Set();let total=0,entries=0,failure;
  const parser=listTar({strict:true,onReadEntry:entry=>{
    const name=entry.path;
    if(++entries>2048||!['File','Directory'].includes(entry.type)||!Number.isSafeInteger(entry.size)||entry.size<0
      ||entry.size>MAX_PAYLOAD||typeof name!=='string'||name.length>240||!name.startsWith('package/')
      ||name.includes('\\')||/[\x00-\x1f\x7f]/.test(name))failure=error('runtime_archive_invalid');
    const relative=name.slice(8).replace(/\/$/,'');
    if(relative&&(relative.normalize('NFC')!==relative||/[<>:"|?*]/.test(relative)
      ||relative.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)
        ||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
        ||p==='node_modules'||p==='credentials.json'||p.startsWith('.env'))||!roots.has(relative.split('/')[0])))
      failure=error('runtime_archive_invalid');
    const portableName=relative.toLowerCase();
    if(names.has(portableName))failure=error('runtime_archive_invalid');names.add(portableName);
    if(entry.type==='Directory'){if(entry.size!==0)failure=error('runtime_archive_invalid');return;}
    total+=entry.size;if(total>MAX_PAYLOAD||files.length>=1024||!relative)failure=error('runtime_archive_capacity');
    const chunks=[];let bytes=0;
    entry.on('data',chunk=>{bytes+=chunk.length;if(bytes>entry.size)failure=error('runtime_archive_invalid');if(!failure)chunks.push(Buffer.from(chunk));});
    entry.on('end',()=>{if(bytes!==entry.size)failure=error('runtime_archive_invalid');if(!failure)files.push({path:relative,body:Buffer.concat(chunks,bytes)});});
  }});
  await new Promise((resolve,reject)=>{parser.once('error',()=>reject(error('runtime_archive_invalid')));parser.once('end',resolve);parser.end(raw);});
  if(failure)throw failure;
  if(!files.length||files.length>1024)throw error('runtime_archive_invalid');
  return files;
}

async function cacheLock(root,signal){
  const name=path.join(root,'prepare.lock'),end=Date.now()+5000;let fd;
  while(!fd){
    signal?.throwIfAborted();
    try{fd=await open(name,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;if(Date.now()>=end)throw error('runtime_cache_busy');await pause(50);}
  }
  const owned=await fd.stat();
  try{await fd.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()})+'\n');await fd.sync();await syncDirectory(root);}
  catch(e){await fd.close();const now=await info(name);if(now&&now.dev===owned.dev&&now.ino===owned.ino)await rm(name);throw e;}
  return async()=>{const now=await info(name);await fd.close();if(!now||now.dev!==owned.dev||now.ino!==owned.ino)throw error('runtime_lock_changed');await rm(name);};
}
async function verifyCached(target,metadata){
  if(!await info(target))return null;
  await privateDirectory(target);
  const manifest=await privateJSON(path.join(target,'runtime.json'));
  if(!manifest||manifest.contractVersion!=='creation-verified-runtime/v1'||manifest.version!==metadata.version||manifest.integrity!==metadata.integrity)
    throw error('runtime_cache_invalid');
  // Runtime caches verify every archived root, including plugin discovery
  // metadata. User-level installation still copies its original payload roots.
  const names=(await readdir(target)).filter(name=>name!=='runtime.json').sort();
  if(names.some(name=>!roots.has(name))||RUNTIME_PACKAGE_ENTRIES.some(name=>!names.includes(name)))throw error('runtime_cache_invalid');
  const payload=await inspectRuntimePackage(target,{entries:names});
  if(JSON.stringify(snapshot(payload))!==JSON.stringify(manifest.payload))throw error('runtime_cache_invalid');
  return{version:payload.version,root:target,integrity:metadata.integrity,reused:true};
}
async function checkedVersionIndex(cacheRoot,metadata){
  const old=await privateJSON(path.join(cacheRoot,'version-'+metadata.version+'.json'));
  if(old&&JSON.stringify(old)!==JSON.stringify(metadata))throw error('runtime_registry_identity_conflict');
  return old;
}

export async function prepareVerifiedRuntime(metadata,{cacheRoot,fetchImpl=fetch,signal,checkRuntime}={}){
  if(!path.isAbsolute(cacheRoot??''))throw error('runtime_cache_owner_invalid');
  metadata=checkedRuntimeMetadata({name:PACKAGE,version:metadata.version,dist:metadata},metadata.version);
  await privateDirectory(cacheRoot);
  await checkedVersionIndex(cacheRoot,metadata);
  const target=path.join(cacheRoot,metadata.version+'-'+hash(metadata.integrity)),existing=await verifyCached(target,metadata);
  if(existing)return existing;
  const archive=await boundedGet(metadata.tarball,{fetchImpl,signal,maxBytes:MAX_ARCHIVE,timeoutMs:15000});
  const files=await readRuntimeArchive(archive,metadata),release=await cacheLock(cacheRoot,signal);
  const temporary=path.join(cacheRoot,'.partial-'+randomBytes(12).toString('hex'));
  try{
    const index=await checkedVersionIndex(cacheRoot,metadata);
    const found=await verifyCached(target,metadata);if(found)return found;
    const space=await statfs(cacheRoot,{bigint:true}),needed=BigInt(files.reduce((n,f)=>n+f.body.length,0)+4*1024*1024);
    if(space.bavail*space.bsize<needed)throw error('runtime_cache_capacity');
    await mkdir(temporary,{mode:0o700});
    for(const file of files){signal?.throwIfAborted();const dest=path.join(temporary,...file.path.split('/'));
      await mkdir(path.dirname(dest),{recursive:true,mode:0o700});const fd=await open(dest,'wx',0o600);
      try{await fd.writeFile(file.body);await fd.sync();}finally{await fd.close();}}
    const entries=[...new Set(files.map(file=>file.path.split('/')[0]))].sort();
    if(RUNTIME_PACKAGE_ENTRIES.some(name=>!entries.includes(name)))throw error('runtime_package_incomplete');
    const payload=await inspectRuntimePackage(temporary,{entries});
    if(payload.version!==metadata.version)throw error('runtime_package_version_invalid');
    const pkg=JSON.parse(payload.files.find(f=>f.path==='package.json').body);
    if(pkg.repository?.url!=='git+https://github.com/ty-teams/promptframe-creation.git'||pkg.private===true)throw error('runtime_package_identity_invalid');
    if(checkRuntime)await checkRuntime(temporary,metadata.version);
    else{
      const result=await execute(process.execPath,[path.join(temporary,'bin/promptframe-creation.mjs'),'--version'],
        {timeout:5000,maxBuffer:65536,windowsHide:true,signal,env:{...process.env,
          PROMPTFRAME_CREATION_CONFIG:path.join(temporary,'no-credentials.json')}});
      if(result.stdout.trim()!==metadata.version||result.stderr.trim())throw error('runtime_package_version_invalid');
    }
    signal?.throwIfAborted();
    await exclusiveJSON(path.join(temporary,'runtime.json'),{contractVersion:'creation-verified-runtime/v1',
      version:metadata.version,integrity:metadata.integrity,payload:snapshot(payload)});
    await syncDirectory(temporary);
    if(!index){await exclusiveJSON(path.join(cacheRoot,'version-'+metadata.version+'.json'),metadata);await syncDirectory(cacheRoot);}
    await rename(temporary,target);await syncDirectory(cacheRoot);
    return{version:metadata.version,root:target,integrity:metadata.integrity,reused:false};
  }finally{try{if(await info(temporary))await rm(temporary,{recursive:true});}finally{await release();}}
}

export async function selectBridgeRuntime({policy,currentVersion,lockedVersion,resolvedVersion,cacheRoot,fetchImpl=fetch,signal,checkRuntime}={}){
  version(currentVersion);if(lockedVersion!==undefined)version(lockedVersion);
  if(resolvedVersion!==undefined&&resolvedVersion!==currentVersion)throw error('runtime_selection_identity_invalid');
  if(!policy)throw new RuntimeSelectionError('platform_bridge_policy_unavailable',currentVersion,lockedVersion,null,
    'update_platform_then_start_new_session');
  policy=readPlatformBridgePolicy({experimental:{'promptframe.creation':policy}});
  const target=lockedVersion??resolvedVersion??(policy&&compareBridgeVersions(policy.recommendedBridge,currentVersion)>0?policy.recommendedBridge:currentVersion);
  if(policy&&compareBridgeVersions(target,policy.minBridge)<0){
    if(lockedVersion!==undefined)throw new RuntimeSelectionError('bridge_locked_below_minimum',currentVersion,lockedVersion,policy,'choose_compatible_bridge_version_or_remove_lock');
    else assertBridgeCompatible({experimental:{'promptframe.creation':policy}},currentVersion);
  }
  if(target===currentVersion){if(policy)assertBridgeCompatible({experimental:{'promptframe.creation':policy}},currentVersion);
    return{version:currentVersion,current:true,locked:lockedVersion!==undefined,status:'current'};}
  try{
    await privateDirectory(cacheRoot);let metadata,metadataSource='registry';
    try{const raw=await boundedGet(REGISTRY+'/@promptframe%2fcreation/'+target,{fetchImpl,signal,maxBytes:256*1024,timeoutMs:5000});
      metadata=checkedRuntimeMetadata(JSON.parse(raw),target);
    }catch(e){const prior=await privateJSON(path.join(cacheRoot,'version-'+target+'.json'));if(!prior)throw e;
      metadata=checkedRuntimeMetadata({name:PACKAGE,version:target,dist:prior},target);metadataSource='previously-verified-cache';}
    return{...await prepareVerifiedRuntime(metadata,{cacheRoot,fetchImpl,signal,checkRuntime}),current:false,
      locked:lockedVersion!==undefined,status:'verified',metadataSource};
  }catch(e){
    if(signal?.aborted)throw error('runtime_selection_interrupted');
    if(lockedVersion!==undefined)
      throw new RuntimeSelectionError('bridge_locked_version_unavailable',currentVersion,lockedVersion,policy,'retry_same_fixed_version_in_new_session');
    if(policy&&compareBridgeVersions(currentVersion,policy.minBridge)>=0)
      return{version:currentVersion,current:true,locked:false,status:'update_unavailable_current_compatible'};
    if(policy)assertBridgeCompatible({experimental:{'promptframe.creation':policy}},currentVersion);
    if(e instanceof CreationClientError)throw e;throw error('runtime_selection_unavailable');
  }
}
