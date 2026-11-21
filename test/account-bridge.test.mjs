import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeCredentials } from '../lib/credentials.mjs';
import { createAccountAwareBridge } from '../lib/account-bridge.mjs';
import { connectionAccountIdentity } from '../lib/connection.mjs';
import { localAccountKey, recordLocalAuthorization, readSelectedLocalAccount, localAgentDigest } from '../lib/local-accounts.mjs';
import { CLAUDE_HOST_PROOF } from '../lib/claude-host-session.mjs';

const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const identity = name => ({ contractVersion:'promptframe-account-identity/v1', platformDigest:sha('own-platform'),
  accountDigest:sha(JSON.stringify(['own-tenant',name])) });
const A=identity('a'),B=identity('b');
const threadA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',threadB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const creds = name => ({version:1,endpoint:'https://fixture.invalid/api/mcp',token:'pf_create_'+name.repeat(43),
  clientId:'own_installation_'+name.repeat(16),clientName:'Own profile',createdAt:new Date().toISOString()});
const params=(thread,name='observe_account',args={})=>({name,arguments:args,_meta:{threadId:thread}});
const value=result=>JSON.parse(result.content[0].text);

async function fixture(work,{host={kind:'codex'},hostSession}={}){
  const root=await mkdtemp(path.join(tmpdir(),'creation-account-bridge-')),seen=[],closed=[],pending=[];
  const a=creds('a'),b=creds('b'),fileA=path.join(root,'a.json'),fileB=path.join(root,'b.json');
  const makeClient=(credentials,account)=>({
    getServerCapabilities:()=>({experimental:{'promptframe.accountIdentity':account}}),
    listTools:async()=>({tools:[{name:'observe_account',inputSchema:{type:'object',properties:{defer:{type:'boolean'}}},
      _meta:{'promptframe.access':'independent-read'}}]}),
    callTool:async request=>{
      seen.push({account:localAccountKey(account),thread:request._meta?.threadId});
      if(request.arguments?.defer)await new Promise(resolve=>pending.push(resolve));
      return{content:[{type:'text',text:JSON.stringify({account:localAccountKey(account)})}],_meta:{'promptframe.creation':{
        contractVersion:'creation-transport-metadata/v1',platformDigest:account.platformDigest,accountDigest:account.accountDigest,
        installationDigest:sha(credentials.clientId),controllerDigest:sha(credentials.clientId+request._meta.threadId),
        host:{kind:host.kind,threadDigest:sha(request._meta.threadId)},
      }}};
    },
    close:async()=>{closed.push(localAccountKey(account));},
  });
  const primary=makeClient(a,A);
  await writeCredentials(a,fileA);await writeCredentials(b,fileB);
  await recordLocalAuthorization({root,identity:A,client:'creation',configFile:fileA,endpoint:a.endpoint,token:a.token,profile:'a'});
  await recordLocalAuthorization({root,identity:B,client:'creation',configFile:fileB,endpoint:b.endpoint,token:b.token,profile:'b'});
  const connect=async(credentials,{expectedIdentity})=>{
    const account=credentials.token===a.token?A:B,client=makeClient(credentials,account);
    connectionAccountIdentity(client,expectedIdentity);return client;
  };
  const bridge=createAccountAwareBridge(primary,{credentials:a,configFile:fileA,host,hostSession,root,connect});
  try{await work({root,bridge,seen,closed,pending,fileA,fileB,a,b,connect});}
  finally{await bridge.close();await primary.close();await rm(root,{recursive:true,force:true});}
}

test('actual host bridges keep two agents on their chosen accounts for ten calls each; changing one leaves the other file and requests unchanged',()=>fixture(async f=>{
  const originalA=await readFile(f.fileA),originalB=await readFile(f.fileB);
  await f.bridge.call(params(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(A)}));
  await f.bridge.call(params(threadB,'promptframe_local_select_account',{identityKey:localAccountKey(B)}));
  const agentB={kind:'codex',sessionId:threadB};
  const choiceB=await readFile(path.join(f.root,'selections','codex-'+localAgentDigest(agentB).slice(7)+'.json'));
  for(let i=0;i<10;i++){
    assert.equal(value(await f.bridge.call(params(threadA))).account,localAccountKey(A));
    assert.equal(value(await f.bridge.call(params(threadB))).account,localAccountKey(B));
  }
  await f.bridge.call(params(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(B)}));
  for(let i=0;i<10;i++){
    assert.equal(value(await f.bridge.call(params(threadA))).account,localAccountKey(B));
    assert.equal(value(await f.bridge.call(params(threadB))).account,localAccountKey(B));
  }
  assert.deepEqual(await readFile(path.join(f.root,'selections','codex-'+localAgentDigest(agentB).slice(7)+'.json')),choiceB);
  assert.deepEqual(await readFile(f.fileA),originalA);assert.deepEqual(await readFile(f.fileB),originalB);
  assert.equal(f.seen.filter(row=>row.thread===threadA&&row.account===localAccountKey(A)).length,10);
  assert.equal(f.seen.filter(row=>row.thread===threadB&&row.account===localAccountKey(B)).length,20);
  assert.deepEqual(f.closed,[],'selection must not close any previous connection');
}));

test('an in-flight A request keeps its original result after this agent selects B; subsequent requests use B once',()=>fixture(async f=>{
  const original=f.bridge.call(params(threadA,'observe_account',{defer:true}));
  while(!f.pending.length)await new Promise(resolve=>setImmediate(resolve));
  await f.bridge.call(params(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(B)}));
  assert.deepEqual(f.closed,[]);f.pending[0]();
  assert.equal(value(await original).account,localAccountKey(A));
  assert.equal(value(await f.bridge.call(params(threadA))).account,localAccountKey(B));
  assert.equal(f.seen.length,2,'no replay of the original request');
}));

test('missing creation grant, changed token, absent host and forged authority cannot change the current selection or forward a business call',()=>fixture(async f=>{
  await f.bridge.call(params(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(A)}));
  const before=await readSelectedLocalAccount({root:f.root,agent:{kind:'codex',sessionId:threadA}});
  await writeCredentials({...f.b,token:'pf_create_'+'c'.repeat(43)},f.fileB);
  await assert.rejects(f.bridge.call(params(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(B)})),/accounts.reference_changed/);
  await assert.rejects(f.bridge.call({name:'promptframe_local_select_account',arguments:{identityKey:localAccountKey(B)}}),/creation.host_identity_required/);
  await assert.rejects(f.bridge.call(params(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(B),token:'forged'})),/creation.transport_authority_managed_by_bridge/);
  await assert.rejects(f.bridge.call(params(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(identity('no-grant'))})),/accounts.creation_authorization_missing/);
  assert.deepEqual(await readSelectedLocalAccount({root:f.root,agent:{kind:'codex',sessionId:threadA}}),before);
  assert.equal(f.seen.length,0);
  const listed=value(await f.bridge.call(params(threadA,'promptframe_local_accounts')));
  assert.equal(listed.accounts.length,2);assert.doesNotMatch(JSON.stringify(listed),/token|configFile|credentialDigest|\.json/);
}));

test('a Claude hook proof is consumed once before choosing the connection, then the same verified binding reaches its host bridge',async()=>{
  let begun=0;
  const hostSession={async begin(raw){begun++;assert.equal(raw.arguments[CLAUDE_HOST_PROOF],'own-proof');
    const{[CLAUDE_HOST_PROOF]:_proof,...args}=raw.arguments;
    return{host:{kind:'claude-code',threadId:threadA},arguments:args,epoch:1,assertCurrent:async()=>{}};
  }};
  await fixture(async f=>{
    const result=await f.bridge.call({name:'observe_account',arguments:{[CLAUDE_HOST_PROOF]:'own-proof'}});
    assert.equal(value(result).account,localAccountKey(A));assert.equal(begun,1);
    assert.equal(f.seen[0].thread,threadA);
  },{host:{kind:'claude-code'},hostSession});
});

test('a missing optional directory keeps the original profile usable; an unreadable selected account never falls back to it',()=>fixture(async f=>{
  const configA=await readFile(f.fileA),configB=await readFile(f.fileB);
  await rm(path.join(f.root,'identities'),{recursive:true});
  assert.equal(value(await f.bridge.call(params(threadA))).account,localAccountKey(A));
  await recordLocalAuthorization({root:f.root,identity:B,client:'creation',configFile:f.fileB,endpoint:f.b.endpoint,token:f.b.token});
  await f.bridge.call(params(threadA,'promptframe_local_select_account',{identityKey:localAccountKey(B)}));
  const calls=f.seen.length;
  await chmod(f.root,0o755);
  try{
    await assert.rejects(f.bridge.call(params(threadA)),/accounts.private_storage_required/);
    await assert.rejects(f.bridge.call(params(threadA,'promptframe_local_accounts')),/accounts.private_storage_required/);
    assert.equal(f.seen.length,calls,'neither selected nor default account receives a business request');
    assert.deepEqual(await readFile(f.fileA),configA);assert.deepEqual(await readFile(f.fileB),configB);
  }finally{await chmod(f.root,0o700);}
}));
