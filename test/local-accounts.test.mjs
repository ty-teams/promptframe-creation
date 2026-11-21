import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, chmod, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { localAccountsRoot, localAccountKey, localReferenceId, localCredentialDigest,
  recordLocalAuthorization, readLocalAuthorization, listLocalAccounts,
  selectLocalAccount, readSelectedLocalAccount, localAgentDigest } from '../lib/local-accounts.mjs';
import { connectionAccountIdentity } from '../lib/connection.mjs';

const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const identity = account => ({ contractVersion: 'promptframe-account-identity/v1',
  platformDigest: sha('own-platform'), accountDigest: sha(JSON.stringify(['own-tenant', account])) });
const A = identity('own-a'), B = identity('own-b');
const agentA = { kind: 'codex', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const agentB = { kind: 'claude-code', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const owned = async work => {
  const root = await mkdtemp(path.join(tmpdir(), 'creation-accounts-'));
  try { return await work(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const reference = (root, client = 'creation', account = A) => ({ root, client, identity: account,
  configFile: path.join(root, client + '-own-config.json'), endpoint: 'https://fixture.invalid/api/mcp',
  token: 'owned-private-token-for-control-only', profile: 'own-profile',
  expiresAt: '2030-01-01T00:00:00.000Z', observedAt: '2026-11-21T00:00:00.000Z' });

test('one immutable account groups repeated Creation and CLI registration without copying credentials into safe views', () => owned(async root => {
  const creation = reference(root), cli = reference(root, 'component-cli');
  const writes = await Promise.all(Array.from({ length: 10 }, () => Promise.all([
    recordLocalAuthorization(creation), recordLocalAuthorization(cli),
  ])));
  assert.equal(new Set(writes.flat().map(row => row.identityKey)).size, 1);
  const directory = await listLocalAccounts({ root, now: Date.parse('2026-11-21T00:00:00Z') });
  assert.equal(directory.complete, true); assert.equal(directory.accounts.length, 1);
  const row = directory.accounts[0];
  assert.equal(row.grants.creation.length, 1); assert.equal(row.grants['component-cli'].length, 1);
  assert.deepEqual(row.missingClients, []);
  assert.doesNotMatch(JSON.stringify(directory), /owned-private-token|configFile|credentialDigest|own-tenant|own-config/);
  const stored = await readLocalAuthorization({ root, identity: A, client: 'creation', referenceId: writes[0][0].referenceId });
  assert.equal(stored.configFile, creation.configFile);
  assert.equal(stored.credentialDigest, localCredentialDigest(creation.token));
  const physical = await readFile(path.join(root, 'identities', A.platformDigest.slice(7), A.accountDigest.slice(7),
    'creation', writes[0][0].referenceId.slice(7) + '.json'), 'utf8');
  assert.doesNotMatch(physical, /owned-private-token/);
}));

test('Creation-only, expired CLI and separate platform/tenant keys keep independent authorization reasons', () => owned(async root => {
  await recordLocalAuthorization(reference(root));
  let rows = (await listLocalAccounts({ root, now: Date.parse('2026-11-21T00:00:00Z') })).accounts;
  assert.deepEqual(rows[0].missingClients, ['component-cli']);
  await recordLocalAuthorization({ ...reference(root, 'component-cli'), expiresAt: '2026-11-20T00:00:00.000Z' });
  rows = (await listLocalAccounts({ root, now: Date.parse('2026-11-21T00:00:00Z') })).accounts;
  assert.equal(rows[0].grants['component-cli'][0].status, 'expired');
  assert.deepEqual(rows[0].missingClients, ['component-cli']);
  await recordLocalAuthorization(reference(root, 'creation', { ...A, platformDigest: sha('other-platform') }));
  await recordLocalAuthorization(reference(root, 'creation', { ...A, accountDigest: sha(JSON.stringify(['other-tenant', 'own-a'])) }));
  assert.equal((await listLocalAccounts({ root })).accounts.length, 3);
}));

test('two agents each read ten times and one switches; the other selection remains byte-identical', () => owned(async root => {
  await Promise.all([recordLocalAuthorization(reference(root)), recordLocalAuthorization(reference(root, 'creation', B))]);
  await selectLocalAccount({ root, agent: agentA, identity: A });
  await selectLocalAccount({ root, agent: agentB, identity: B });
  const fileB = path.join(root, 'selections', agentB.kind + '-' + localAgentDigest(agentB).slice(7) + '.json');
  const before = await readFile(fileB);
  for (let i = 0; i < 10; i++) {
    assert.deepEqual((await readSelectedLocalAccount({ root, agent: agentA })).identity, A);
    assert.deepEqual((await readSelectedLocalAccount({ root, agent: agentB })).identity, B);
  }
  const originalA = await readSelectedLocalAccount({ root, agent: agentA });
  await selectLocalAccount({ root, agent: agentA, identity: B });
  for (let i = 0; i < 10; i++) {
    assert.deepEqual((await readSelectedLocalAccount({ root, agent: agentA })).identity, B);
    assert.deepEqual((await readSelectedLocalAccount({ root, agent: agentB })).identity, B);
  }
  assert.notEqual((await readSelectedLocalAccount({ root, agent: agentA })).generation, originalA.generation);
  assert.deepEqual(await readFile(fileB), before);
  assert.notEqual(localAgentDigest({ ...agentA, kind: 'claude-code' }), localAgentDigest(agentA));
  await assert.rejects(selectLocalAccount({ root, agent: { kind: 'codex' }, identity: A }), /accounts.agent_required/);
  assert.deepEqual(await readFile(fileB), before);
}));

test('metadata cannot cross account or client boundaries and private storage rejects links, public files and malformed records', () => owned(async root => {
  const ref = await recordLocalAuthorization(reference(root));
  assert.equal(await readLocalAuthorization({ root, identity: B, client: 'creation', referenceId: ref.referenceId }), undefined);
  assert.equal(await readLocalAuthorization({ root, identity: A, client: 'component-cli', referenceId: ref.referenceId }), undefined);
  const file = path.join(root, 'identities', A.platformDigest.slice(7), A.accountDigest.slice(7), 'creation', ref.referenceId.slice(7) + '.json');
  await chmod(file, 0o644);
  await assert.rejects(listLocalAccounts({ root }), /accounts.private_storage_required/);
  await chmod(file, 0o600); await writeFile(file, 'null');
  await assert.rejects(listLocalAccounts({ root }), /accounts.record_invalid/);
  await writeFile(file, ' '.repeat(16 * 1024 + 1));
  await assert.rejects(listLocalAccounts({ root }), /accounts.record_too_large/);
  await rm(file); await symlink(path.join(root, 'private-unrelated.json'), file);
  await assert.rejects(recordLocalAuthorization(reference(root)), /accounts.private_storage_required/);
  await assert.rejects(listLocalAccounts({ root }), /accounts.private_storage_required/);
  await assert.rejects(recordLocalAuthorization({ ...reference(root), identity: { ...A, accountDigest: 'display-name' } }), /accounts.identity_invalid/);
}));

test('configuration path and client define the reference; absent directory does not change legacy profile files', () => owned(async root => {
  assert.equal(localAccountsRoot({ XDG_CONFIG_HOME: root }), path.join(root, 'promptframe', 'accounts', 'v1'));
  assert.equal(localAccountsRoot({ PROMPTFRAME_ACCOUNT_DIRECTORY: root }), root);
  assert.deepEqual(await listLocalAccounts({ root: path.join(root, 'not-created') }), { accounts: [], complete: true });
  assert.equal(await readSelectedLocalAccount({ root, agent: agentA }), undefined);
  assert.notEqual(localReferenceId('creation', path.join(root, 'a')), localReferenceId('component-cli', path.join(root, 'a')));
  assert.notEqual(localAccountKey(A), localAccountKey(B));
}));

test('only authenticated initialize metadata can identify a connection; missing legacy capability stays compatible until explicit account selection', () => {
  const legacy = { getServerCapabilities: () => ({}) , accountIdentity: A };
  assert.equal(connectionAccountIdentity(legacy), undefined);
  assert.throws(() => connectionAccountIdentity(legacy, A), /accounts.identity_unavailable/);
  const authenticated = { getServerCapabilities: () => ({ experimental: { 'promptframe.accountIdentity': A } }) };
  assert.deepEqual(connectionAccountIdentity(authenticated, A), A);
  assert.throws(() => connectionAccountIdentity(authenticated, B), /accounts.account_mismatch/);
  assert.throws(() => connectionAccountIdentity(authenticated, { ...A, platformDigest: sha('other-platform') }), /accounts.platform_mismatch/);
  const malformed = { getServerCapabilities: () => ({ experimental: { 'promptframe.accountIdentity': { ...A, token: 'not-identity' } } }) };
  assert.throws(() => connectionAccountIdentity(malformed), /accounts.identity_invalid/);
});

test('a FIFO in place of a private account selection is rejected without waiting for a writer',
  {skip:process.platform==='win32'},()=>owned(async root=>{
    await selectLocalAccount({root,agent:agentA,identity:A});
    const file=path.join(root,'selections',agentA.kind+'-'+localAgentDigest(agentA).slice(7)+'.json');
    await rm(file);
    const fifo=spawnSync('mkfifo',['-m','600',file]);assert.equal(fifo.status,0);
    const module=new URL('../lib/local-accounts.mjs',import.meta.url).href;
    const script=`import {readSelectedLocalAccount} from ${JSON.stringify(module)};
      try {await readSelectedLocalAccount(${JSON.stringify({root,agent:agentA})});process.exitCode=1;}
      catch(error) {if(error.message!=='accounts.private_storage_required')throw error;}`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:1500});
    assert.equal(result.error,undefined,'owned fixture reader must not block opening a special file');
    assert.equal(result.status,0,result.stderr);
    const ref=await recordLocalAuthorization(reference(root));
    const catalog=path.join(root,'identities',A.platformDigest.slice(7),A.accountDigest.slice(7),'creation',ref.referenceId.slice(7)+'.json');
    await rm(catalog);assert.equal(spawnSync('mkfifo',['-m','600',catalog]).status,0);
    const cli=spawnSync(process.execPath,[new URL('../bin/promptframe-creation.mjs',import.meta.url).pathname,'accounts','list'],{
      encoding:'utf8',timeout:1500,env:{...process.env,PROMPTFRAME_ACCOUNT_DIRECTORY:root,PROMPTFRAME_CREATION_CONFIG:path.join(root,'own-config.json')},
    });
    assert.equal(cli.error,undefined,'the actual built CLI must reject a special metadata file');
    assert.equal(cli.status,1);assert.match(cli.stderr,/accounts.private_storage_required/);
  }));
