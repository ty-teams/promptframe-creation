import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createLocalUploadManager} from '../lib/local-upload.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const envelope=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
async function fixture(t,{losePart=false,loseComplete=false,blockPart=false}={}){
  const root=await mkdtemp(path.join(tmpdir(),'creation-upload-')),filePath=path.join(root,'selected.png');
  const bytes=Buffer.alloc(5*1024*1024+113,7);await writeFile(filePath,bytes);
  const parts=new Map(),calls=[],puts=[],sockets=new Set();let session,completeCalls=0,abortCalls=0;
  const server=createServer(async(req,res)=>{
    const number=Number(new URL(req.url,'http://local').pathname.slice(1));puts.push(number);
    if(blockPart){req.resume();return;}
    const chunks=[];for await(const data of req)chunks.push(data);
    const received=Buffer.concat(chunks);parts.set(number,{partNumber:number,etag:'"part-'+number+'"',sizeBytes:received.length});
    assert.deepEqual(received,bytes.subarray((number-1)*5*1024*1024,Math.min(bytes.length,number*5*1024*1024)));
    assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);
    if(losePart&&number===1){losePart=false;req.socket.destroy();return;}
    res.writeHead(200,{etag:'"part-'+number+'"'});res.end();
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address='http://127.0.0.1:'+server.address().port;
  const authorization=()=>({contractVersion:'direct-object-upload.v2',session,
    uploadedParts:[...parts.values()],grants:[1,2].filter(number=>!parts.has(number)).map(number=>({uploadId:session.uploadId,
      assetId:session.assetId,partNumber:number,method:'PUT',url:address+'/'+number+'?private-signature=do-not-store',
      expiresAt:new Date(Date.now()+60_000).toISOString(),requiredHeaders:{}}))});
  const send=async transfer=>{
    calls.push(structuredClone(transfer));
    switch(transfer.action){
      case 'create':session??={...transfer.request,uploadId:'own-upload',assetId:'own-asset',expectedChecksum:transfer.request.expectedChecksum,
        state:'authorized',scope:{projectId:'own-project',sessionId:'own-work'},partSizeBytes:5*1024*1024,partCount:2,
        expiresAt:new Date(Date.now()+30*60_000).toISOString()};
        return envelope({success:true,authorization:authorization()});
      case 'resume':return envelope({success:true,authorization:authorization()});
      case 'inspect':return envelope({success:true,session});
      case 'complete':
        completeCalls++;assert.equal(transfer.request.parts.length,2);session={...session,state:'finalized'};
        if(loseComplete){loseComplete=false;throw Error('Private transport details must not leak');}
        return envelope({success:true,session,jobId:'direct-upload:own-upload'});
      case 'derivation':return envelope({success:true,status:'ready',uploadId:session.uploadId,assetId:session.assetId,
        jobId:'direct-upload:own-upload',asset:{privateUrl:address+'?secret=never-persist'}});
      case 'abort':abortCalls++;session={...session,state:'aborted'};return envelope({success:true,session});
      default:throw Error('unexpected action');
    }
  };
  const scope={platform:'own-platform',account:'own-account',installation:'own-installation',host:'codex',thread:'own-thread',
    projectId:'own-project',sessionId:'own-work'};
  let current=true;
  const binding={assertCurrent:async()=>{if(!current)throw Error('changed');}};
  const manager=createLocalUploadManager({stateRoot:path.join(root,'state')});
  const input={projectId:'own-project',sessionId:'own-work',action:'upload',idempotencyKey:'own-stable-key',filePath};
  const call=(changes={},selectedScope=scope)=>manager.call({input:{...input,...changes},scope:selectedScope,send,binding});
  const settled=async()=>{for(let n=0;n<200;n++){const result=await call({action:'status'});if(result.status!=='transferring')return result;await wait(5);}throw Error('transfer did not settle');};
  t.after(async()=>{await manager.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  return{root,filePath,bytes,manager,call,settled,scope,binding,send,calls,puts,setCurrent:value=>{current=value;},
    counts:()=>({completeCalls,abortCalls})};
}

test('multipart streams only the selected file, persists no path/grant, and observes the same ready asset',async t=>{
  const f=await fixture(t);const accepted=await f.call();assert.equal(accepted.uploadId,'own-upload');
  assert.equal(accepted.fileHost.location,'bridge_host');assert.equal(accepted.status,'transferring');
  const ready=await f.settled();assert.equal(ready.status,'ready');assert.equal(ready.assetId,'own-asset');
  assert.deepEqual(f.puts,[1,2]);assert.equal(f.counts().completeCalls,1);
  assert.equal(ready.file.checksum,'sha256:'+createHash('sha256').update(f.bytes).digest('hex'));
  const folder=path.join(f.root,'state');assert.equal((await stat(folder)).mode&0o077,0);
  const entries=await readdir(folder);assert.equal(entries.filter(x=>x.endsWith('.lock')).length,0);
  const saved=await readFile(path.join(folder,entries.find(x=>x.endsWith('.json'))),'utf8');
  for(const secret of [f.filePath,'private-signature','privateUrl','never-persist'])assert.ok(!saved.includes(secret));
  assert.equal((await stat(path.join(folder,entries.find(x=>x.endsWith('.json'))))).mode&0o077,0);
  assert.ok(f.calls.every(call=>!JSON.stringify(call).includes(f.filePath)));
  await assert.rejects(f.call({action:'status'},{...f.scope,account:'other-account'}),/original_upload_not_found/);
});

test('a lost part ACK pauses once; explicit new-bridge resume observes remote parts and sends only missing bytes',async t=>{
  const f=await fixture(t,{losePart:true});await f.call();
  assert.equal((await f.settled()).status,'paused');assert.deepEqual(f.puts,[1]);
  const calls=f.calls.length;await f.call({action:'status'});assert.deepEqual(f.puts,[1]);
  assert.ok(f.calls.slice(calls).every(call=>call.action==='inspect'));
  await f.manager.close();
  const second=createLocalUploadManager({stateRoot:path.join(f.root,'state')});t.after(()=>second.close());
  const call=action=>second.call({input:{projectId:'own-project',sessionId:'own-work',action,idempotencyKey:'own-stable-key',filePath:f.filePath},
    scope:f.scope,send:f.send,binding:f.binding});
  await call('resume');
  let result;for(let i=0;i<200;i++){result=await call('status');if(result.status!=='transferring')break;await wait(5);}
  assert.equal(result.status,'ready');assert.deepEqual(f.puts,[1,2]);assert.equal(f.counts().completeCalls,1);
});

test('completion lost after commit is observed through the original session without another PUT or complete',async t=>{
  const f=await fixture(t,{loseComplete:true});await f.call();
  const result=await f.settled();assert.equal(result.status,'ready');assert.equal(result.assetId,'own-asset');
  assert.equal(f.counts().completeCalls,1);assert.deepEqual(f.puts,[1,2]);
  await f.call({action:'resume'});assert.equal(f.counts().completeCalls,1);assert.deepEqual(f.puts,[1,2]);
});

test('file change refuses resume instead of mixing new bytes with a completed remote part',async t=>{
  const f=await fixture(t,{losePart:true});await f.call();await f.settled();
  await writeFile(f.filePath,Buffer.alloc(f.bytes.length,9));
  await assert.rejects(f.call({action:'resume'}),/file_changed/);assert.deepEqual(f.puts,[1]);assert.equal(f.counts().completeCalls,0);
});

test('explicit cancel aborts and joins local transfer, then aborts only its original platform session',async t=>{
  const f=await fixture(t,{blockPart:true});await f.call();
  for(let i=0;i<100&&!f.puts.length;i++)await wait(5);
  const result=await f.call({action:'cancel'});assert.equal(result.status,'aborted');
  assert.equal(f.counts().abortCalls,1);assert.equal(f.counts().completeCalls,0);
  assert.deepEqual(f.puts,[1]);assert.equal((await readdir(path.join(f.root,'state'))).some(x=>x.endsWith('.lock')),false);
});

test('bridge shutdown joins IO and retains original resumable session without an implicit platform abort',async t=>{
  const f=await fixture(t,{blockPart:true});await f.call();
  for(let i=0;i<100&&!f.puts.length;i++)await wait(5);
  await f.manager.close();assert.equal(f.counts().abortCalls,0);assert.equal(f.counts().completeCalls,0);
  assert.equal((await readdir(path.join(f.root,'state'))).some(x=>x.endsWith('.lock')),false);
  const saved=JSON.parse(await readFile(path.join(f.root,'state',(await readdir(path.join(f.root,'state'))).find(x=>x.endsWith('.json'))),'utf8'));
  assert.equal(saved.uploadId,'own-upload');assert.equal(saved.phase,'paused');
});
