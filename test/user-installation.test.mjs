import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,writeFile,mkdir,rm,cp,stat,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {installForUser,profileCredentialsPath} from '../lib/user-installation.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));
const json=async f=>JSON.parse(await readFile(f,'utf8'));
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'creation-user-install-'));
 const env={...process.env,XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'config')};delete env.PROMPTFRAME_CREATION_CONFIG;
 let installed=[],catalogRoot,adds=0,checks=0,fail=false,extra=[];
 const runCodex=async args=>{
  if(args[0]==='--version')return 'codex-cli 0.160.0';
  if(args.join(' ')==='mcp list --json'){
   if(extra.length)return JSON.stringify(extra);
   if(!installed.length)return '[]';
   const m=await json(path.join(installed[0].source.path,'.mcp.json'));
   return JSON.stringify(Object.entries(m.mcpServers).map(([name,server])=>({name,transport:{type:'stdio',...server}})));
  }
  if(args[1]==='list')return JSON.stringify({installed});
  if(args[1]==='marketplace'){catalogRoot=args[3];return '{}';}
  if(args[1]==='add'){
   adds++;if(fail)throw Error('fixture_registration_rejected');
   const c=await json(path.join(catalogRoot,'.agents/plugins/marketplace.json')),p=c.plugins[0];
   const dir=path.join(catalogRoot,p.source.path),manifest=await json(path.join(dir,'.codex-plugin/plugin.json'));
   installed=[{pluginId:args[2],version:manifest.version,enabled:true,installed:true,source:{source:'local',path:dir}}];
   return JSON.stringify({pluginId:args[2],version:manifest.version,installedPath:dir});
  }throw Error('unexpected_codex_call');
 };
 return{root,env,runCodex,checkRuntime:async()=>{checks++;},counts:()=>({adds,checks}),setFail:x=>fail=x,
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
  const m=await json(file);Object.values(m.mcpServers)[0].command='/previous-supported-node/bin/node';
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
