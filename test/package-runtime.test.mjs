import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {pack} from '../scripts/package-release.mjs';

test('npm pack/unpack alone contains a runnable bridge, both Skills and no external install step',async()=>{
 const tmp=await mkdtemp(path.join(os.tmpdir(),'creation-cold-package-'));
 try{
  const artifact=await pack(tmp);
  execFileSync('tar',['-xzf',path.join(tmp,artifact.filename),'-C',tmp]);
  const root=path.join(tmp,'package');
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  for(const file of ['README.md','skills/creation-setup/SKILL.md','docs/installing.md']){
   const body=await readFile(path.join(root,file),'utf8');
   for(const match of body.matchAll(/@promptframe\/creation@(\d+\.\d+\.\d+) connect/g))assert.equal(match[1],pkg.version);
  }
  await assert.rejects(access(path.join(root,'node_modules')));
  const output=execFileSync(process.execPath,[path.join(root,'bin/promptframe-creation.mjs'),'--help'],{
   cwd:tmp,encoding:'utf8',env:{...process.env,XDG_CONFIG_HOME:path.join(tmp,'config')},
  });
  assert(output.includes('promptframe-creation connect'));
  for(const name of ['skills/creation-setup/SKILL.md','skills/video-creation/SKILL.md','.mcp.json','.claude-mcp.json','.claude-plugin/plugin.json','.claude-plugin/marketplace.json'])
   assert((await readFile(path.join(root,name))).length>0);
 }finally{await rm(tmp,{recursive:true,force:true});}
});
