import {lstat,readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';

export const RUNTIME_PACKAGE_ENTRIES=Object.freeze(['package.json','README.md','LICENSE','bin','dist','lib','skills','docs','.codex-plugin','.mcp.json']);
export const OPTIONAL_HOST_ENTRIES=Object.freeze(['.claude-plugin','.claude-mcp.json']);
const hash=b=>createHash('sha256').update(b).digest('hex');
const invalid=code=>{throw new CreationClientError('installation.'+code);};
/** Shared payload inspection only. It never registers a host or changes a
 * profile; callers own private staging, immutable publication and lifecycle. */
export async function inspectRuntimePackage(root,{entries}={}){
  if(!entries){entries=[...RUNTIME_PACKAGE_ENTRIES];for(const name of OPTIONAL_HOST_ENTRIES){
    try{await lstat(path.join(root,name));entries.push(name);}catch(e){if(e.code!=='ENOENT')throw e;}
  }}
  const files=[];let bytes=0;
  async function walk(relative){
    let s;try{s=await lstat(path.join(root,relative));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!s||s.isSymbolicLink())invalid('package_file_invalid');
    if(s.isDirectory()){
      for(const name of(await readdir(path.join(root,relative))).sort()){
        if(name==='node_modules'||name==='credentials.json'||name.startsWith('.env'))invalid('package_file_invalid');
        await walk(path.join(relative,name));
      }
    }else if(s.isFile()){
      if(s.size>32*1024*1024)invalid('package_too_large');
      const body=await readFile(path.join(root,relative));bytes+=body.length;
      if(files.length>=1024||bytes>32*1024*1024)invalid('package_too_large');
      files.push({path:relative,bytes:body.length,sha256:hash(body),body});
    }else invalid('package_file_invalid');
  }
  for(const name of entries)await walk(name);
  for(const name of ['dist/cli.mjs','dist/THIRD_PARTY_NOTICES.txt','skills/creation-setup/SKILL.md','skills/video-creation/SKILL.md'])
    if(!files.some(f=>f.path===name))invalid('package_incomplete');
  const pkg=JSON.parse(files.find(f=>f.path==='package.json').body),plugin=JSON.parse(files.find(f=>f.path==='.codex-plugin/plugin.json').body);
  if(pkg.name!=='@promptframe/creation'||!/^\d+\.\d+\.\d+$/.test(pkg.version)||plugin.version!==pkg.version)invalid('package_identity_invalid');
  const claude=files.find(f=>f.path==='.claude-plugin/plugin.json');
  if(claude&&JSON.parse(claude.body).version!==pkg.version)invalid('package_identity_invalid');
  return{files,version:pkg.version,hosts:claude?['codex','claude-code']:['codex'],
    payloadDigest:hash(JSON.stringify(files.map(({path,bytes,sha256})=>({path,bytes,sha256}))))};
}
