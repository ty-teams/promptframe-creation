import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {connectPlatform} from '../lib/connection.mjs';
import {bridgePolicy,sha} from './fixtures/discovery.mjs';

test('actual SDK sends coarse display metadata only after authenticated account initialize; same config reuses it',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'own-client-observation-'));
 const identity={contractVersion:'promptframe-account-identity/v1',platformDigest:sha('own-platform'),accountDigest:sha('own-account')};
 const seen=[];
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'});res.end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
  seen.push({method:body.method,observation:req.headers['x-promptframe-client-observation']});
  const mcp=new Server({name:'own-display-fixture',version:'1.0.0'},{capabilities:{tools:{},experimental:{'promptframe.creation':bridgePolicy,'promptframe.accountIdentity':identity}}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  res.on('close',()=>{void transport.close();void mcp.close();});
  await mcp.connect(transport);await transport.handleRequest(req,res,body);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const credentials={endpoint:`http://127.0.0.1:${server.address().port}/api/mcp`,token:'own-token',clientId:'own-independent-connection',clientName:'Own connection'};
 try{
  for(let i=0;i<2;i++){
   const client=await connectPlatform(credentials,{host:{kind:'codex'},clientConfigFile:path.join(root,'own-config.json')});
   try{await client.listTools();}finally{await client.close();}
  }
  assert(seen.filter(row=>row.method==='initialize').every(row=>row.observation===undefined));
  const observations=seen.filter(row=>row.method==='tools/list').map(row=>JSON.parse(decodeURIComponent(row.observation)));
  assert.equal(observations.length,2);assert.deepEqual(observations[0],observations[1]);
  assert.equal(observations[0].application,'Codex');assert.equal(observations[0].contractVersion,'promptframe-client-observation/v1');
  assert.match(observations[0].instanceId,/^[a-f0-9-]{36}$/);
  assert.doesNotMatch(JSON.stringify(observations),/own-token|own-config|own-platform|hostname|userAgent|127\.0\.0\.1/);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
