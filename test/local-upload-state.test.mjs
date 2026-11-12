import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readdir,readFile,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {localUploadState} from '../lib/local-upload-state.mjs';

const key='a'.repeat(64);
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'creation-upload-state-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('one upload state lock excludes a second bridge until its original owner releases it',async t=>{
  const root=await fixture(t),store=await localUploadState(root),other=await localUploadState(root);
  const release=await store.lock(key);
  await assert.rejects(other.lock(key),/transfer_owned_by_another_bridge/);
  await release();const second=await other.lock(key);await second();assert.deepEqual(await readdir(root),[]);
});

test('Linux resume retires only the exact dead birth, never an active or reused PID birth', {skip:process.platform!=='linux'},async t=>{
  const root=await fixture(t),store=await localUploadState(root),target=path.join(root,key+'.lock');
  await mkdir(target,{mode:0o700});
  await writeFile(path.join(target,'owner.json'),JSON.stringify({pid:process.pid,birth:{boot:'old-boot',start:'old-birth'},nonce:'b'.repeat(32)}),{mode:0o600});
  const release=await store.lock(key);await release();assert.deepEqual(await readdir(root),[]);
});

test('expired local metadata is bounded and cleared after its retention, while an active transport remains protected',async t=>{
  const root=await fixture(t),now=Date.now(),store=await localUploadState(root,{now:()=>now});
  const record={expiresAt:new Date(now-25*60*60*1000).toISOString(),status:'paused'};
  const release=await store.lock(key);await store.write(key,record);await store.cleanup();
  assert.deepEqual(await store.read(key),record);await release();await store.cleanup();assert.equal(await store.read(key),null);
});

test('state reads refuse symlinks and group/world readable files, and never follow a signed destination from disk',async t=>{
  const root=await fixture(t),store=await localUploadState(root),outside=path.join(root,'outside');
  await writeFile(outside,'{"token":"private"}',{mode:0o600});
  await symlink(outside,path.join(root,key+'.json'));
  await assert.rejects(store.read(key),/recovery_state_unavailable/);
  assert.equal(await readFile(outside,'utf8'),'{"token":"private"}');
  const second='c'.repeat(64);await writeFile(path.join(root,second+'.json'),'{}',{mode:0o644});
  await assert.rejects(store.read(second),/recovery_state_unavailable/);
});
