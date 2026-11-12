import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm,mkdir,symlink,rename,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openLocalUploadFile,LOCAL_UPLOAD_READ_BYTES} from '../lib/local-upload-file.mjs';

const fixture=async t=>{const root=await mkdtemp(path.join(tmpdir(),'creation-local-upload-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;};
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

test('only the named file is hashed and streamed with bounded chunks across exact part ranges',async t=>{
  const root=await fixture(t),selected=path.join(root,'recording.m4a');
  const bytes=Buffer.alloc(3*1024*1024+17,37);await writeFile(selected,bytes);
  await writeFile(path.join(root,'not-selected'),Buffer.from('private unrelated data'));
  const file=await openLocalUploadFile(selected);
  try{
    assert.equal(file.name,'recording.m4a');assert.equal(file.sizeBytes,bytes.length);
    assert.equal(file.checksum,digest(bytes));
    const received=[];let maximumChunk=0;
    for(const [start,sizeBytes] of [[0,2*1024*1024],[2*1024*1024,1024*1024+17]]){
      for await(const chunk of file.streamPart({start,sizeBytes})){
        maximumChunk=Math.max(maximumChunk,chunk.length);received.push(chunk);
      }
    }
    assert(maximumChunk<=LOCAL_UPLOAD_READ_BYTES);assert.deepEqual(Buffer.concat(received),bytes);
    await file.assertUnchanged();
  }finally{await file.close();}
  await assert.rejects(file.assertUnchanged(),/creation.local_upload.file_closed/);
});

test('file replacement and in-place mutation cannot resume mixed parts',async t=>{
  for(const mutation of ['replace','overwrite']){
    const root=await fixture(t),selected=path.join(root,mutation+'.wav');await writeFile(selected,'original audio');
    const file=await openLocalUploadFile(selected);
    try{
      if(mutation==='replace'){
        const next=path.join(root,'replacement');await writeFile(next,'original audio');await rename(next,selected);
      }else await writeFile(selected,'modified audio');
      await assert.rejects(file.assertUnchanged(),/creation.local_upload.file_changed/);
      await assert.rejects(async()=>{for await(const _ of file.streamPart({start:0,sizeBytes:2})){}},/creation.local_upload.file_changed/);
    }finally{await file.close();}
  }
});

test('directories, symlinks, zero and oversized files fail without revealing a host path',async t=>{
  const root=await fixture(t),selected=path.join(root,'private-name.wav');await writeFile(selected,'audio');
  const link=path.join(root,'selected-link');await symlink(selected,link);
  const empty=path.join(root,'empty');await writeFile(empty,'');
  const directory=path.join(root,'directory');await mkdir(directory);
  for(const [file,options] of [[link,{}],[empty,{}],[directory,{}],[selected,{maxBytes:2}],[path.join(root,'missing'),{}]]){
    await assert.rejects(openLocalUploadFile(file,options),error=>{
      assert(error.message.startsWith('creation.local_upload.'));
      assert(!error.message.includes(root));return true;
    });
  }
  if(process.platform!=='win32')await assert.rejects(openLocalUploadFile('C:\\Users\\owner\\voice.wav'),/path_not_on_bridge_host/);
  assert.equal((await stat(selected)).size,5);
});

test('closing an active body joins the file IO and stops further reads',async t=>{
  const root=await fixture(t),selected=path.join(root,'clip.mp4');await writeFile(selected,Buffer.alloc(2*1024*1024,19));
  const file=await openLocalUploadFile(selected),body=file.streamPart({start:0,sizeBytes:file.sizeBytes});
  body.on('error',()=>{});const iterator=body[Symbol.asyncIterator]();await iterator.next();
  await file.close();assert.equal(body.destroyed,true);await file.close();
  await assert.rejects(file.assertUnchanged(),/file_closed/);
});

test('a cancelled selection opens no upload and emits a safe reason',async t=>{
  const root=await fixture(t),selected=path.join(root,'selected.wav');await writeFile(selected,'own sample');
  const abort=new AbortController();abort.abort();
  await assert.rejects(openLocalUploadFile(selected,{signal:abort.signal}),/file_read_cancelled/);
});
