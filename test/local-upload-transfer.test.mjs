import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {openLocalUploadFile,LOCAL_UPLOAD_READ_BYTES} from '../lib/local-upload-file.mjs';
import {uploadGrantedPart} from '../lib/local-upload-transfer.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'creation-part-upload-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=Buffer.alloc(1024*1024+37,13),selected=path.join(root,'own-sample.mp4');
  await writeFile(selected,bytes);const file=await openLocalUploadFile(selected);t.after(()=>file.close());
  const grants=[1,2].map(partNumber=>({uploadId:'upload-own',assetId:'asset-own',partNumber,
    method:'PUT',url:'https://objects.example.invalid/part?signature=PRIVATE',
    expiresAt:new Date(Date.now()+60_000).toISOString(),requiredHeaders:{}}));
  const authorization={contractVersion:'direct-object-upload.v2',session:{uploadId:'upload-own',assetId:'asset-own',
    sizeBytes:bytes.length,expectedChecksum:file.checksum,partSizeBytes:1024*1024,partCount:2,
    expiresAt:new Date(Date.now()+60_000).toISOString(),state:'authorized'},grants};
  return{file,authorization,grants,bytes,options:{expectedUploadId:'upload-own',expectedAssetId:'asset-own'}};
}

test('actual HTTP PUT streams exact parts to the granted object endpoint without platform relay',async t=>{
  const f=await fixture(t),received=[];const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received.push({method:req.method,authorization:req.headers.authorization,cookie:req.headers.cookie,
      length:req.headers['content-length'],bytes:Buffer.concat(chunks)});
    res.writeHead(200,{etag:'"owned-part-'+received.length+'"'});res.end();
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const parts=[];
  for(const grant of f.grants){grant.url='http://127.0.0.1:'+server.address().port+'/object/'+grant.partNumber+'?signature=PRIVATE';
    parts.push(await uploadGrantedPart(f.file,f.authorization,grant,f.options));}
  assert.deepEqual(Buffer.concat(received.map(x=>x.bytes)),f.bytes);
  assert(received.every(x=>x.method==='PUT'&&x.authorization===undefined&&x.cookie===undefined));
  assert.deepEqual(parts.map(x=>x.sizeBytes),[1024*1024,37]);
  assert.deepEqual(received.map(x=>Number(x.length)),parts.map(x=>x.sizeBytes));
});

test('scope, checksum, grant identity, expiry and signed lengths reject before transport',async t=>{
  const f=await fixture(t);let calls=0;
  for(const mutate of [
    x=>{x.authorization.session.assetId='other';},x=>{x.authorization.session.expectedChecksum='sha256:'+'f'.repeat(64);},
    x=>{x.grants[0].uploadId='other';},x=>{x.grants[0].expiresAt='2020-01-01T00:00:00.000Z';},
    x=>{x.grants[0].requiredHeaders={'content-length':'1'};},
    x=>{x.grants[0].requiredHeaders={authorization:'Bearer PRIVATE'};},
  ]){
    const authorization=structuredClone(f.authorization),x={authorization,grants:authorization.grants};mutate(x);
    await assert.rejects(uploadGrantedPart(f.file,authorization,x.grants[0],{...f.options,fetch:async()=>{calls++;}}),
      error=>error.message.startsWith('creation.local_upload.'));
  }
  assert.equal(calls,0);
});

test('network uncertainty never replays PUT or exposes its signed target',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects(uploadGrantedPart(f.file,f.authorization,f.grants[0],{...f.options,
    fetch:async()=>{calls++;throw Error('https://objects.example.invalid?signature=PRIVATE');}}),error=>{
      assert.equal(error.message,'creation.local_upload.part_transfer_unconfirmed');return true;});
  assert.equal(calls,1);await f.file.assertUnchanged();
});

test('a missing ETag remains unconfirmed and the stream stays bounded',async t=>{
  const f=await fixture(t);let maximum=0,calls=0;
  await assert.rejects(uploadGrantedPart(f.file,f.authorization,f.grants[0],{...f.options,
    fetch:async(_url,{body,redirect,duplex})=>{
      calls++;assert.equal(redirect,'error');assert.equal(duplex,'half');
      for await(const bytes of body)maximum=Math.max(maximum,bytes.length);
      return new Response(null,{status:200});
    }}),/part_receipt_unconfirmed/);
  assert.equal(calls,1);assert(maximum<=LOCAL_UPLOAD_READ_BYTES);
});
