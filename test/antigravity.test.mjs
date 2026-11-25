import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
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
const defaultServer='promptframe_pf';
const lazyCall=(ServerName,ToolName,Arguments)=>({name:'call_mcp_tool',args:{ServerName,ToolName,Arguments}});

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
      toolCall:{name:'mcp_promptframe_pf_platform_read_session',args:{projectId:'p1',sessionId:'s1'}},
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
    assert.equal(pluginJson.name,'promptframe');
    assert.equal(pluginJson.version,first.version);
    const mcpJson=JSON.parse(await readFile(path.join(first.pluginDir,'mcp_config.json'),'utf8'));
    assert.equal(mcpJson.mcpServers.pf.command,'/usr/bin/node');
    assert.ok(mcpJson.mcpServers.pf.args.includes('--host'));
    assert.ok(mcpJson.mcpServers.pf.args.includes('antigravity'));
    const hooksJson=JSON.parse(await readFile(path.join(first.pluginDir,'hooks.json'),'utf8'));
    const lifecycle=hooksJson['promptframe-host-identity'];
    assert.match(lifecycle.SessionStart[0].command,/antigravity-host-hook.*--hook-event SessionStart$/);
    assert.match(lifecycle.PreToolUse[0].hooks[0].command,/--mcp-server "promptframe_pf" --hook-event PreToolUse$/);
    assert.match('call_mcp_tool',new RegExp(lifecycle.PreToolUse[0].matcher));
    for(const tool of ['platform_save_brief','platform_upload_file','platform_read_component_source','promptframe_local_select_account']){
      assert.match(`mcp_${first.serverName}_${tool}`,/^[a-zA-Z0-9_-]{1,64}$/);
    }
    const skill=await readFile(path.join(first.pluginDir,'skills/video-creation/SKILL.md'),'utf8');
    assert.ok(skill.length>50);

    // Idempotent second run reuses installation
    const second=await installForAntigravityUser({sourceRoot:repoRoot,profile:'default',configFile,env,nodeCommand:'/usr/bin/node'});
    assert.equal(second.reused,true);
    assert.equal(second.versionStatus,'already_current');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Antigravity lazy calls overwrite inner Arguments and bind each conversation to the exact tool',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'pf-agy-lazy-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await createAntigravityHostSession({configFile:path.join(root,'credentials.json'),root:path.join(root,'sessions')});
  const args={projectId:'default-project',title:'Test blank work'};
  const tool='platform_create_session';
  const out=await store.hook({conversationId:convA,toolCall:lazyCall(defaultServer,tool,args)},'PreToolUse');
  assert.equal(out.decision,'allow');
  const forwarded=out.overwrite.Arguments;
  assert.match(forwarded[CLAUDE_HOST_PROOF],/^[a-f0-9]{64}$/);
  assert.equal(out.overwrite[CLAUDE_HOST_PROOF],undefined);
  assert.deepEqual({...forwarded,[CLAUDE_HOST_PROOF]:undefined},{...args,[CLAUDE_HOST_PROOF]:undefined});
  await assert.rejects(()=>store.begin({name:'platform_read_onboarding',arguments:forwarded}),/host_identity_invalid/);
  await assert.rejects(()=>store.begin({name:tool,arguments:{...forwarded,title:'changed'}}),/host_identity_invalid/);
  assert.deepEqual((await store.begin({name:tool,arguments:forwarded})).host,{kind:'antigravity',threadId:convA});
  await assert.rejects(()=>store.begin({name:tool,arguments:forwarded}),/host_identity_invalid/);

  const future='future.dynamic-tool';
  const noArgs=await store.hook({conversationId:convB,toolCall:lazyCall(defaultServer,future)},'PreToolUse');
  const second=await store.begin({name:future,arguments:noArgs.overwrite.Arguments});
  assert.deepEqual(second.arguments,{});
  assert.deepEqual(second.host,{kind:'antigravity',threadId:convB});
  for(const bad of [lazyCall('unrelated',tool,args),lazyCall('promptframe-creation',tool,args),lazyCall(defaultServer,tool,[])])
    assert.deepEqual(await store.hook({conversationId:convA,toolCall:bad},'PreToolUse'),{decision:'allow'});
});

test('Antigravity SessionStart recovers only a unique matching transcript',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'pf-agy-bound-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await createAntigravityHostSession({configFile:path.join(root,'credentials.json'),root:path.join(root,'sessions')});
  const transcriptA=path.join(root,'a.jsonl'),transcriptB=path.join(root,'b.jsonl');
  const name='platform_create_session',toolCall=lazyCall(defaultServer,name,{projectId:'p'});
  assert.deepEqual(await store.hook({conversationId:convA,transcriptPath:transcriptA},'SessionStart'),{});
  await store.hook({conversationId:convB,transcriptPath:transcriptB},'SessionStart');
  for(const input of [{toolCall},{toolCall,transcriptPath:path.join(root,'missing.jsonl')},{toolCall,transcriptPath:transcriptA,conversationId:'invalid'}])
    assert.deepEqual(await store.hook(input,'PreToolUse'),{decision:'allow'});
  const out=await store.hook({toolCall,transcriptPath:transcriptA},'PreToolUse');
  assert.equal((await store.begin({name,arguments:out.overwrite.Arguments})).host.threadId,convA);
  await store.hook({conversationId:convB,transcriptPath:transcriptA},'SessionStart');
  assert.deepEqual(await store.hook({toolCall,transcriptPath:transcriptA},'PreToolUse'),{decision:'allow'});
});

test('installForAntigravityUser leaves an unowned plugin directory intact',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'pf-agy-unowned-'));
  try{
    const configFile=path.join(dir,'config','credentials.json');
    const env={...process.env,XDG_DATA_HOME:path.join(dir,'data'),ANTIGRAVITY_CONFIG_DIR:path.join(dir,'agy-config')};
    const pluginDir=path.join(env.ANTIGRAVITY_CONFIG_DIR,'plugins','promptframe');
    await mkdir(pluginDir,{recursive:true});
    const manifest=path.join(pluginDir,'plugin.json');
    await writeFile(manifest,'{"name":"promptframe","version":"0.1.0"}');
    await assert.rejects(()=>installForAntigravityUser({sourceRoot:repoRoot,configFile,env}),/managed_installation_invalid/);
    assert.equal(await readFile(manifest,'utf8'),'{"name":"promptframe","version":"0.1.0"}');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('installForAntigravityUser removes owned legacy promptframe-creation plugin directory only',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'pf-agy-migrate-'));
  try{
    const configFile=path.join(dir,'config','credentials.json');
    const env={...process.env,XDG_DATA_HOME:path.join(dir,'data'),ANTIGRAVITY_CONFIG_DIR:path.join(dir,'agy-config')};
    const legacyDir=path.join(env.ANTIGRAVITY_CONFIG_DIR,'plugins','promptframe-creation');
    await mkdir(legacyDir,{recursive:true});
    await writeFile(path.join(legacyDir,'promptframe-installation.json'),JSON.stringify({
      contractVersion:'antigravity-plugin-installation/v1',
      host:'antigravity',
      profile:'default',
      configFile,
      version:'0.3.14',
    }));

    const installed=await installForAntigravityUser({sourceRoot:repoRoot,profile:'default',configFile,env,nodeCommand:'/usr/bin/node'});
    assert.equal(path.basename(installed.pluginDir),'promptframe');
    await assert.rejects(access(legacyDir),{code:'ENOENT'});

    // Unowned legacy directory for another profile is never removed
    const unownedLegacy=path.join(env.ANTIGRAVITY_CONFIG_DIR,'plugins','promptframe-creation-work');
    await mkdir(unownedLegacy,{recursive:true});
    await writeFile(path.join(unownedLegacy,'plugin.json'),'{"name":"promptframe-creation-work"}');
    await installForAntigravityUser({sourceRoot:repoRoot,profile:'work',configFile,env,nodeCommand:'/usr/bin/node'});
    assert.equal(await readFile(path.join(unownedLegacy,'plugin.json'),'utf8'),'{"name":"promptframe-creation-work"}');
  }finally{await rm(dir,{recursive:true,force:true});}
});
