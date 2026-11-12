import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat,unlink,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {registerClaudeFallbackHooks,verifyClaudeFallbackHooks} from '../lib/claude-hook-registration.mjs';
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),'creation-owned-hooks-'));
 const env={CLAUDE_CONFIG_DIR:path.join(root,'claude'),XDG_DATA_HOME:path.join(root,'data')};
 await mkdir(env.CLAUDE_CONFIG_DIR,{mode:0o700});
 const file=path.join(env.CLAUDE_CONFIG_DIR,'settings.json');
 await writeFile(file,JSON.stringify({theme:'dark',hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'own-original-policy'}]}]}}),{mode:0o600});
 const options=async(profile='default')=>{const owned=path.join(root,profile);await mkdir(owned,{mode:0o700});return{root:owned,env,nodeCommand:process.execPath,
  record:{profile,configFile:path.join(root,profile+'-credentials.json'),serverName:'promptframe-'+profile,versionRoot:path.join(owned,'versions','0.3.1')}};};
 return{root,env,file,options,read:async()=>JSON.parse(await readFile(file,'utf8')),close:()=>rm(root,{recursive:true,force:true})};
}
test('two fallback profiles preserve unrelated settings, serialize one settings writer and keep exact hook ownership',async()=>{
 const f=await fixture();try{
  const a=await f.options('first'),b=await f.options('second');
  const results=await Promise.all([registerClaudeFallbackHooks(a),registerClaudeFallbackHooks(b)]);
  const value=await f.read();assert.equal(value.theme,'dark');assert.equal(value.hooks.PreToolUse[0].matcher,'Bash');
  assert.equal(value.hooks.PreToolUse.length,3);
  for(const record of results)assert.equal(await verifyClaudeFallbackHooks(record,f.env),true);
  const before=await stat(f.file);await registerClaudeFallbackHooks(a);assert.equal((await stat(f.file)).ino,before.ino);
  assert.equal((await stat(f.file)).mode&0o777,0o600);
 }finally{await f.close();}
});
test('edited owned hook is retained and refuses overwrite',async()=>{
 const f=await fixture();try{
  const options=await f.options();await registerClaudeFallbackHooks(options);
  const value=await f.read();value.hooks.PreToolUse[1].hooks[0].args.push('own-user-change');
  const body=JSON.stringify(value);await writeFile(f.file,body);
  await assert.rejects(registerClaudeFallbackHooks(options),/claude_hooks_require_review/);
  assert.equal(await readFile(f.file,'utf8'),body);
 }finally{await f.close();}
});
test('committed settings with lost marker ACK is adopted by reading the same entries without rewriting settings',async()=>{
 const f=await fixture();try{
  const options=await f.options(),record=await registerClaudeFallbackHooks(options);
  await writeFile(path.join(options.root,'hooks-pending.json'),JSON.stringify(record),{mode:0o600});
  await unlink(path.join(options.root,'hooks-current.json'));
  const before=await stat(f.file);await registerClaudeFallbackHooks(options);
  assert.equal((await stat(f.file)).ino,before.ino);
  await assert.rejects(stat(path.join(options.root,'hooks-pending.json')),{code:'ENOENT'});
 }finally{await f.close();}
});
test('unknown pending write and symlink settings do not overwrite another file',async()=>{
 for(const kind of['pending','symlink']){
  const f=await fixture();try{
   const options=await f.options(),before=await readFile(f.file,'utf8');
   if(kind==='pending')await writeFile(path.join(options.root,'hooks-pending.json'),'{}',{mode:0o600});
   else{const original=path.join(f.root,'user-owned.json');await writeFile(original,before);await unlink(f.file);await symlink(original,f.file);}
   await assert.rejects(registerClaudeFallbackHooks(options));
   assert.equal(await readFile(f.file,'utf8'),before);
  }finally{await f.close();}
 }
});
