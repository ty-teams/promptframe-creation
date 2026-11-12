import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {writeCredentials} from '../lib/credentials.mjs';
import {credentials,wire,result,threadA,bridgePolicy} from './fixtures/discovery.mjs';

test('built package uploads a selected image through real MCP stdio/HTTP with direct object bytes and exits normally', {timeout:15_000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'creation-local-mcp-')),config=path.join(root,'credentials.json');
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=','base64');
  const selected=path.join(root,'selected.png');await writeFile(selected,bytes);
  const token='pf_create_'+'j'.repeat(43);
  let session,part,putCount=0,controls=[];
  const remote=http.createServer(async(req,res)=>{
    if(req.url==='/part'){
      assert.equal(req.method,'PUT');assert.equal(req.headers.authorization,undefined);
      const chunks=[];for await(const chunk of req)chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),bytes);
      putCount++;part={partNumber:1,etag:'"own-receipt"',sizeBytes:bytes.length};res.writeHead(200,{etag:part.etag});res.end();return;
    }
    if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end();return;}
    assert.equal(req.headers.authorization,'Bearer '+token);
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const message=JSON.parse(Buffer.concat(chunks)),server=new Server({name:'own-upload-platform',version:'1'},
      {capabilities:{tools:{},experimental:{'promptframe.creation':bridgePolicy}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
      {name:'read_work',inputSchema:{type:'object',properties:{}},_meta:{'promptframe.access':'independent-read','promptframe.role':'control-read'}},
      {name:'upload_selected_file',inputSchema:{type:'object',properties:{transfer:{type:'object'}}},
        _meta:{'promptframe.access':'controlled','promptframe.localFileUpload':{contractVersion:'creation-local-file-upload/v1',
          inputSchema:{type:'object',properties:{projectId:{type:'string'},sessionId:{type:'string'},action:{type:'string'},
            filePath:{type:'string'},idempotencyKey:{type:'string'}}}}}},
    ]}));
    server.setRequestHandler(CallToolRequestSchema,async message=>{
      const params=message.params;assert.ok(!JSON.stringify(params).includes(selected));
      let body={};
      if(params.arguments.transfer){const request=params.arguments.transfer;controls.push(request.action);
        if(request.action==='create'){
          session={...request.request,scope:{projectId:'own-project',sessionId:'own-work'},uploadId:'original-upload',assetId:'original-asset',
            state:'authorized',partCount:1,partSizeBytes:5*1024*1024,expiresAt:new Date(Date.now()+1800000).toISOString()};
        }
        if(['create','resume'].includes(request.action))body={success:true,authorization:{contractVersion:'direct-object-upload.v2',session,
          uploadedParts:part?[part]:[],grants:part?[]:[{uploadId:session.uploadId,assetId:session.assetId,partNumber:1,method:'PUT',
            url:'http://127.0.0.1:'+remote.address().port+'/part',expiresAt:new Date(Date.now()+60000).toISOString(),requiredHeaders:{}}]}};
        if(request.action==='complete'){assert.deepEqual(request.request.parts,[part]);session.state='finalized';body={success:true,session,jobId:'direct-upload:original-upload'};}
        if(request.action==='inspect')body={success:true,session};
        if(request.action==='derivation')body={success:true,status:'ready',uploadId:session.uploadId,assetId:session.assetId,jobId:'direct-upload:original-upload'};
      }
      return result(body,wire(params,{editor:{kind:'web'}}));
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    await server.connect(transport);res.on('close',()=>{void server.close().catch(()=>{});});
    await transport.handleRequest(req,res,message);
  });
  const client=new Client({name:'own-upload-host',version:'1'}),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let transport,exit;
  try{
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
    await writeCredentials({...credentials,version:1,token,clientName:'Own upload host',createdAt:new Date().toISOString(),endpoint:'http://127.0.0.1:'+remote.address().port+'/api/mcp'},config);
    const rootSource=fileURLToPath(new URL('..',import.meta.url));
    transport=new StdioClientTransport({command:process.execPath,args:[path.join(rootSource,'bin/promptframe-creation.mjs'),'bridge','--host','codex'],
      env:{...process.env,PROMPTFRAME_CREATION_CONFIG:config},stderr:'pipe'});
    await client.connect(transport);
    const subprocess=transport._process;
    if(subprocess)exit=new Promise(resolve=>subprocess.once('exit',(code,signal)=>resolve({code,signal})));
    const listed=await client.listTools();assert.ok(listed.tools.find(t=>t.name==='upload_selected_file').inputSchema.properties.filePath);
    const call=action=>client.callTool({name:'upload_selected_file',arguments:{projectId:'own-project',sessionId:'own-work',action,
      idempotencyKey:'own-upload-stable',...(action==='upload'?{filePath:selected}:{})},_meta:{threadId:threadA}});
    assert.equal(JSON.parse((await call('upload')).content[0].text).uploadId,'original-upload');
    let value;for(let i=0;i<100;i++){value=JSON.parse((await call('status')).content[0].text);if(value.status==='ready')break;await wait(10);}
    assert.equal(value.status,'ready');assert.equal(value.assetId,'original-asset');assert.equal(putCount,1);
    assert.equal(controls.filter(x=>x==='create').length,1);assert.equal(controls.filter(x=>x==='complete').length,1);
    await client.close();if(exit)assert.deepEqual(await exit,{code:0,signal:null});
  }finally{await client.close();await new Promise(resolve=>remote.close(resolve));await rm(root,{recursive:true,force:true});}
});
