import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installForUser} from '../lib/user-installation.mjs';
const source=fileURLToPath(new URL('..',import.meta.url));

test('installation discovers every related local marketplace without querying unrelated remote plugins',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'creation-related-discovery-'));
 try{
  const catalogRoot=path.join(root,'unrelated');await mkdir(path.join(catalogRoot,'.agents/plugins'),{recursive:true});
  await writeFile(path.join(catalogRoot,'.agents/plugins/marketplace.json'),JSON.stringify({name:'unrelated',plugins:[{name:'other',source:{source:'remote'}}]}));
  const env={...process.env,CODEX_HOME:path.join(root,'codex'),XDG_DATA_HOME:path.join(root,'data'),XDG_CONFIG_HOME:path.join(root,'config')};
  let registered,managedRoot,fullQueries=0,adds=0;
  const runCodex=async args=>{
   if(args[0]==='--version')return 'codex-cli 0.160.0';
   if(args.slice(0,3).join(' ')==='plugin marketplace list')return JSON.stringify({marketplaces:[{name:'unrelated',root:catalogRoot},...(managedRoot?[{name:'promptframe-creation-user',root:managedRoot}]:[])]});
   if(args.slice(0,2).join(' ')==='plugin list'){
    if(!args.includes('--marketplace')){fullQueries++;throw new Error('unrelated remote catalog is hung');}
    assert.equal(args[args.indexOf('--marketplace')+1],'promptframe-creation-user');
    return JSON.stringify({installed:registered?[registered]:[]});
   }
   if(args.join(' ')==='mcp list --json'){
    if(!registered)return '[]';
    const m=JSON.parse(await readFile(path.join(registered.source.path,'.mcp.json')));
    return JSON.stringify(Object.entries(m.mcpServers).map(([name,x])=>({name,transport:{type:'stdio',...x}})));
   }
   if(args.slice(0,3).join(' ')==='plugin marketplace add'){managedRoot=args[3];return '{}';}
   if(args.slice(0,2).join(' ')==='plugin add'){
    adds++;const catalog=JSON.parse(await readFile(path.join(managedRoot,'.agents/plugins/marketplace.json')));
    const dir=path.join(managedRoot,catalog.plugins[0].source.path),pkg=JSON.parse(await readFile(path.join(dir,'package.json')));
    registered={pluginId:args[2],name:'promptframe-creation',marketplaceName:'promptframe-creation-user',version:pkg.version,enabled:true,source:{source:'local',path:dir}};return '{}';
   }
   throw Error('unexpected_call');
  };
  const opts={sourceRoot:source,env,runCodex,checkRuntime:async()=>{}};
  assert.equal((await installForUser(opts)).registered,true);
  assert.equal((await installForUser(opts)).reused,true);
  assert.equal(fullQueries,0);assert.equal(adds,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
