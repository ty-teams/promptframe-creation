#!/usr/bin/env node
// Isolated supported-CLI simulator. Never run against a personal Codex home.
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2),file=process.env.CREATION_FIXTURE_STATE;
if(!file)throw Error('fixture_state_required');
const state=JSON.parse(await readFile(file,'utf8'));
const save=()=>writeFile(file,JSON.stringify(state));
const out=x=>process.stdout.write(JSON.stringify(x));
if(args[0]==='--version')process.stdout.write('codex-cli 0.160.0\n');
else if(args.slice(0,3).join(' ')==='plugin marketplace list')out({marketplaces:state.markets});
else if(args.slice(0,2).join(' ')==='plugin list'){
 if(!args.includes('--marketplace')){
  state.fullQueries++;await save();await new Promise(r=>setTimeout(r,65_000));out({installed:state.installed});
 }else{
  const mode=process.env.CREATION_FIXTURE_READ_ERROR;
  if(mode==='timeout')await new Promise(r=>setTimeout(r,65_000));
  if(mode==='nonzero'){process.stderr.write(process.env.CREATION_FIXTURE_SECRET??'synthetic secret');process.exitCode=7;}
  else if(mode==='json')process.stdout.write('bad json '+(process.env.CREATION_FIXTURE_SECRET??''));
  else if(mode==='limit')process.stdout.write('x'.repeat(2*1024*1024+1024));
  else out({installed:state.installed.filter(p=>p.pluginId.endsWith('@'+args[args.indexOf('--marketplace')+1]))});
 }
}else if(args.join(' ')==='mcp list --json'){
 const rows=[...(state.extraMcp??[])];
 for(const plugin of state.installed){
  if(!plugin.enabled)continue;
  const root=plugin.source.path??path.join(process.env.CODEX_HOME,'plugins/cache',plugin.marketplaceName,plugin.name,plugin.version);
  const mcp=JSON.parse(await readFile(path.join(root,'.mcp.json')));
  rows.push(...Object.entries(mcp.mcpServers).map(([name,x])=>({name,enabled:true,transport:{type:'stdio',...x,cwd:x.cwd==='.'?root:x.cwd}})));
 }
 out(rows);
}else if(args.slice(0,3).join(' ')==='plugin marketplace add'){
 const root=args[3],catalog=JSON.parse(await readFile(path.join(root,'.agents/plugins/marketplace.json')));
 state.marketplaceAdds++;state.markets=state.markets.filter(p=>p.name!==catalog.name);state.markets.push({name:catalog.name,root});await save();out({marketplaceName:catalog.name});
}else if(args.slice(0,2).join(' ')==='plugin add'){
 const id=args[2],market=state.markets.find(p=>id.endsWith('@'+p.name));
 if(!market)throw Error('fixture_market_required');
 const catalog=JSON.parse(await readFile(path.join(market.root,'.agents/plugins/marketplace.json'))),p=catalog.plugins.find(p=>id===p.name+'@'+market.name);
 const root=path.resolve(market.root,p.source.path),manifest=JSON.parse(await readFile(path.join(root,'.codex-plugin/plugin.json')));
 state.adds++;state.installed=state.installed.filter(p=>p.pluginId!==id);
 state.installed.push({pluginId:id,name:p.name,marketplaceName:market.name,version:manifest.version,enabled:true,source:{source:'local',path:root}});await save();
 if(process.env.CREATION_FIXTURE_LOSE_ACK==='yes'){process.stderr.write(process.env.CREATION_FIXTURE_SECRET??'synthetic secret');process.exitCode=4;}
 else out({pluginId:id,version:manifest.version,installedPath:root});
}else throw Error('unexpected_fixture_command');
