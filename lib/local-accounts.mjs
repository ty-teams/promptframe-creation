import { constants } from 'node:fs';
import { open, lstat, mkdir, rename, unlink, opendir,link } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CreationClientError } from './credentials.mjs';
import { threadFormat } from './host-identity.mjs';

export const LOCAL_ACCOUNT_DIRECTORY_VERSION = 'promptframe-local-account-directory/v1';
export const LOCAL_AGENT_ACCOUNT_VERSION = 'promptframe-local-agent-account/v1';
const clients = ['creation', 'component-cli'];
const digestFormat = /^sha256:[a-f0-9]{64}$/;
const hexFormat = /^[a-f0-9]{64}$/;
const recordLimit = 16 * 1024;
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const failure = code => new CreationClientError('accounts.' + code);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function localAccountsRoot(env = process.env) {
  return path.resolve(env.PROMPTFRAME_ACCOUNT_DIRECTORY ?? path.join(
    env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'promptframe', 'accounts', 'v1'));
}

export function parseAccountIdentity(value) {
  if (!plain(value) || Object.keys(value).length !== 3
    || value.contractVersion !== 'promptframe-account-identity/v1'
    || !digestFormat.test(value.platformDigest ?? '') || !digestFormat.test(value.accountDigest ?? ''))
    throw failure('identity_invalid');
  return { contractVersion: value.contractVersion, platformDigest: value.platformDigest, accountDigest: value.accountDigest };
}

export function localAccountKey(identity) {
  const value = parseAccountIdentity(identity);
  return value.platformDigest.slice(7) + '-' + value.accountDigest.slice(7);
}

export function localReferenceId(client, configFile) {
  if (!clients.includes(client) || typeof configFile !== 'string' || !path.isAbsolute(configFile))
    throw failure('reference_invalid');
  return hash(JSON.stringify([client, path.resolve(configFile)]));
}

export function localCredentialDigest(token) {
  if (typeof token !== 'string' || !token || token.length > 4096) throw failure('reference_invalid');
  return hash(token);
}

function privateOwner(info, directory = false) {
  const uid = process.getuid?.();
  if (uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0
    || info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()))
    throw failure('private_storage_required');
}

async function directory(file, create = false) {
  if (create) await mkdir(file, { recursive: true, mode: 0o700 });
  try { privateOwner(await lstat(file), true); return true; }
  catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
}

async function ownedPath(root, segments, create = false) {
  if (!await directory(root, create)) return undefined;
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!await directory(current, create)) return undefined;
  }
  return current;
}

async function readJson(file) {
  let fd;
  try {
    fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const before = await fd.stat(); privateOwner(before);
    if (before.size > recordLimit) throw failure('record_too_large');
    const buffer = Buffer.alloc(recordLimit + 1);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    const after = await fd.stat(), current = await lstat(file);
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino) throw failure('reference_changed');
    try { return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
    catch { throw failure('record_invalid'); }
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'ELOOP') throw failure('private_storage_required');
    throw error;
  } finally { await fd?.close(); }
}

async function writeJson(directoryPath, name, value) {
  const payload = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(payload) > recordLimit) throw failure('record_too_large');
  const parent = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const temporary = path.join(directoryPath, '.' + randomUUID() + '.tmp');
  try {
    const owner = await parent.stat(); privateOwner(owner, true);
    const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(payload); await fd.sync(); } finally { await fd.close(); }
    const current = await lstat(directoryPath);
    if (current.dev !== owner.dev || current.ino !== owner.ino) throw failure('reference_changed');
    try { privateOwner(await lstat(path.join(directoryPath, name))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(temporary, path.join(directoryPath, name));
    await parent.sync();
  } finally {
    await parent.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function referencePath(identity, client) {
  const value = parseAccountIdentity(identity);
  if (!clients.includes(client)) throw failure('reference_invalid');
  return ['identities', value.platformDigest.slice(7), value.accountDigest.slice(7), client];
}

function parseReference(value, identity, client, id) {
  const fields = ['contractVersion', 'identity', 'client', 'referenceId', 'configFile', 'endpoint',
    'credentialDigest', 'observedAt', 'expiresAt', 'profile', 'scopes'];
  if (!plain(value) || Object.keys(value).some(key => !fields.includes(key))
    || value.contractVersion !== LOCAL_ACCOUNT_DIRECTORY_VERSION || value.client !== client
    || value.referenceId !== id || localAccountKey(value.identity) !== localAccountKey(identity)
    || typeof value.configFile !== 'string' || value.configFile.length > 4096
    || localReferenceId(client, value.configFile) !== id || !digestFormat.test(value.credentialDigest ?? '')
    || !date(value.observedAt) || value.expiresAt !== undefined && !date(value.expiresAt)
    || value.profile !== undefined && (typeof value.profile !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.profile))
    || value.scopes !== undefined && (!Array.isArray(value.scopes) || value.scopes.length > 20
      || value.scopes.some(scope => typeof scope !== 'string' || !/^[a-z0-9_.:-]{1,100}$/.test(scope))))
    throw failure('record_invalid');
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw failure('record_invalid'); }
  if (typeof value.endpoint !== 'string' || value.endpoint.length > 500 || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || endpoint.protocol !== 'https:'
      && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))
    throw failure('record_invalid');
  return value;
}

/** Called only with identity observed on an authenticated transport. This is
 * discovery metadata, never an authorization proof or a token copy. */
async function recordAuthorization({ root = localAccountsRoot(), identity, client,
  configFile, endpoint, token, observedAt = new Date().toISOString(), expiresAt, profile, scopes }) {
  identity = parseAccountIdentity(identity);
  if (typeof configFile !== 'string' || !path.isAbsolute(configFile)) throw failure('reference_invalid');
  configFile = path.resolve(configFile);
  const referenceId = localReferenceId(client, configFile);
  const record = parseReference({ contractVersion: LOCAL_ACCOUNT_DIRECTORY_VERSION, identity, client,
    referenceId, configFile, endpoint, credentialDigest: localCredentialDigest(token), observedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}), ...(profile !== undefined ? { profile } : {}),
    ...(scopes !== undefined ? { scopes } : {}) }, identity, client, referenceId);
  const parent = await ownedPath(root, referencePath(identity, client), true);
  await writeJson(parent, referenceId.slice(7) + '.json', record);
  return { identityKey: localAccountKey(identity), referenceId };
}

async function readAuthorization({ root = localAccountsRoot(), identity, client, referenceId }) {
  if (!digestFormat.test(referenceId ?? '')) throw failure('reference_invalid');
  const parent = await ownedPath(root, referencePath(identity, client));
  const value = parent ? await readJson(path.join(parent, referenceId.slice(7) + '.json')) : undefined;
  return value === undefined ? undefined : parseReference(value, identity, client, referenceId);
}

/** Private reference data for the owning client, not a model-facing list. */
async function readAuthorizations({ root = localAccountsRoot(), identity, client }) {
  const parent = await ownedPath(root, referencePath(identity, client));
  if (!parent) return [];
  const records = [];
  for (const entry of await entries(parent)) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw failure('record_invalid');
    const value = await readLocalAuthorization({ root, identity, client, referenceId: 'sha256:' + entry.name.slice(0, -5) });
    if (value) records.push(value);
  }
  return records.sort((a,b) => a.referenceId.localeCompare(b.referenceId));
}

async function entries(file) {
  const output = [];
  const handle = await opendir(file);
  for await (const entry of handle) {
    if (entry.name.startsWith('.')) continue;
    if (output.length === 256) throw failure('listing_limit');
    output.push(entry);
  }
  return output;
}

/** No config paths, fingerprints, raw tenant/user ids or tokens leave this view.
 * Stored is a local observation; remote expiry/revocation/scope is rechecked. */
async function listAccounts({ root = localAccountsRoot(), now = Date.now() } = {}) {
  const base = await ownedPath(root, ['identities']);
  if (!base) return { accounts: [], complete: true };
  const accounts = [];
  for (const platform of await entries(base)) {
    if (!hexFormat.test(platform.name)) throw failure('record_invalid');
    const platformPath = await ownedPath(root, ['identities', platform.name]);
    for (const account of await entries(platformPath)) {
      if (!hexFormat.test(account.name) || accounts.length === 256) throw failure('listing_limit');
      const identity = { contractVersion: 'promptframe-account-identity/v1',
        platformDigest: 'sha256:' + platform.name, accountDigest: 'sha256:' + account.name };
      const grants = {};
      for (const client of clients) {
        grants[client] = [];
        const parent = await ownedPath(root, referencePath(identity, client));
        if (!parent) continue;
        for (const entry of await entries(parent)) {
          if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) throw failure('record_invalid');
          const ref = await readLocalAuthorization({ root, identity, client, referenceId: 'sha256:' + entry.name.slice(0, -5) });
          if (!ref) continue;
          grants[client].push({ referenceId: ref.referenceId, ...(ref.profile ? { profile: ref.profile } : {}),
            status: ref.expiresAt && Date.parse(ref.expiresAt) <= now ? 'expired' : 'stored',
            observedAt: ref.observedAt, ...(ref.expiresAt ? { expiresAt: ref.expiresAt } : {}) });
        }
      }
      accounts.push({ identityKey: localAccountKey(identity), identity, grants,
        missingClients: clients.filter(client => !grants[client].some(ref => ref.status === 'stored')) });
    }
  }
  return { accounts, complete: true };
}

export function localAgentDigest(agent) {
  if (!agent || !['codex', 'claude-code', 'antigravity'].includes(agent.kind) || typeof agent.sessionId !== 'string'
    || !threadFormat.test(agent.sessionId)) throw failure('agent_required');
  return hash(JSON.stringify([agent.kind, agent.sessionId.toLowerCase()]));
}

/** The caller supplies identity from the original host transport/hook, never
 * from a business argument. There is no global selected/default account. */
async function selectAccount({ root = localAccountsRoot(), agent, identity }) {
  const agentDigest = localAgentDigest(agent);
  const parent = await ownedPath(root, ['selections'], true);
  const value = { contractVersion: LOCAL_AGENT_ACCOUNT_VERSION, agentKind: agent.kind, agentDigest,
    generation: randomUUID(), identity: parseAccountIdentity(identity), selectedAt: new Date().toISOString() };
  await writeJson(parent, agent.kind + '-' + agentDigest.slice(7) + '.json', value);
  return value;
}

async function readSelectedAccount({ root = localAccountsRoot(), agent }) {
  const agentDigest = localAgentDigest(agent), parent = await ownedPath(root, ['selections']);
  const value = parent ? await readJson(path.join(parent, agent.kind + '-' + agentDigest.slice(7) + '.json')) : undefined;
  if (value === undefined) return undefined;
  if (!plain(value) || Object.keys(value).length !== 6 || value.contractVersion !== LOCAL_AGENT_ACCOUNT_VERSION
    || value.agentKind !== agent.kind || value.agentDigest !== agentDigest || !threadFormat.test(value.generation ?? '')
    || !date(value.selectedAt)) throw failure('record_invalid');
  return { ...value, identity: parseAccountIdentity(value.identity) };
}

const accountIO = operation => async (...args) => {
  try { return await operation(...args); }
  catch (cause) {
    if (cause instanceof CreationClientError) throw cause;
    throw failure(['EACCES','EPERM','ENOTDIR','ELOOP'].includes(cause?.code)
      ? 'private_storage_required' : 'storage_unavailable');
  }
};
export const recordLocalAuthorization = accountIO(recordAuthorization);
export const readLocalAuthorization = accountIO(readAuthorization);
export const readLocalAuthorizations = accountIO(readAuthorizations);
export const listLocalAccounts = accountIO(listAccounts);
export const selectLocalAccount = accountIO(selectAccount);
export const readSelectedLocalAccount = accountIO(readSelectedAccount);

/** Optional, resettable display identity. It is scoped to the authenticated
 * account and this configuration, never a machine fingerprint or credential. */
async function clientObservationInstance({root=localAccountsRoot(),identity,configFile}){
  identity=parseAccountIdentity(identity);
  if(typeof configFile!=='string'||!path.isAbsolute(configFile))throw failure('reference_invalid');
  const parent=await ownedPath(root,['client-observations','v1',identity.platformDigest.slice(7),identity.accountDigest.slice(7)],true);
  const file=path.join(parent,localReferenceId('creation',path.resolve(configFile)).slice(7)+'.json');
  const parse=value=>{
    if(!plain(value)||Object.keys(value).sort().join(',')!=='contractVersion,instanceId'
      ||value.contractVersion!=='promptframe-client-instance/v1'||typeof value.instanceId!=='string'
      ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.instanceId))throw failure('record_invalid');
    return value.instanceId;
  };
  const existing=await readJson(file);if(existing)return parse(existing);
  const value={contractVersion:'promptframe-client-instance/v1',instanceId:randomUUID()};
  const temporary=path.join(parent,'.'+randomUUID()+'.tmp');let fd;
  try{fd=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await fd.writeFile(JSON.stringify(value)+'\n');await fd.sync();await fd.close();fd=undefined;
    // Publish complete bytes without replacing another process's instance.
    await link(temporary,file);
    const directoryHandle=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{privateOwner(await directoryHandle.stat(),true);await directoryHandle.sync();}finally{await directoryHandle.close();}
    return value.instanceId;
  }catch(error){if(error.code==='EEXIST')return parse(await readJson(file));throw error;}
  finally{await fd?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
export const localClientObservationInstance=accountIO(clientObservationInstance);
