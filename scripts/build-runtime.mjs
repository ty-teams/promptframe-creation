import {build} from 'esbuild';
import {builtinModules} from 'node:module';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CLIENT_VERSION} from '../lib/version.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
export async function buildRuntime(){
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 const plugin=JSON.parse(await readFile(path.join(root,'.codex-plugin/plugin.json'),'utf8'));
 const catalog=JSON.parse(await readFile(path.join(root,'.agents/plugins/marketplace.json'),'utf8'));
 if(pkg.version!==CLIENT_VERSION||pkg.version!==plugin.version)throw Error('creation_build.version_mismatch');
 if(catalog.plugins?.length!==1||catalog.plugins[0].source?.source!=='npm'
  ||catalog.plugins[0].source.package!==pkg.name||catalog.plugins[0].source.version!==pkg.version)
  throw Error('creation_build.catalog_version_mismatch');
 await mkdir(path.join(root,'dist'),{recursive:true});
 const result=await build({absWorkingDir:root,entryPoints:['lib/cli.mjs'],outfile:'dist/cli.mjs',
  bundle:true,platform:'node',format:'esm',target:'node20',metafile:true,legalComments:'linked',
  banner:{js:'import {createRequire as __creationRequire} from "node:module"; const require=__creationRequire(import.meta.url);'},
 });
 const builtins=new Set(builtinModules.flatMap(n=>[n,'node:'+n]));
 for(const output of Object.values(result.metafile.outputs))for(const i of output.imports)
  if(i.external&&!builtins.has(i.path))throw Error('creation_build.external_runtime_dependency');
 const packages=new Map();
 for(const input of Object.keys(result.metafile.inputs)){
  if(!input.startsWith('node_modules/'))continue;
  let dir=path.dirname(path.join(root,input));
  while(dir.startsWith(path.join(root,'node_modules')+path.sep)){
   try{const p=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
    if(p.name&&p.version){packages.set(p.name,{...p,dir});break;}
   }catch{}dir=path.dirname(dir);
  }
 }
 const notices=[];
 for(const p of [...packages.values()].sort((a,b)=>a.name.localeCompare(b.name))){
  let license;
  for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md','LICENSE-MIT']){
   try{license=await readFile(path.join(p.dir,file),'utf8');break;}catch{}
  }
  if(!license)throw Error('creation_build.dependency_license_missing:'+p.name);
  notices.push(`${p.name}@${p.version} (${p.license??'see license'})\n${license.trim()}\n`);
 }
 await writeFile(path.join(root,'dist/THIRD_PARTY_NOTICES.txt'),notices.join('\n---\n\n'));
 await access(path.join(root,'dist/cli.mjs'));
 return{version:pkg.version,bundledPackages:[...packages.keys()].sort(),externalRuntimeDependencies:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(await buildRuntime()));}
 catch(e){console.error(e.message?.startsWith('creation_build.')?e.message:'creation_build.failed');process.exitCode=1;}
}
