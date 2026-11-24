import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAntigravityHostSession} from '../lib/antigravity-host-session.mjs';
import {installForAntigravityUser} from '../lib/antigravity-installation.mjs';
import {CLAUDE_HOST_PROOF} from '../lib/claude-host-session.mjs';
import {resolveHostIdentity,hostParameters} from '../lib/host-identity.mjs';

const repoRoot=fileURLToPath(new URL('..',import.meta.url));
const convA='11111111-1111-4111-8111-111111111111';
const convB='22222222-2222-4222-8222-222222222222';

test('antigravity host identity resolves explicitly without hijacking default codex',()=>{
  assert.deepEqual(resolveHostIdentity({host:'antigravity',env:{}}),{kind:'antigravity'});
  assert.deepEqual(resolveHostIdentity({env:{ANTIGRAVITY_LS_ADDRESS:'localhost:5387'}}),{kind:'codex'});
  assert.throws(()=>hostParameters({name:'x',arguments:{}},{kind:'antigravity'},'controlled'),/host_identity_unavailable/);
  assert.deepEqual(hostParameters({name:'x',arguments:{}},{kind:'antigravity',threadId:convA},'controlled')._meta,{threadId:convA});
});

test('antigravity host session supports concurrent conversations with one-use proof tickets',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'pf-agy-session-'));
  try{
    const configFile=path.join(dir,'credentials.json');
    const session=await createAntigravityHostSession({configFile,root:path.join(dir,'sessions')});
    const outA=await session.hook({
      conversationId:convA,
      stepIdx:19,
      toolCall:{name:'mcp_promptframe-creation_platform_read_session',args:{projectId:'p1',sessionId:'s1'}},
    });
    const outB=await session.hook({
      hookEventName:'PreToolUse',
      conversationId:convB,
      toolCall:{id:'call-b',name:'platform_call_tool',args:{projectId:'p2',sessionId:'s2'}},
    });
    assert.equal(outA.decision,'allow');
    assert.match(outA.overwrite[CLAUDE_HOST_PROOF],/^[a-f0-9]{64}$/);
    assert.equal(outB.decision,'allow');
    assert.match(outB.overwrite[CLAUDE_HOST_PROOF],/^[a-f0-9]{64}$/);

    assert.deepEqual(await session.hook({
      hookEventName:'PostToolUse',
      conversationId:convA,
      toolCall:{name:'platform_call_tool',args:{}},
    }),{});

    // Non-PromptFrame tool passes through untouched
    const other=await session.hook({
      hookEventName:'PreToolUse',
      conversationId:convA,
      toolCall:{id:'call-c',name:'run_command',args:{CommandLine:'ls'}},
    });
    assert.deepEqual(other,{decision:'allow'});

    // Bridge consumes ticket B first, then A (concurrent out-of-order)
    const boundB=await session.begin({name:'platform_call_tool',arguments:{projectId:'p2',sessionId:'s2',[CLAUDE_HOST_PROOF]:outB.overwrite[CLAUDE_HOST_PROOF]}});
    assert.equal(boundB.host.kind,'antigravity');
    assert.equal(boundB.host.threadId,convB);
    assert.deepEqual(boundB.arguments,{projectId:'p2',sessionId:'s2'});

    // Replay rejected
    await assert.rejects(()=>session.begin({name:'platform_call_tool',arguments:{projectId:'p2',sessionId:'s2',[CLAUDE_HOST_PROOF]:outB.overwrite[CLAUDE_HOST_PROOF]}}),/host_identity_invalid/);

    // Tampered arguments rejected
    await assert.rejects(()=>session.begin({name:'platform_read_session',arguments:{projectId:'p1',sessionId:'tampered',[CLAUDE_HOST_PROOF]:outA.overwrite[CLAUDE_HOST_PROOF]}}),/host_identity_invalid/);

    // Valid A still works after failed tamper attempt? Note: failed attempt threw before deleting ticket.
    const boundA=await session.begin({name:'platform_read_session',arguments:{projectId:'p1',sessionId:'s1',[CLAUDE_HOST_PROOF]:outA.overwrite[CLAUDE_HOST_PROOF]}});
    assert.equal(boundA.host.threadId,convA);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('installForAntigravityUser writes native plugin bundle and is idempotent',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'pf-agy-install-'));
  try{
    const configFile=path.join(dir,'config','credentials.json');
    const env={...process.env,XDG_DATA_HOME:path.join(dir,'data'),ANTIGRAVITY_CONFIG_DIR:path.join(dir,'agy-config')};
    const first=await installForAntigravityUser({sourceRoot:repoRoot,profile:'default',configFile,env,nodeCommand:'/usr/bin/node'});
    assert.equal(first.registered,true);
    assert.equal(first.host,'antigravity');
    assert.equal(first.reused,false);
    assert.equal(first.versionStatus,'installed');

    const pluginJson=JSON.parse(await readFile(path.join(first.pluginDir,'plugin.json'),'utf8'));
    assert.equal(pluginJson.name,'promptframe-creation');
    assert.equal(pluginJson.version,first.version);
    const mcpJson=JSON.parse(await readFile(path.join(first.pluginDir,'mcp_config.json'),'utf8'));
    assert.equal(mcpJson.mcpServers['promptframe-creation'].command,'/usr/bin/node');
    assert.ok(mcpJson.mcpServers['promptframe-creation'].args.includes('--host'));
    assert.ok(mcpJson.mcpServers['promptframe-creation'].args.includes('antigravity'));
    const hooksJson=JSON.parse(await readFile(path.join(first.pluginDir,'hooks.json'),'utf8'));
    assert.ok(hooksJson['promptframe-host-identity'].PreToolUse[0].hooks[0].command.includes('antigravity-host-hook'));
    const skill=await readFile(path.join(first.pluginDir,'skills/video-creation/SKILL.md'),'utf8');
    assert.ok(skill.length>50);

    // Idempotent second run reuses installation
    const second=await installForAntigravityUser({sourceRoot:repoRoot,profile:'default',configFile,env,nodeCommand:'/usr/bin/node'});
    assert.equal(second.reused,true);
    assert.equal(second.versionStatus,'already_current');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('installForAntigravityUser leaves an unowned plugin directory intact',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'pf-agy-unowned-'));
  try{
    const configFile=path.join(dir,'config','credentials.json');
    const env={...process.env,XDG_DATA_HOME:path.join(dir,'data'),ANTIGRAVITY_CONFIG_DIR:path.join(dir,'agy-config')};
    const pluginDir=path.join(env.ANTIGRAVITY_CONFIG_DIR,'plugins','promptframe-creation');
    await mkdir(pluginDir,{recursive:true});
    const manifest=path.join(pluginDir,'plugin.json');
    await writeFile(manifest,'{"name":"promptframe-creation","version":"0.1.0"}');
    await assert.rejects(()=>installForAntigravityUser({sourceRoot:repoRoot,configFile,env}),/managed_installation_invalid/);
    assert.equal(await readFile(manifest,'utf8'),'{"name":"promptframe-creation","version":"0.1.0"}');
  }finally{await rm(dir,{recursive:true,force:true});}
});
