import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,cp,chmod,rename,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {installForClaudeUser} from '../lib/claude-installation.mjs';
import {profileCredentialsPath} from '../lib/user-installation.mjs';
import {resolveClaudeCommand} from '../lib/claude-command.mjs';
import {hostClientName} from '../lib/host-identity.mjs';

const source=fileURLToPath(new URL('..',import.meta.url));
const json=async file=>JSON.parse(await readFile(file,'utf8'));

test('default display names follow the actual host while a shared credential file and custom name remain unchanged',()=>{
  assert.equal(hostClientName('Codex PromptFrame',{kind:'claude-code'}),'Claude Code PromptFrame');
  assert.equal(hostClientName('Claude Code PromptFrame',{kind:'codex'}),'Codex PromptFrame');
  assert.equal(hostClientName('My chosen client',{kind:'claude-code'}),'My chosen client');
});
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'creation-claude-install-')),
    env={...process.env,XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'config'),CLAUDE_CONFIG_DIR:path.join(root,'claude')};
  delete env.PROMPTFRAME_CREATION_CONFIG;
  let plugins=[],markets=[],marketAdds=0,installs=0,checks=0,loss=null,failInstall=false;
  const runClaude=async args=>{
    if(args[0]==='--version')return '2.1.321 (Claude Code)\n';
    if(args[0]==='--help')return 'Commands:\n  plugin|plugins  Manage plugins\n  mcp  Manage servers\n';
    if(args.join(' ')==='plugin list --json')return JSON.stringify(plugins);
    if(args.join(' ')==='plugin marketplace list --json')return JSON.stringify(markets);
    if(args.slice(0,3).join(' ')==='plugin marketplace add'){
      marketAdds++;const dir=args[3],catalog=await json(path.join(dir,'.claude-plugin/marketplace.json'));
      markets=[{name:catalog.name,source:'directory',path:dir,installLocation:dir}];
      if(loss==='market'){loss=null;throw Error('synthetic secret after committed market');}return 'Own progress\n{}\n';
    }
    if(args.slice(0,2).join(' ')==='plugin install'){
      installs++;if(failInstall)throw Error('synthetic unconfirmed install');
      const market=markets[0],catalog=await json(path.join(market.path,'.claude-plugin/marketplace.json')),
        p=catalog.plugins[0],dir=path.join(market.path,p.source),manifest=await json(path.join(dir,'.claude-plugin/plugin.json'));
      // Current Desktop keeps an installation record/cache path separately
      // from the immutable local folder it actually loads.
      plugins=[{id:args[2],scope:'user',version:manifest.version,enabled:true,installPath:path.join(root,'claude-cache',manifest.version),
        readFromFolder:dir,folderVersion:manifest.version}];
      if(loss==='plugin'){loss=null;throw Error('synthetic secret after committed plugin');}return '{}';
    }
    throw Error('unexpected host call '+args[0]);
  };
  return{root,env,runClaude,checkRuntime:async()=>{checks++;},counts:()=>({marketAdds,installs,checks}),
    setLoss:value=>loss=value,setFail:value=>failInstall=value,setPlugins:value=>plugins=value,
    close:()=>rm(root,{recursive:true,force:true})};
}

test('Claude install repeats/concurrent entries keep one user plugin, unchanged Codex state and shared profile credentials',async()=>{
  const f=await fixture();try{
    const options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime};
    const [a,b]=await Promise.all([installForClaudeUser(options),installForClaudeUser(options)]);
    assert.equal(a.versionRoot,b.versionRoot);assert.equal(Number(a.reused)+Number(b.reused),1);
    for(let i=0;i<10;i++)assert.equal((await installForClaudeUser(options)).reused,true);
    assert.deepEqual(f.counts(),{marketAdds:1,installs:1,checks:1});
    assert.equal(a.configFile,profileCredentialsPath('default',f.env));
    assert.equal(a.host,'claude-code');assert.equal(a.pluginInstalled,true);
    const mcp=await json(path.join(a.versionRoot,'.claude-mcp.json'));
    assert.deepEqual(mcp.mcpServers.promptframe.args,['${CLAUDE_PLUGIN_ROOT}/bin/promptframe-creation.mjs','bridge','--config',a.configFile,'--host','claude-code']);
    await assert.rejects(readFile(path.join(f.env.XDG_DATA_HOME,'promptframe-creation/default/current.json')),{code:'ENOENT'});
    await assert.rejects(readFile(a.configFile),{code:'ENOENT'},'installer never creates/rotates credentials');
  }finally{await f.close();}
});

test('each registration write has a persisted phase and committed lost ACK is read before any next write',async()=>{
  for(const phase of['market','plugin']){
    const f=await fixture();try{
      f.setLoss(phase);const options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime};
      await assert.rejects(installForClaudeUser(options),error=>{
        assert.equal(error.message,'installation.registration_unconfirmed_keep_existing');
        assert.ok(!JSON.stringify(error).includes('synthetic secret'));return true;
      });
      const before=f.counts();assert.equal(before.marketAdds,1);assert.equal(before.installs,phase==='plugin'?1:0);
      const installed=await installForClaudeUser(options);assert.equal(installed.registered,true);
      assert.deepEqual(f.counts(),{marketAdds:1,installs:1,checks:1});
    }finally{await f.close();}
  }
});

test('an unknown install is never retried, downgraded or replaced by an MCP fallback',async()=>{
  const f=await fixture();try{
    f.setFail(true);const options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime};
    await assert.rejects(installForClaudeUser(options),/registration_unconfirmed_keep_existing/);
    f.setFail(false);await assert.rejects(installForClaudeUser(options),/registration_unconfirmed_keep_existing/);
    assert.equal(f.counts().installs,1);
  }finally{await f.close();}
});

test('an acknowledged local folder is adopted after lost ACK even when Desktop retains an older cache version',async()=>{
  const f=await fixture();try{
    const options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime};
    f.setLoss('plugin');
    await assert.rejects(installForClaudeUser(options),/registration_unconfirmed_keep_existing/);
    const root=path.join(f.env.XDG_DATA_HOME,'promptframe-creation/default/claude-code');
    const pending=await json(path.join(root,'registration-pending.json'));
    const counts=f.counts();
    const installed={id:pending.pluginId,scope:'user',version:'0.3.0',enabled:true,
      installPath:path.join(f.root,'claude-cache','0.3.0'),readFromFolder:pending.versionRoot,folderVersion:pending.version};
    f.setPlugins([installed]);
    const result=await installForClaudeUser(options);
    assert.equal(result.version,pending.version);assert.equal(result.versionRoot,pending.versionRoot);
    assert.deepEqual(f.counts(),counts,'confirmed folder adoption must not send another registration');
    await assert.rejects(readFile(path.join(root,'registration-pending.json')),{code:'ENOENT'});
    for(const change of [{folderVersion:'invalid'},{readFromFolder:path.join(f.root,'foreign')}]){
      f.setPlugins([{...installed,...change}]);
      await assert.rejects(installForClaudeUser(options),/requires_review|local_registration_unconfirmed/);
      assert.deepEqual(f.counts(),counts);
    }
  }finally{await f.close();}
});

test('scope/source/disabled foreign plugins, legacy MCP and malformed local state never become absence',async()=>{
  for(const change of[{id:'promptframe-creation@foreign',version:'0.3.0',enabled:true,scope:'user',installPath:'/unknown'},
    {id:'promptframe-creation@promptframe-creation-user',version:'0.3.0',enabled:true,scope:'project',installPath:'/unknown'}]){
    const f=await fixture();try{
      f.setPlugins([change]);await assert.rejects(installForClaudeUser({sourceRoot:source,env:f.env,runClaude:f.runClaude}),/existing_registration_requires_review/);
      assert.equal(f.counts().installs,0);
    }finally{await f.close();}
  }
  const f=await fixture();try{
    await mkdir(f.env.CLAUDE_CONFIG_DIR,{recursive:true});
    const config=path.join(f.env.CLAUDE_CONFIG_DIR,'.claude.json');
    await writeFile(config,JSON.stringify({mcpServers:{promptframe:{command:'unknown'}}}));
    await assert.rejects(installForClaudeUser({sourceRoot:source,env:f.env,runClaude:f.runClaude}),/legacy_mcp_entry_requires_review/);
    await writeFile(config,'synthetic private broken state');
    await assert.rejects(installForClaudeUser({sourceRoot:source,env:f.env,runClaude:f.runClaude}),/local_registration_unconfirmed/);
    assert.equal(f.counts().installs,0);
  }finally{await f.close();}
});

test('malformed structured host lists remain unknown rather than authorizing a first registration',async()=>{
  const f=await fixture();try{
    const runClaude=args=>args.join(' ')==='plugin list --json'?Promise.resolve('[{}]'):f.runClaude(args);
    await assert.rejects(installForClaudeUser({sourceRoot:source,env:f.env,runClaude}),/claude_local_registration_unconfirmed/);
    assert.equal(f.counts().installs,0);assert.equal(f.counts().marketAdds,0);
  }finally{await f.close();}
});

test('two profiles retain independent plugin identities while using the canonical per-profile credential path',async()=>{
  const f=await fixture();try{
    const a=await installForClaudeUser({sourceRoot:source,profile:'second',env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime});
    assert.equal(a.pluginId,'promptframe-creation-second@promptframe-creation-user-second');
    assert.equal(a.configFile,profileCredentialsPath('second',f.env));
    assert.equal((await json(path.join(a.versionRoot,'.claude-plugin/plugin.json'))).name,'promptframe-creation-second');
    assert.deepEqual(Object.keys((await json(path.join(a.versionRoot,'.mcp.json'))).mcpServers),['promptframe-second']);
  }finally{await f.close();}
});

test('a registered root replaced by a link is rejected even when the referenced files have matching bytes',async()=>{
  const f=await fixture();try{
    const options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime};
    const actual=await installForClaudeUser(options),moved=actual.versionRoot+'-moved';
    await rename(actual.versionRoot,moved);await symlink(moved,actual.versionRoot,'dir');
    await assert.rejects(installForClaudeUser(options),/claude_installed_files_invalid/);
    assert.equal(f.counts().installs,1);
  }finally{await f.close();}
});

test('reuse preserves the recorded Node command when connect runs through another valid Node path',async()=>{
  const f=await fixture();try{
    const seen=[],options={sourceRoot:source,env:f.env,runClaude:f.runClaude,checkRuntime:f.checkRuntime,
      verifyInstalledRuntime:async(_root,_version,command)=>{seen.push(command);}};
    const first=await installForClaudeUser({...options,nodeCommand:'/own/recorded-node'});
    const reused=await installForClaudeUser({...options,nodeCommand:'/own/new-node'});
    assert.equal(reused.reused,true);assert.equal(reused.recordedRuntimeRetained,true);
    assert.deepEqual(seen,['/own/recorded-node']);assert.equal(f.counts().installs,1);
    assert.equal((await json(path.join(first.versionRoot,'.claude-mcp.json'))).mcpServers.promptframe.command,'/own/recorded-node');
  }finally{await f.close();}
});

test('concurrent entries with different host capabilities cannot register both plugin and fallback for one profile',async()=>{
  const f=await fixture();let attemptedMcp=0,delayed=false;
  try{
    const plugin=args=>{
      if(args.join(' ')==='plugin list --json'&&!delayed){delayed=true;return new Promise(resolve=>setTimeout(()=>resolve(f.runClaude(args)),100));}
      return f.runClaude(args);
    };
    const fallback=args=>{
      if(args[0]==='--help')return Promise.resolve('Commands:\n  mcp Manage servers\n');
      if(args[0]==='mcp'){attemptedMcp++;throw Error('unexpected second registration mode');}
      return f.runClaude(args);
    };
    const first=installForClaudeUser({sourceRoot:source,env:f.env,runClaude:plugin,checkRuntime:f.checkRuntime});
    // The first entry acquires its own mode guard before the second starts.
    for(let i=0;i<100&&!delayed;i++)await new Promise(resolve=>setTimeout(resolve,1));
    const second=installForClaudeUser({sourceRoot:source,env:f.env,runClaude:fallback,checkRuntime:f.checkRuntime});
    const results=await Promise.allSettled([first,second]);
    assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
    assert.match(results[1].reason.message,/registration_unconfirmed_keep_existing/);
    assert.equal(attemptedMcp,0);assert.equal(f.counts().installs,1);
  }finally{await f.close();}
});

test('Desktop remote command discovery uses actual version filenames and refuses ambiguous highest builds',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'creation-claude-path-'));
  try{
    const remote=path.join(root,'.claude/remote/ccd-cli');await mkdir(remote,{recursive:true});
    for(const name of['2.1.300-abcdef','2.1.321-123456']){const file=path.join(remote,name);await writeFile(file,'own fixture');await chmod(file,0o700);}
    assert.equal(await resolveClaudeCommand({env:{PATH:''},homeDirectory:root}),path.join(remote,'2.1.321-123456'));
    await cp(path.join(remote,'2.1.321-123456'),path.join(remote,'2.1.321-abcdef'));
    await assert.rejects(resolveClaudeCommand({env:{PATH:''},homeDirectory:root}),/claude_executable_unconfirmed/);
    await assert.rejects(resolveClaudeCommand({env:{PATH:''},homeDirectory:root,executable:'relative-file'}),/claude_executable_invalid/);
  }finally{await rm(root,{recursive:true,force:true});}
});
