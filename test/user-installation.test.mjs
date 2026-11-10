import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,mkdir,rm,cp,stat,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {installForUser,profileCredentialsPath} from '../lib/user-installation.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));
const sourceVersion=JSON.parse(await readFile(path.join(source,'package.json'),'utf8')).version;
const json=async f=>JSON.parse(await readFile(f,'utf8'));
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'creation-user-install-'));
 const env={...process.env,CODEX_HOME:path.join(root,'codex'),XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'config')};delete env.PROMPTFRAME_CREATION_CONFIG;
 let installed=[],catalogRoot,adds=0,checks=0,fail=false,loseAck=false,extra=[];const catalogs=new Map();
 const runCodex=async args=>{
  if(args[0]==='--version')return 'codex-cli 0.160.0';
  if(args.join(' ')==='mcp list --json'){
   if(extra.length)return JSON.stringify(extra);
   if(!installed.length)return '[]';
   const rows=[];for(const p of installed){const m=await json(path.join(p.source.path,'.mcp.json'));
    rows.push(...Object.entries(m.mcpServers).map(([name,server])=>({name,transport:{type:'stdio',...server}})));}return JSON.stringify(rows);
  }
  if(args.slice(0,3).join(' ')==='plugin marketplace list'){
   for(const p of installed.filter(x=>x.source?.source==='npm')){
    const dir=path.join(root,'catalogs',p.marketplaceName);await mkdir(path.join(dir,'.agents/plugins'),{recursive:true});
    await writeFile(path.join(dir,'.agents/plugins/marketplace.json'),JSON.stringify({plugins:[{name:p.name,source:p.source}]}));catalogs.set(p.marketplaceName,dir);
   }
   return JSON.stringify({marketplaces:[...catalogs].map(([name,root])=>({name,root}))});
  }
  if(args[1]==='list'){assert(args.includes('--marketplace'));return JSON.stringify({installed:installed.filter(x=>x.pluginId.endsWith('@'+args[args.indexOf('--marketplace')+1]))});}
  if(args[1]==='marketplace'){catalogRoot=args[3];catalogs.set((await json(path.join(catalogRoot,'.agents/plugins/marketplace.json'))).name,catalogRoot);return '{}';}
  if(args[1]==='add'){
   adds++;if(fail)throw Error('fixture_registration_rejected');
   const c=await json(path.join(catalogRoot,'.agents/plugins/marketplace.json')),p=c.plugins[0];
   const dir=path.join(catalogRoot,p.source.path),manifest=await json(path.join(dir,'.codex-plugin/plugin.json'));
   installed=installed.filter(x=>x.pluginId!==args[2]);installed.push({pluginId:args[2],version:manifest.version,enabled:true,installed:true,source:{source:'local',path:dir}});
   if(loseAck){loseAck=false;throw Error('synthetic sensitive child error after commit');}
   return JSON.stringify({pluginId:args[2],version:manifest.version,installedPath:dir});
  }throw Error('unexpected_codex_call');
 };
 return{root,env,runCodex,checkRuntime:async()=>{checks++;},counts:()=>({adds,checks}),setFail:x=>fail=x,setLoseAck:x=>loseAck=x,
  setInstalled:x=>installed=x,setMcp:x=>extra=x,
  dispose:()=>rm(root,{recursive:true,force:true})};
}

test('ten repeats and two concurrent entries reuse one complete registered version without credential or repository changes',async()=>{
 const f=await fixture();try{
  const options={sourceRoot:source,env:f.env,runCodex:f.runCodex,checkRuntime:f.checkRuntime};
  const [a,b]=await Promise.all([installForUser(options),installForUser(options)]);
  assert.equal(a.version,b.version);assert.equal(Number(a.reused)+Number(b.reused),1);
  const before=await stat(path.join(a.versionRoot,'dist/cli.mjs'));
  for(let n=0;n<10;n++)assert.equal((await installForUser(options)).reused,true);
  assert.deepEqual(f.counts(),{adds:1,checks:1});
  assert.equal((await stat(path.join(a.versionRoot,'dist/cli.mjs'))).mtimeMs,before.mtimeMs);
  const m=await json(path.join(a.versionRoot,'.mcp.json'));const server=Object.values(m.mcpServers)[0];
  assert.equal(server.args.at(-1),profileCredentialsPath('default',f.env));
  assert(path.isAbsolute(server.args[0]));
  assert.equal((await json(a.currentFile)).version,a.version);
  await assert.rejects(stat(profileCredentialsPath('default',f.env)),{code:'ENOENT'});
 }finally{await f.dispose();}
});

test('committed add with lost ACK is observed by exact pending identity; an uncommitted unknown is never re-added',async()=>{
 for(const committed of [true,false]){
  const f=await fixture();try{
   const opts={sourceRoot:source,env:f.env,runCodex:f.runCodex,checkRuntime:f.checkRuntime};
   if(committed)f.setLoseAck(true);else f.setFail(true);
   await assert.rejects(installForUser(opts),/registration_unconfirmed_keep_existing/);assert.equal(f.counts().adds,1);
   f.setFail(false);
   if(committed){assert.equal((await installForUser(opts)).registered,true);}
   else await assert.rejects(installForUser(opts),e=>e.message==='installation.registration_unconfirmed_keep_existing'&&e.details.action==='inspect_same_registration_no_second_add');
   assert.equal(f.counts().adds,1);
  }finally{await f.dispose();}
 }
});

test('all related official marketplaces are checked; two enabled entries require review without a new registration',async()=>{
 const f=await fixture();try{
  const rows=[];for(const name of ['official-one','official-two']){
   const cached=await copyVersion(path.join(f.env.CODEX_HOME,'plugins/cache',name,'promptframe-creation',sourceVersion),sourceVersion);
   rows.push({pluginId:'promptframe-creation@'+name,name:'promptframe-creation',marketplaceName:name,version:sourceVersion,enabled:true,
    source:{source:'npm',package:'@promptframe/creation',version:sourceVersion,registry:'https://registry.npmjs.org'}});
   f.setMcp([{name:'promptframe',enabled:true,transport:{type:'stdio',command:'node',args:['bin/promptframe-creation.mjs','bridge'],cwd:cached,env_vars:['PROMPTFRAME_CREATION_CONFIG','XDG_CONFIG_HOME']}}]);
  }
  f.setInstalled(rows);await assert.rejects(installForUser({sourceRoot:source,env:f.env,runCodex:f.runCodex}),/existing_registration_requires_review/);
  assert.equal(f.counts().adds,0);
 }finally{await f.dispose();}
});

test('an unknown or disabled related registration is not mistaken for an uninstalled plugin',async()=>{
 const f=await fixture();try{
  for(const enabled of [false,true]){
   f.setInstalled([{pluginId:'promptframe-creation@foreign',name:'promptframe-creation',marketplaceName:'foreign',version:sourceVersion,enabled,
    source:{source:'npm',package:'@promptframe/creation',version:sourceVersion,registry:'https://untrusted.invalid'}}]);
   f.setMcp([{name:'unrelated',transport:{type:'stdio',command:'node',args:[],cwd:f.root}}]);
   await assert.rejects(installForUser({sourceRoot:source,env:f.env,runCodex:f.runCodex}),/existing_registration_requires_review/);
   assert.equal(f.counts().adds,0);
  }
 }finally{await f.dispose();}
});

test('invalid JSON and unavailable local catalog stay unknown and never register or leak child data',async()=>{
 const f=await fixture();try{
  for(const value of ['token=synthetic private malformed JSON',JSON.stringify({marketplaces:[{name:'related',root:path.join(f.root,'missing')} ]})]){
   await assert.rejects(installForUser({sourceRoot:source,env:f.env,runCodex:args=>args[0]==='--version'?'codex-cli 0.160.0':Promise.resolve(value)}),e=>{
    assert(['installation.command_json_unconfirmed','installation.local_catalog_unconfirmed'].includes(e.message));
    assert(!JSON.stringify({message:e.message,details:e.details}).includes('token='));return true;
   });
  }
  assert.equal(f.counts().adds,0);
 }finally{await f.dispose();}
});

test('registration post-read requires the exact effective MCP transport before changing current',async()=>{
 const f=await fixture();try{
  let reads=0;const runCodex=args=>{
   if(args.join(' ')==='mcp list --json'&&++reads>1)return JSON.stringify([{name:'promptframe',enabled:true,transport:{type:'stdio',command:'unknown-wrapper',args:[],cwd:f.root}}]);
   return f.runCodex(args);
  };
  await assert.rejects(installForUser({sourceRoot:source,env:f.env,runCodex,checkRuntime:f.checkRuntime}),/registration_unconfirmed_keep_existing/);
  assert.equal(f.counts().adds,1);await assert.rejects(stat(path.join(f.env.XDG_DATA_HOME,'promptframe-creation/default/current.json')),{code:'ENOENT'});
 }finally{await f.dispose();}
});

test('official npm plugin onboarding reuses the verified cached plugin without a second registration',async()=>{
 const f=await fixture();try{
  f.env.CODEX_HOME=path.join(f.root,'codex');
  const version=JSON.parse(await readFile(path.join(source,'package.json'))).version;
  const cached=path.join(f.env.CODEX_HOME,'plugins/cache/official/promptframe-creation',version);
  await cp(source,cached,{recursive:true,filter:p=>!p.includes('node_modules')&&!p.includes('/.git')});
  const pluginId='promptframe-creation@official';
  const official={pluginId,name:'promptframe-creation',marketplaceName:'official',version,enabled:true,
   source:{source:'npm',package:'@promptframe/creation',version,registry:'https://registry.npmjs.org'}};
  f.setInstalled([official]);
  const mcp={name:'promptframe',enabled:true,transport:{type:'stdio',command:'node',args:['bin/promptframe-creation.mjs','bridge'],cwd:cached,env:null,env_vars:['PROMPTFRAME_CREATION_CONFIG','XDG_CONFIG_HOME']}};
  f.setMcp([mcp]);
  for(let i=0;i<2;i++){
   const x=await installForUser({sourceRoot:source,env:f.env,runCodex:f.runCodex,checkRuntime:f.checkRuntime});
   assert.equal(x.pluginId,pluginId);assert.equal(x.versionRoot,cached);assert.equal(x.registered,true);assert.equal(x.reused,true);
  }
  assert.deepEqual(f.counts(),{adds:0,checks:0});
  f.setMcp([{...mcp,transport:{...mcp.transport,command:'unknown-wrapper'}}]);
  await assert.rejects(installForUser({sourceRoot:source,env:f.env,runCodex:f.runCodex}),/legacy_mcp_entry_requires_review/);
  f.setMcp([mcp]);f.setInstalled([{...official,source:{...official.source,registry:'https://untrusted.example'}}]);
  await assert.rejects(installForUser({sourceRoot:source,env:f.env,runCodex:f.runCodex}),/legacy_mcp_entry_requires_review/);
  assert.equal(f.counts().adds,0);
 }finally{await f.dispose();}
});

test('managed ownership follows the recorded executable rather than the current installer Node path',async()=>{
 const f=await fixture();try{
  const opts={sourceRoot:source,env:f.env,runCodex:f.runCodex,checkRuntime:f.checkRuntime};
  const old=await installForUser(opts),file=path.join(old.versionRoot,'.mcp.json');
  const m=await json(file);const oldNode=path.join(f.root,'previous-node');await symlink(process.execPath,oldNode);
  Object.values(m.mcpServers)[0].command=oldNode;
  await writeFile(file,JSON.stringify(m));
  const readyFile=path.join(old.versionRoot,'installation.json'),ready=await json(readyFile),body=await readFile(file);
  Object.assign(ready.files.find(f=>f.path==='.mcp.json'),{bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
  await writeFile(readyFile,JSON.stringify(ready));
  const before=await readFile(file),result=await installForUser(opts);
  assert.equal(result.reused,true);assert.equal(result.recordedRuntimeRetained,true);assert((await readFile(file)).equals(before));
  const entry=Object.values(m.mcpServers)[0];f.setMcp([{name:'promptframe',transport:{type:'stdio',...entry,command:'/unknown-wrapper'}}]);
  await assert.rejects(installForUser(opts),/legacy_mcp_entry_requires_review/);
 }finally{await f.dispose();}
});

test('failed upgrade keeps the old default and files; another explicit profile has independent fixed config',async()=>{
 const f=await fixture();try{
  const opts={sourceRoot:source,env:f.env,runCodex:f.runCodex,checkRuntime:f.checkRuntime};const old=await installForUser(opts);
  const clone=path.join(f.root,'new-source');await mkdir(clone);
  for(const n of ['package.json','README.md','LICENSE','bin','dist','lib','skills','docs','.codex-plugin','.mcp.json'])await cp(path.join(source,n),path.join(clone,n),{recursive:true});
  const next=old.version.split('.').map(Number);next[2]++;
  for(const file of ['package.json','.codex-plugin/plugin.json']){const p=path.join(clone,file),x=await json(p);x.version=next.join('.');await writeFile(p,JSON.stringify(x));}
  f.setFail(true);await assert.rejects(installForUser({...opts,sourceRoot:clone}),/registration_unconfirmed/);f.setFail(false);
  assert.equal((await json(old.currentFile)).version,old.version);assert((await stat(path.join(old.versionRoot,'dist/cli.mjs'))).isFile());
  const alternate=await installForUser({...opts,profile:'second-account'});
  assert.notEqual(alternate.versionRoot,old.versionRoot);
  const m=await json(path.join(alternate.versionRoot,'.mcp.json'));
  assert.equal(Object.values(m.mcpServers)[0].args.at(-1),profileCredentialsPath('second-account',f.env));
  assert.notEqual(profileCredentialsPath('second-account',f.env),profileCredentialsPath('default',f.env));
 }finally{await f.dispose();}
});

test('incomplete packages, same-version replacement, symlinks and old hosts never replace the working default',async()=>{
 const f=await fixture();try{
  const opts={sourceRoot:source,env:f.env,runCodex:f.runCodex,checkRuntime:f.checkRuntime};const old=await installForUser(opts);
  const clone=path.join(f.root,'bad-source');await mkdir(clone);
  for(const n of ['package.json','README.md','LICENSE','bin','dist','lib','skills','docs','.codex-plugin','.mcp.json'])await cp(path.join(source,n),path.join(clone,n),{recursive:true});
  await writeFile(path.join(clone,'README.md'),'changed same version');
  await assert.rejects(installForUser({...opts,sourceRoot:clone}),/version_content_conflict/);
  await symlink(path.join(source,'README.md'),path.join(clone,'docs','foreign.md'));
  await assert.rejects(installForUser({...opts,sourceRoot:clone}),/package_file_invalid/);
  await assert.rejects(installForUser({...opts,runCodex:async()=> 'codex-cli 0.100.0'}),/codex_0160_required/);
  assert.equal((await json(old.currentFile)).version,old.version);
 }finally{await f.dispose();}
});

async function copyVersion(root,version){
 await mkdir(root,{recursive:true});
 for(const n of ['package.json','README.md','LICENSE','bin','dist','lib','skills','docs','.codex-plugin','.mcp.json'])
  await cp(path.join(source,n),path.join(root,n),{recursive:true});
 for(const file of ['package.json','.codex-plugin/plugin.json']){
  const p=path.join(root,file),x=await json(p);x.version=version;await writeFile(p,JSON.stringify(x));
 }
 // An independent fixture CLI makes the installed-runtime assertion real without
 // constructing another release. No platform/network or credential is needed.
 await writeFile(path.join(root,'bin/promptframe-creation.mjs'),`process.stdout.write('${version}\\n')`);
 return root;
}

test('older npm plugin reports actionable pending upgrade, preserves registration/cache/credentials and never invokes destructive host upgrade',async()=>{
 const f=await fixture();try{
  f.env.CODEX_HOME=path.join(f.root,'codex');
  const version='0.1.1',cached=await copyVersion(path.join(f.env.CODEX_HOME,'plugins/cache/official/promptframe-creation',version),version);
  const official={pluginId:'promptframe-creation@official',name:'promptframe-creation',marketplaceName:'official',version,enabled:true,
   source:{source:'npm',package:'@promptframe/creation',version,registry:'https://registry.npmjs.org'}};
  f.setInstalled([official]);
  f.setMcp([{name:'promptframe',enabled:true,transport:{type:'stdio',command:'node',args:['bin/promptframe-creation.mjs','bridge'],cwd:cached,env_vars:['PROMPTFRAME_CREATION_CONFIG','XDG_CONFIG_HOME']}}]);
  const config=profileCredentialsPath('default',f.env);await mkdir(path.dirname(config),{recursive:true});await writeFile(config,'fixture credential retained');
  const before=await readFile(path.join(cached,'bin/promptframe-creation.mjs'));
  await assert.rejects(installForUser({sourceRoot:source,env:f.env,runCodex:f.runCodex}),e=>{
   assert.equal(e.message,'installation.npm_plugin_upgrade_required');assert.equal(e.details.installedVersion,version);
   assert.equal(e.details.requestedVersion,sourceVersion);
   assert.equal(e.details.action,'upgrade_in_codex_after_active_bridges_finish');return true;
  });
  assert.equal(f.counts().adds,0);assert((await readFile(path.join(cached,'bin/promptframe-creation.mjs'))).equals(before));
  assert.equal(await readFile(config,'utf8'),'fixture credential retained');
 }finally{await f.dispose();}
});

test('newer official npm version is retained without host mutations',async()=>{
 const f=await fixture();try{
  f.env.CODEX_HOME=path.join(f.root,'codex');
  const version='9.0.0',cached=await copyVersion(path.join(f.env.CODEX_HOME,'plugins/cache/official/promptframe-creation',version),version);
  f.setInstalled([{pluginId:'promptframe-creation@official',name:'promptframe-creation',marketplaceName:'official',version,enabled:true,
   source:{source:'npm',package:'@promptframe/creation',version,registry:'https://registry.npmjs.org'}}]);
  f.setMcp([{name:'promptframe',enabled:true,transport:{type:'stdio',command:'node',args:['bin/promptframe-creation.mjs','bridge'],cwd:cached,env_vars:['PROMPTFRAME_CREATION_CONFIG','XDG_CONFIG_HOME']}}]);
  const result=await installForUser({sourceRoot:source,env:f.env,runCodex:f.runCodex});
  assert.equal(result.version,version);assert.equal(result.versionStatus,'newer_retained');assert.equal(f.counts().adds,0);
 }finally{await f.dispose();}
});

test('managed installs do not downgrade even when an older complete package runs connect',async()=>{
 const f=await fixture();try{
  const opts={sourceRoot:source,env:f.env,runCodex:f.runCodex,checkRuntime:f.checkRuntime};
  const current=await installForUser(opts),before=await readFile(current.currentFile);
  const oldSource=await copyVersion(path.join(f.root,'older-source'),'0.1.0');
  const result=await installForUser({...opts,sourceRoot:oldSource});
  assert.equal(result.version,current.version);assert.equal(result.versionStatus,'newer_retained');
  assert.equal(f.counts().adds,1);assert((await readFile(current.currentFile)).equals(before));
 }finally{await f.dispose();}
});

test('missing recorded Node is explicit; restoration reuses the same files and a new version can use current Node',async()=>{
 const f=await fixture();try{
  const opts={sourceRoot:source,env:f.env,runCodex:f.runCodex,checkRuntime:f.checkRuntime};
  const old=await installForUser(opts),file=path.join(old.versionRoot,'.mcp.json'),m=await json(file);
  const missing=path.join(f.root,'removed-node');Object.values(m.mcpServers)[0].command=missing;
  await writeFile(file,JSON.stringify(m));
  const readyFile=path.join(old.versionRoot,'installation.json'),ready=await json(readyFile),body=await readFile(file);
  Object.assign(ready.files.find(x=>x.path==='.mcp.json'),{bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
  await writeFile(readyFile,JSON.stringify(ready));
  const before=await readFile(old.currentFile);
  await assert.rejects(installForUser(opts),/installation.recorded_node_unavailable/);
  assert((await readFile(old.currentFile)).equals(before));assert((await readFile(file)).equals(body));assert.equal(f.counts().adds,1);
  await symlink(process.execPath,missing);
  assert.equal((await installForUser(opts)).reused,true);
  await rm(missing);
  const next=old.version.split('.').map(Number);next[2]++;
  const newSource=await copyVersion(path.join(f.root,'newer-source'),next.join('.'));
  const upgraded=await installForUser({...opts,sourceRoot:newSource});
  assert.equal(upgraded.version,next.join('.'));assert.equal(upgraded.reloadRequired,true);
  assert.equal(Object.values((await json(path.join(upgraded.versionRoot,'.mcp.json'))).mcpServers)[0].command,process.execPath);
  assert((await readFile(file)).equals(body));
 }finally{await f.dispose();}
});
