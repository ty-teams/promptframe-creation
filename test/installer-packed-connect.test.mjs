import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {pack} from '../scripts/package-release.mjs';
const fixture=fileURLToPath(new URL('fixtures/codex-installer.mjs',import.meta.url));
const json=async p=>JSON.parse(await readFile(p,'utf8'));
function childResult(child,input=''){
 return new Promise((resolve,reject)=>{let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));child.stdin.end(input);});
}
test('packed npx/connect stays local while unrelated discovery hangs 60s; replay/concurrency and lost write ACK never add twice',{timeout:100_000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'creation-packed-connect-'));
 const token='pf_create_'+randomBytes(32).toString('base64url');let calls=0,unrelated;
 const server=http.createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  const chunks=[];for await(const b of req)chunks.push(b);const request=JSON.parse(Buffer.concat(chunks));
  const mcp=new Server({name:'own-installer-fixture',version:'1'},{capabilities:{tools:{}}});
  mcp.setRequestHandler(ListToolsRequestSchema,async()=>{calls++;return{tools:[{name:'platform_list_tools',inputSchema:{type:'object'}}]};});
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await mcp.connect(transport);res.once('close',()=>void mcp.close());await transport.handleRequest(req,res,request);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const bin=path.join(root,'bin');await mkdir(bin);await writeFile(path.join(bin,'codex'),`#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`,{mode:0o700});
  const market=path.join(root,'unrelated');await mkdir(path.join(market,'.agents/plugins'),{recursive:true});
  await writeFile(path.join(market,'.agents/plugins/marketplace.json'),JSON.stringify({name:'unrelated',plugins:[{name:'different-plugin',source:{source:'remote'}}]}));
  const stateFile=path.join(root,'state.json');await writeFile(stateFile,JSON.stringify({markets:[{name:'unrelated',root:market}],installed:[],fullQueries:0,marketplaceAdds:0,adds:0}));
  const env={...process.env,HOME:path.join(root,'home'),CODEX_HOME:path.join(root,'codex'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),NPM_CONFIG_CACHE:path.join(root,'npm-cache'),NPM_CONFIG_USERCONFIG:path.join(root,'empty.npmrc'),NPM_CONFIG_IGNORE_SCRIPTS:'true',PATH:bin+path.delimiter+process.env.PATH,CREATION_FIXTURE_STATE:stateFile,CREATION_FIXTURE_SECRET:token};
  for(const k of Object.keys(env))if(/^(?:PROMPTFRAME_CREATION_CONFIG|NODE_AUTH_TOKEN|NPM_TOKEN|NPM_.*(?:TOKEN|PASSWORD)|npm_config_.*(?:auth|token|password))$/i.test(k))delete env[k];
  await mkdir(env.HOME);await writeFile(env.NPM_CONFIG_USERCONFIG,'');
  const artifact=await pack(root),tgz=path.join(root,artifact.filename),endpoint=`http://127.0.0.1:${server.address().port}/api/mcp`;
  const run=async(extra=[],overrides={})=>{
   const start=performance.now();const p=spawn('npm',['exec','--yes','--offline','--package',tgz,'--','promptframe-creation','connect','--endpoint',endpoint,'--no-open','--token-stdin',...extra],{cwd:root,env:{...env,...overrides},stdio:['pipe','pipe','pipe']});
   const result=await childResult(p,token+'\n');assert(!result.stdout.includes(token)&&!result.stderr.includes(token),'no sensitive child output');return{...result,elapsedMs:performance.now()-start};
  };
  const start=performance.now();unrelated=spawn(process.execPath,[fixture,'plugin','list','--json'],{env,stdio:['pipe','pipe','pipe']});
  const unrelatedResult=childResult(unrelated);
  for(let i=0;(await json(stateFile)).fullQueries!==1&&i<100;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await json(stateFile)).fullQueries,1);
  const first=await run();assert.equal(first.code,0,first.stderr);const result=JSON.parse(first.stdout);
  assert.equal(result.pluginInstalled,true);assert.equal(result.pluginEnabled,true);assert.equal(result.hostMcpConnected,'not_verified');assert.equal(result.sessionLoaded,'not_verified');
  const config=path.join(env.XDG_CONFIG_HOME,'promptframe-creation/credentials.json'),before=await readFile(config);
  const repeats=[];for(let i=0;i<10;i++){const x=await run();assert.equal(x.code,0,x.stderr);assert.equal(JSON.parse(x.stdout).installationReused,true);repeats.push(x.elapsedMs);}
  const concurrent=await Promise.all([run(),run()]);for(const x of concurrent)assert.equal(x.code,0,x.stderr);
  assert.equal((await json(stateFile)).adds,1);assert.equal((await json(stateFile)).fullQueries,1);assert((await readFile(config)).equals(before));
  const p95=[...repeats].sort((a,b)=>a-b)[Math.ceil(repeats.length*.95)-1];assert(p95<=2000,`cached complete npx/connect P95 ${p95}ms`);
  // A second legal profile is separate; a committed add whose ACK is lost is
  // settled from the same pending identity on reentry, without another add.
  const lost=await run(['--profile','second-account'],{CREATION_FIXTURE_LOSE_ACK:'yes'});
  assert.equal(lost.code,1);assert.equal(JSON.parse(lost.stderr.trim().split('\n').at(-1)).error,'installation.registration_unconfirmed_keep_existing');
  assert.equal((await json(stateFile)).adds,2);
  const recovered=await run(['--profile','second-account']);assert.equal(recovered.code,0,recovered.stderr);assert.equal((await json(stateFile)).adds,2);
  assert.equal((await json(stateFile)).installed.length,2);assert.equal((await json(stateFile)).fullQueries,1);
  assert((await readFile(config)).equals(before));
  const elapsed=performance.now()-start;if(elapsed<60_100)await new Promise(r=>setTimeout(r,60_100-elapsed));
  assert.equal(unrelated.exitCode,null,'unrelated discovery really remains pending for >=60s');
  unrelated.kill('SIGTERM');const stopped=await unrelatedResult;assert.equal(stopped.signal,'SIGTERM');unrelated=null;
  t.diagnostic(JSON.stringify({cachedConnects:10,p95Ms:p95,concurrent:2,effectiveRegistrations:2,profiles:2,installerFullListCalls:0,unrelatedHungMs:performance.now()-start,unrelatedNormalTerm:true,platformReadProbes:calls,businessCalls:0,tokenChanged:false}));
 }finally{
  if(unrelated){unrelated.kill('SIGTERM');await new Promise(r=>unrelated.once('close',r));}
  server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});
 }
});
