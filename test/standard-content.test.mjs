import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {writeCredentials} from '../lib/credentials.mjs';
import {bridgePolicy} from './fixtures/discovery.mjs';

test('ordinary MCP initialization carries an image through real stdio/HTTP while explicit restrictions stay text',{
  timeout:30000,
},async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const temporary=await mkdtemp(path.join(os.tmpdir(),'creation-standard-content-'));
  const config=path.join(temporary,'credentials.json'),seen=[];let standardContent=true;
  const token='pf_create_'+'j'.repeat(43);
  const image={type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='};
  const remote=http.createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    const server=new Server({name:'own-standard-content',version:'1'},
      {capabilities:{tools:{},experimental:{'promptframe.creation':{...bridgePolicy,
        ...(standardContent?{standardContentTypes:['text','image','resource']}:{})}}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'read_fixture',
      inputSchema:{type:'object',properties:{}},_meta:{'promptframe.access':'independent-read'}}]}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{
      assert.equal(request.params.name,'read_fixture');
      const types=JSON.parse(req.headers['x-promptframe-content-types']);
      seen.push({types,source:req.headers['x-promptframe-content-source']});
      return{content:types.includes('image')?[image]:[{type:'text',text:'Original image is available.'}]};
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    await server.connect(transport);res.on('close',()=>{void server.close().catch(()=>{});});
    await transport.handleRequest(req,res,body);
  });
  try{
    await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
    await writeCredentials({version:1,endpoint:'http://127.0.0.1:'+remote.address().port+'/api/mcp',token,
      clientId:'own_standard_installation_001',clientName:'Own fixture',createdAt:new Date().toISOString()},config);
    for(const sample of [
      {capabilities:{roots:{listChanged:true}},type:'image',source:'mcp-protocol'},
      {capabilities:{experimental:{'promptframe.contentTypes':['text']}},type:'text',source:'declared'},
      {capabilities:{experimental:{'promptframe.contentTypes':['image','unknown']}},type:'text',source:'text-fallback'},
      {capabilities:{roots:{}},type:'text',source:'text-fallback',standardContent:false},
      {capabilities:{experimental:{'promptframe.contentTypes':['image']}},type:'image',source:'declared',standardContent:false},
    ]){
      standardContent=sample.standardContent!==false;
      const client=new Client({name:'own-standard-host',version:'1'},{capabilities:sample.capabilities});
      try{
        await client.connect(new StdioClientTransport({command:process.execPath,
          args:[path.join(root,'bin/promptframe-creation.mjs'),'bridge','--host','codex'],
          env:{...process.env,PROMPTFRAME_CREATION_CONFIG:config},stderr:'pipe'}));
        const result=await client.callTool({name:'read_fixture',arguments:{}});
        assert.equal(result.content[0].type,sample.type);
        if(sample.type==='image')assert.deepEqual(result.content[0],image);
        assert.equal(seen.at(-1).source,sample.source);
      }finally{await client.close();}
    }
    assert.equal(seen.length,5,'one read per host/platform pair; no automatic business retry');
    assert.deepEqual(seen[0].types,['text','image','resource']);
  }finally{await new Promise(resolve=>remote.close(resolve));await rm(temporary,{recursive:true});}
});
