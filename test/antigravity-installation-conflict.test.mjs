import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {antigravityInstallationDetails,installForAntigravityUser} from '../lib/antigravity-installation.mjs';

const repoRoot=fileURLToPath(new URL('..',import.meta.url));
const run=promisify(execFile);
const legacyServer={command:'promptframe-creation',args:['bridge','--host','antigravity']};
const unrelatedServer={serverUrl:'https://example.test/mcp',headers:{Authorization:'fixture-secret'}};

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'pf-agy-conflict-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const configRoot=path.join(root,'.gemini','config');
  const mcpFile=path.join(configRoot,'mcp_config.json');
  const configFile=path.join(root,'credentials.json');
  const env={...process.env,ANTIGRAVITY_CONFIG_DIR:configRoot,XDG_DATA_HOME:path.join(root,'data'),PROMPTFRAME_CREATION_CONFIG:configFile};
  await mkdir(configRoot,{recursive:true});
  return {configRoot,mcpFile,env,options:{sourceRoot:repoRoot,configFile,env}};
}

test('Antigravity connect reports the default manual conflict before prompting for a Token',async t=>{
  const {configRoot,mcpFile,env,options}=await fixture(t);
  const original=JSON.stringify({mcpServers:{promptframe:legacyServer,unrelated:unrelatedServer}},null,2)+'\n';
  await writeFile(mcpFile,original);

  await assert.rejects(run(process.execPath,[path.join(repoRoot,'bin','promptframe-creation.mjs'),
    'connect','--host','antigravity','--endpoint','https://example.test/api','--no-open'],{env}),error=>{
    assert.equal(error.code,1);
    assert.equal(error.stdout,'');
    assert.doesNotMatch(error.stderr,/fixture-secret|创作 Token/);
    const details=JSON.parse(error.stderr);
    assert.equal(details.error,'installation.legacy_mcp_entry_requires_review');
    assert.equal(details.mcpConfigFile,mcpFile);
    assert.deepEqual(details.mcpServerNames,['promptframe']);
    assert.match(details.action,/remove the conflicting manual PromptFrame entries.*rerun connect/);
    return true;
  });
  assert.equal(await readFile(mcpFile,'utf8'),original);
  await assert.rejects(access(path.join(configRoot,'plugins')),{code:'ENOENT'});
  await assert.rejects(access(options.configFile),{code:'ENOENT'});
});

test('Antigravity detects the requested server name and an aliased bridge for the same profile',async t=>{
  const {configRoot,mcpFile,options}=await fixture(t);
  const profile='work';
  const aliasedBridge={command:'node',args:['/shared/bin/promptframe-creation.mjs','bridge','--config',options.configFile]};
  const original=JSON.stringify({mcpServers:{
    promptframe:legacyServer,
    'promptframe-creation-work':unrelatedServer,
    'work-video':aliasedBridge,
    'other-video':{...aliasedBridge,args:[...aliasedBridge.args.slice(0,-1),path.join(configRoot,'other.json')]},
  }});
  await writeFile(mcpFile,original);

  await assert.rejects(installForAntigravityUser({...options,profile}),error=>{
    assert.equal(error.message,'installation.legacy_mcp_entry_requires_review');
    assert.deepEqual(antigravityInstallationDetails(error).mcpServerNames,['promptframe-creation-work','work-video']);
    return true;
  });
  assert.equal(await readFile(mcpFile,'utf8'),original);
  await assert.rejects(access(path.join(configRoot,'plugins')),{code:'ENOENT'});
});

test('Antigravity preserves unrelated entries and detects a conflict even on an installed profile',async t=>{
  const {mcpFile,options}=await fixture(t);
  const original=JSON.stringify({mcpServers:{'promptframe-helper':unrelatedServer}});
  await writeFile(mcpFile,original);

  const installed=await installForAntigravityUser(options);
  assert.equal(installed.versionStatus,'installed');
  assert.equal(await readFile(mcpFile,'utf8'),original);
  const marker=path.join(installed.pluginDir,'promptframe-installation.json');
  const previous=await readFile(marker,'utf8');
  const updated=JSON.stringify({mcpServers:{'promptframe-helper':unrelatedServer,custom:{command:'npx',
    args:['--yes','@promptframe/creation@0.3.12','bridge']}}});
  await writeFile(mcpFile,updated);

  await assert.rejects(installForAntigravityUser(options),error=>{
    assert.deepEqual(antigravityInstallationDetails(error).mcpServerNames,['custom']);
    return true;
  });
  assert.equal(await readFile(mcpFile,'utf8'),updated);
  assert.equal(await readFile(marker,'utf8'),previous);
});

test('Antigravity reports malformed MCP configuration before attempting installation',async t=>{
  const {configRoot,mcpFile,options}=await fixture(t);
  const malformed='{"mcpServers":';
  await writeFile(mcpFile,malformed);

  await assert.rejects(installForAntigravityUser(options),error=>{
    assert.equal(error.message,'installation.antigravity_mcp_config_unreadable');
    assert.equal(antigravityInstallationDetails(error).mcpConfigFile,mcpFile);
    return true;
  });
  assert.equal(await readFile(mcpFile,'utf8'),malformed);
  await assert.rejects(access(path.join(configRoot,'plugins')),{code:'ENOENT'});
});
