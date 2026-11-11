import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {create as createTar,Header} from 'tar';
import path from 'node:path';
import os from 'node:os';
import {checkedRuntimeMetadata,readRuntimeArchive,prepareVerifiedRuntime,selectBridgeRuntime} from '../lib/runtime-bootstrap.mjs';

const integrity=b=>'sha512-'+createHash('sha512').update(b).digest('base64');
const metadata=(archive,version='0.3.0')=>({version,integrity:integrity(archive),tarball:'https://registry.npmjs.org/@promptframe/creation/-/creation-'+version+'.tgz'});
const policy={contractVersion:'creation-bridge-capabilities/v1',minBridge:'0.3.0',recommendedBridge:'0.3.0',
  contentTypes:['text'],blockMaxBytes:400000,responseMaxBytes:2000000};
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'creation-runtime-cache-')),pkg=path.join(root,'source/package');
  const files={'package.json':JSON.stringify({name:'@promptframe/creation',version:'0.3.0',private:false,
    repository:{url:'git+https://github.com/ty-teams/promptframe-creation.git'},scripts:{postinstall:'never-executed'}}),
    'README.md':'Public fixture','LICENSE':'MIT','bin/promptframe-creation.mjs':'process.stdout.write("0.3.0\\n");',
    'dist/cli.mjs':'export {};','dist/THIRD_PARTY_NOTICES.txt':'MIT', 'lib/fixture.mjs':'export {};',
    'skills/video-creation/SKILL.md':'Public guide','skills/creation-setup/SKILL.md':'Setup guide','docs/installing.md':'Install',
    '.codex-plugin/plugin.json':JSON.stringify({name:'promptframe-creation',version:'0.3.0'}),'.mcp.json':'{}'};
  for(const[name,body]of Object.entries(files)){const file=path.join(pkg,name);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,body,{mode:0o600});}
  const chunks=[];for await(const chunk of createTar({cwd:path.join(root,'source'),gzip:true,portable:true,noMtime:true},['package']))chunks.push(chunk);
  const archive=Buffer.concat(chunks),meta=metadata(archive),calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});
    if(url===meta.tarball)return new Response(archive);
    if(url==='https://registry.npmjs.org/@promptframe%2fcreation/0.3.0')return Response.json({name:'@promptframe/creation',version:meta.version,dist:meta});
    return new Response('',{status:404});};
  return{root,cacheRoot:path.join(root,'cache'),archive,meta,calls,fetchImpl,close:()=>rm(root,{recursive:true})};
}
function synthetic(pathname,type='File',body=Buffer.from('x'),linkpath){
  const header=new Header({path:pathname,type,size:type==='File'?body.length:0,mode:0o600,uid:0,gid:0,
    ...(linkpath?{linkpath}:{}),mtime:new Date(0)});header.encode();
  const raw=Buffer.concat([header.block,type==='File'?body:Buffer.alloc(0),
    Buffer.alloc(type==='File'?(512-body.length%512)%512:0),Buffer.alloc(1024)]);
  return gzipSync(raw);
}

test('fixed official package identity, exact version, canonical tarball and SHA512 are mandatory',()=>{
  const archive=Buffer.from('fixture'),meta=metadata(archive);
  assert.deepEqual(checkedRuntimeMetadata({name:'@promptframe/creation',version:'0.3.0',dist:meta},'0.3.0'),meta);
  for(const change of [{name:'other'},{version:'0.4.0'},{dist:{...meta,tarball:'https://private.invalid/tool.tgz'}},
    {dist:{...meta,tarball:meta.tarball+'?token=unsafe'}},{dist:{...meta,integrity:'sha1-unsafe'}}])
    assert.throws(()=>checkedRuntimeMetadata({name:'@promptframe/creation',version:'0.3.0',dist:meta,...change},'0.3.0'),/creation.runtime_registry_identity_invalid/);
});

test('archive integrity and strict parser reject escaping, links, duplicate names and expansion without filesystem writes',async()=>{
  for(const archive of [synthetic('package/../../escape'),synthetic('package/C:/escape'),synthetic('package/lib/NUL'),
    synthetic('package/link','SymbolicLink',Buffer.alloc(0),'../../escape'),
    synthetic('package/link','Link',Buffer.alloc(0),'package/README.md'),
    gzipSync(Buffer.alloc(37*1024*1024))])
    await assert.rejects(readRuntimeArchive(archive,metadata(archive)),/creation.runtime_archive_/);
  const archive=synthetic('package/README.md');
  await assert.rejects(readRuntimeArchive(Buffer.concat([archive,Buffer.from('tamper')]),metadata(archive)),/creation.runtime_integrity_invalid/);
  const files=await readRuntimeArchive(archive,metadata(archive));assert.equal(files[0].body.toString(),'x');
  const unicode=synthetic('package/docs/说明.md');
  assert.equal((await readRuntimeArchive(unicode,metadata(unicode)))[0].path,'docs/说明.md');
});

test('verified runtime is private/immutable, runs only fixed --version and reuses a digest-checked cache',async()=>{
  const f=await fixture();
  try{
    const first=await prepareVerifiedRuntime(f.meta,{cacheRoot:f.cacheRoot,fetchImpl:f.fetchImpl});
    assert.equal(first.reused,false);assert.equal(first.version,'0.3.0');
    const manifest=JSON.parse(await readFile(path.join(first.root,'runtime.json'),'utf8'));
    assert.equal(manifest.integrity,f.meta.integrity);assert.ok(manifest.payload.files.length>=12);
    const count=f.calls.length,second=await prepareVerifiedRuntime(f.meta,{cacheRoot:f.cacheRoot,fetchImpl:f.fetchImpl});
    assert.equal(second.root,first.root);assert.equal(second.reused,true);assert.equal(f.calls.length,count);
    assert.ok(!((await readdir(f.cacheRoot)).some(n=>n.startsWith('.partial')||n==='prepare.lock')));
    await writeFile(path.join(first.root,'lib/fixture.mjs'),'tampered');
    await assert.rejects(prepareVerifiedRuntime(f.meta,{cacheRoot:f.cacheRoot,fetchImpl:f.fetchImpl}),/creation.runtime_cache_invalid/);
    assert.equal(f.calls.length,count,'bad cached bytes are not executed or overwritten');
  }finally{await f.close();}
});

test('two new sessions publish one complete cache and neither performs host registration',async()=>{
  const f=await fixture();let checked=0;
  try{
    const checkRuntime=async()=>{checked++;await new Promise(resolve=>setTimeout(resolve,30));};
    const values=await Promise.all([1,2].map(()=>prepareVerifiedRuntime(f.meta,{cacheRoot:f.cacheRoot,fetchImpl:f.fetchImpl,checkRuntime})));
    assert.equal(values[0].root,values[1].root);assert.equal(checked,1);
    assert.equal(values.filter(x=>!x.reused).length,1);
    assert.ok(!((await readdir(f.cacheRoot)).some(n=>n.startsWith('.partial')||n==='prepare.lock')));
  }finally{await f.close();}
});

test('same version cannot change its recorded integrity before a new cache is exposed',async()=>{
  const f=await fixture();
  try{
    await prepareVerifiedRuntime(f.meta,{cacheRoot:f.cacheRoot,fetchImpl:f.fetchImpl});
    const replacement={...f.meta,integrity:integrity(Buffer.from('another archive'))};let calls=0;
    await assert.rejects(prepareVerifiedRuntime(replacement,{cacheRoot:f.cacheRoot,fetchImpl:async()=>{calls++;throw Error('unexpected');}}),/creation.runtime_registry_identity_conflict/);
    assert.equal(calls,0);
  }finally{await f.close();}
});

test('minimum/explicit locks are checked before fetching; fallback requires a positively compatible current version',async()=>{
  const f=await fixture();let calls=0;const unavailable=async()=>{calls++;return new Response('',{status:404});};
  try{
    await assert.rejects(selectBridgeRuntime({currentVersion:'0.3.0',cacheRoot:f.cacheRoot,fetchImpl:unavailable}),/creation.platform_bridge_policy_unavailable/);
    assert.equal(calls,0,'unknown minimum never becomes a zero-floor fallback');
    const selected=await selectBridgeRuntime({policy:{...policy,recommendedBridge:'0.4.0'},currentVersion:'0.3.0',resolvedVersion:'0.3.0',
      cacheRoot:f.cacheRoot,fetchImpl:unavailable});
    assert.equal(selected.locked,false);assert.equal(selected.version,'0.3.0');assert.equal(calls,0,'internal pin is not a user lock or recursive update');
    await assert.rejects(selectBridgeRuntime({policy,currentVersion:'0.2.7',resolvedVersion:'0.2.7',cacheRoot:f.cacheRoot,fetchImpl:unavailable}),/creation.upgrade_required/);
    await assert.rejects(selectBridgeRuntime({policy,currentVersion:'0.3.0',resolvedVersion:'0.4.0',cacheRoot:f.cacheRoot,fetchImpl:unavailable}),/creation.runtime_selection_identity_invalid/);
    await assert.rejects(selectBridgeRuntime({policy,currentVersion:'0.3.0',lockedVersion:'0.2.7',cacheRoot:f.cacheRoot,fetchImpl:unavailable}),/creation.bridge_locked_below_minimum/);
    assert.equal(calls,0);
    const fallback=await selectBridgeRuntime({policy:{...policy,recommendedBridge:'0.4.0'},currentVersion:'0.3.0',cacheRoot:f.cacheRoot,fetchImpl:unavailable});
    assert.equal(fallback.current,true);assert.equal(fallback.status,'update_unavailable_current_compatible');
    await assert.rejects(selectBridgeRuntime({policy,currentVersion:'0.2.7',cacheRoot:f.cacheRoot,fetchImpl:unavailable}),/creation.upgrade_required/);
    await assert.rejects(selectBridgeRuntime({policy:{...policy,recommendedBridge:'0.4.0'},currentVersion:'0.3.0',lockedVersion:'0.4.0',cacheRoot:f.cacheRoot,fetchImpl:unavailable}),/creation.bridge_locked_version_unavailable/);
  }finally{await f.close();}
});

test('offline metadata can only reuse a previously verified exact cache, never an arbitrary older version',async()=>{
  const f=await fixture();
  try{
    const first=await selectBridgeRuntime({policy,currentVersion:'0.2.7',cacheRoot:f.cacheRoot,fetchImpl:f.fetchImpl});
    assert.equal(first.version,'0.3.0');assert.equal(first.current,false);
    let calls=0;
    const second=await selectBridgeRuntime({policy,currentVersion:'0.2.7',cacheRoot:f.cacheRoot,
      fetchImpl:async()=>{calls++;throw Error('offline');}});
    assert.equal(second.root,first.root);assert.equal(second.reused,true);assert.equal(calls,1);
  }finally{await f.close();}
});

test('preflight failure preserves previous versions and releases only its own staging and lock',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(prepareVerifiedRuntime(f.meta,{cacheRoot:f.cacheRoot,fetchImpl:f.fetchImpl,
      checkRuntime:async()=>{throw Error('own preflight failure');}}),/own preflight failure/);
    assert.deepEqual(await readdir(f.cacheRoot),[]);
  }finally{await f.close();}
});

test('normal startup interruption drains preflight cleanup without publishing a runtime or leaving a lock',async()=>{
  const f=await fixture(),controller=new AbortController();
  try{
    await assert.rejects(prepareVerifiedRuntime(f.meta,{cacheRoot:f.cacheRoot,fetchImpl:f.fetchImpl,signal:controller.signal,
      checkRuntime:async()=>{controller.abort();}}),{name:'AbortError'});
    assert.deepEqual(await readdir(f.cacheRoot),[]);
  }finally{await f.close();}
});
