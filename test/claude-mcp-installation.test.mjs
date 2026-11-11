import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {installForClaudeUser} from '../lib/claude-installation.mjs';
import {profileCredentialsPath} from '../lib/user-installation.mjs';
import {installationFiles} from '../lib/user-installation.mjs';
import {installClaudeMcpFallback,claimSkillDirectory} from '../lib/claude-mcp-installation.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const fallbackOptions=f=>({sourceRoot:source,profile:'default',env:f.env,configFile:profileCredentialsPath('default',f.env),
  runClaude:f.runClaude,checkRuntime:f.checkRuntime,verifyInstalledRuntime:installationFiles.checkInstalledRuntime,nodeCommand:process.execPath});
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'creation-claude-mcp-')),
    env={...process.env,XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'config'),CLAUDE_CONFIG_DIR:path.join(root,'claude')};
  delete env.PROMPTFRAME_CREATION_CONFIG;
  let adds=0,checks=0,loss=false,reject=false,plugin=false;const calls=[];
  const runClaude=async args=>{
    calls.push(args);
    if(args[0]==='--version')return '2.1.321 (Claude Code)\n';
    if(args[0]==='--help')return 'Commands:\n  mcp  Manage servers\n'+(plugin?'  plugin|plugins Manage plugins\n':'');
    assert.deepEqual(args.slice(0,4),['mcp','add-json','--scope','user']);adds++;
    if(reject)throw Error('own unknown write');
    await mkdir(env.CLAUDE_CONFIG_DIR,{recursive:true,mode:0o700});const file=path.join(env.CLAUDE_CONFIG_DIR,'.claude.json');
    let state={};try{state=await json(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    const supplied=JSON.parse(args[5]);
    state.mcpServers={...state.mcpServers,[args[4]]:{args:supplied.args,command:supplied.command,type:supplied.type}};
    await writeFile(file,JSON.stringify(state),{mode:0o600});
    if(loss){loss=false;throw Error('own committed ACK loss');}return 'Added user server';
  };
  return{root,env,runClaude,checkRuntime:async()=>{checks++;},counts:()=>({adds,checks}),calls,
    setLoss:x=>loss=x,setReject:x=>reject=x,setPlugin:x=>plugin=x,close:()=>rm(root,{recursive:true,force:true})};
}

test('MCP fallback installs both managed Skills once, preserves credentials and reports no plugin/session loading',async()=>{
  const f=await fixture();try{
    const options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime};
    const [a,b]=await Promise.all([installForClaudeUser(options),installForClaudeUser(options)]);
    assert.equal(a.versionRoot,b.versionRoot);
    for(let i=0;i<10;i++)assert.equal((await installForClaudeUser(options)).reused,true);
    assert.deepEqual(f.counts(),{adds:1,checks:1});assert.equal(a.pluginInstalled,false);assert.equal(a.pluginEnabled,false);
    assert.equal(a.skillsInstalled,true);assert.equal(a.installationMode,'mcp-and-skills');assert.equal(a.skills.length,2);
    const mcp=(await json(path.join(f.env.CLAUDE_CONFIG_DIR,'.claude.json'))).mcpServers.promptframe;
    assert.deepEqual(mcp.args,[path.join(a.versionRoot,'bin/promptframe-creation.mjs'),'bridge','--config',profileCredentialsPath('default',f.env),'--host','claude-code']);
    for(const skill of a.skills){assert.match(await readFile(path.join(skill.root,'SKILL.md'),'utf8'),new RegExp('\\nname: '+skill.name+'\\n'));}
    await assert.rejects(readFile(a.configFile),{code:'ENOENT'});
    f.setPlugin(true);assert.equal((await installForClaudeUser(options)).installationMode,'mcp-and-skills','new plugin support does not duplicate an existing fallback');
    assert.ok(f.calls.every(args=>args[0]!=='plugin'));
  }finally{await f.close();}
});

test('fallback committed and unknown MCP writes are observed through original local config without another add',async()=>{
  for(const committed of[true,false]){
    const f=await fixture();try{
      if(committed)f.setLoss(true);else f.setReject(true);
      const options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime};
      await assert.rejects(installForClaudeUser(options),/registration_unconfirmed_keep_existing/);
      f.setReject(false);
      if(committed)assert.equal((await installForClaudeUser(options)).registered,true);
      else await assert.rejects(installForClaudeUser(options),/registration_unconfirmed_keep_existing/);
      assert.equal(f.counts().adds,1);
    }finally{await f.close();}
  }
});

test('a previously dispatched plugin install never switches to fallback when plugin commands disappear',async()=>{
  const f=await fixture();try{
    const root=path.join(f.env.XDG_DATA_HOME,'promptframe-creation/default/claude-code');await mkdir(root,{recursive:true});
    await writeFile(path.join(root,'registration-pending.json'),'{}',{mode:0o600});
    await assert.rejects(installForClaudeUser({sourceRoot:source,env:f.env,runClaude:f.runClaude}),/registration_unconfirmed_keep_existing/);
    assert.equal(f.counts().adds,0);
  }finally{await f.close();}
});

test('unowned MCP or Skill definitions are preserved and never overwritten',async()=>{
  for(const kind of['mcp','skill']){
    const f=await fixture();try{
      let file;
      if(kind==='mcp'){
        await mkdir(f.env.CLAUDE_CONFIG_DIR,{recursive:true});file=path.join(f.env.CLAUDE_CONFIG_DIR,'.claude.json');
        await writeFile(file,JSON.stringify({mcpServers:{promptframe:{command:'foreign'}}}));
      }else{
        file=path.join(f.env.CLAUDE_CONFIG_DIR,'skills/creation-setup/SKILL.md');await mkdir(path.dirname(file),{recursive:true,mode:0o700});
        await writeFile(file,'Foreign skill');
      }
      const before=await readFile(file);
      await assert.rejects(installForClaudeUser({sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime}),/requires_review/);
      assert.deepEqual(await readFile(file),before);assert.equal(f.counts().adds,0);
    }finally{await f.close();}
  }
});

test('two fallback profiles have distinct MCP and Skill identities with canonical independent credential paths',async()=>{
  const f=await fixture();try{
    const options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime};
    const a=await installForClaudeUser(options),b=await installForClaudeUser({...options,profile:'second'});
    assert.notEqual(a.configFile,b.configFile);assert.equal(b.configFile,profileCredentialsPath('second',f.env));
    assert.deepEqual(Object.keys((await json(path.join(f.env.CLAUDE_CONFIG_DIR,'.claude.json'))).mcpServers).sort(),['promptframe','promptframe-second']);
    assert.equal(b.skills[0].name,'creation-setup-second');assert.notEqual(a.skills[0].root,b.skills[0].root);
  }finally{await f.close();}
});

test('interruption between Skill files resumes the same pending preparation before the only MCP registration',async()=>{
  const f=await fixture();let writes=0;
  try{
    await assert.rejects(installClaudeMcpFallback({...fallbackOptions(f),writeSkill:async(file,body)=>{
      if(++writes===2)throw Error('own second Skill write interrupted');await writeFile(file,body,{mode:0o600});
    }}),/registration_unconfirmed_keep_existing/);
    assert.equal(f.counts().adds,0);
    const completed=await installClaudeMcpFallback(fallbackOptions(f));
    assert.equal(completed.skillsInstalled,true);assert.equal(f.counts().adds,1);
  }finally{await f.close();}
});

test('a different local MCP registration appearing during Skill preparation is never overwritten',async()=>{
  const f=await fixture();try{
    await assert.rejects(installClaudeMcpFallback({...fallbackOptions(f),writeSkill:async(file,body)=>{
      await writeFile(file,body,{mode:0o600});
      await writeFile(path.join(f.env.CLAUDE_CONFIG_DIR,'.claude.json'),JSON.stringify({mcpServers:{promptframe:{command:'new-foreign-owner'}}}),{mode:0o600});
    }}),/registration_unconfirmed_keep_existing/);
    assert.equal(f.counts().adds,0);
    assert.equal((await json(path.join(f.env.CLAUDE_CONFIG_DIR,'.claude.json'))).mcpServers.promptframe.command,'new-foreign-owner');
  }finally{await f.close();}
});

test('new Skill directories are claimed exclusively; a preexisting or racing directory is never adopted',async()=>{
  const f=await fixture();try{
    const directory=path.join(f.root,'claimed-skill');
    const result=await Promise.allSettled([claimSkillDirectory(directory),claimSkillDirectory(directory)]);
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
    assert.match(result.find(r=>r.status==='rejected').reason.message,/claude_skill_requires_review/);
    const file=path.join(directory,'SKILL.md');await writeFile(file,'foreign new content');
    await assert.rejects(claimSkillDirectory(directory),/claude_skill_requires_review/);
    assert.equal(await readFile(file,'utf8'),'foreign new content');
  }finally{await f.close();}
});
