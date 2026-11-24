import {lstat,mkdir,open,readFile,rename,rm} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';
import {compareBridgeVersions} from './bridge-negotiation.mjs';
import {inspectRuntimePackage} from './runtime-package.mjs';
import {antigravityConfigRoot} from './antigravity-host-session.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw new CreationClientError('installation.'+code);};
const profileFormat=/^[a-z0-9][a-z0-9-]{0,39}$/;

function shellQuote(value){
  return '"'+String(value).replace(/(["\\$`])/g,'\\$1')+'"';
}

export function antigravityPluginManifest({version,name='promptframe-creation',displayName='PromptFrame Creation'}){
  return {
    name,
    displayName,
    description:'PromptFrame video creation Skill and MCP bridge for Antigravity: inspect projects, plan shots, search/author components, preview and render videos.',
    version,
    repository:'https://github.com/ty-teams/promptframe-creation',
    suggestedPrompts:[
      '列出我在 PromptFrame 当前项目中的作品并读取最新状态',
      '帮我在 PromptFrame 中规划并创建一个新的科普视频分镜',
      '在组件市场搜索适合数据对比展示的可视化组件',
    ],
  };
}

export function antigravityMcpConfig({serverName,nodeCommand,runtimeRoot,configFile}){
  return {
    mcpServers:{
      [serverName]:{
        command:nodeCommand,
        args:[path.join(runtimeRoot,'bin','promptframe-creation.mjs'),'bridge','--config',configFile,'--host','antigravity'],
      },
    },
  };
}

export function antigravityHooksConfig({nodeCommand,runtimeRoot,configFile}){
  const cliPath=path.join(runtimeRoot,'bin','promptframe-creation.mjs');
  const command=[shellQuote(nodeCommand),shellQuote(cliPath),'antigravity-host-hook','--config',shellQuote(configFile)].join(' ');
  return {
    'promptframe-host-identity':{
      PreToolUse:[
        {
          matcher:'(.*promptframe.*|^platform_.*)',
          hooks:[{type:'command',command,timeout:5}],
        },
      ],
    },
  };
}

async function readJsonOrNull(file){
  try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function writeFileAtomic(file,content,mode=0o600){
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.'+randomBytes(8).toString('hex')+'.partial';
  const fd=await open(tmp,'wx',mode);
  try{await fd.writeFile(content);await fd.sync();}finally{await fd.close();}
  await rename(tmp,file);
}
async function copyPackagePayload(payload,destRoot){
  const tmp=destRoot+'.partial-'+randomBytes(8).toString('hex');
  await mkdir(tmp,{recursive:true,mode:0o700});
  try{
    for(const file of payload.files){
      const dest=path.join(tmp,...file.path.split('/'));
      await mkdir(path.dirname(dest),{recursive:true,mode:0o700});
      const fd=await open(dest,'wx',0o600);
      try{await fd.writeFile(file.body);await fd.sync();}finally{await fd.close();}
    }
    await rename(tmp,destRoot);
  }catch(e){
    await rm(tmp,{recursive:true,force:true}).catch(()=>{});
    throw e;
  }
}

/** Install PromptFrame Creation as a native Antigravity plugin once.
 * Subsequent bridge upgrades happen automatically on startup via
 * runtime-bootstrap.mjs without requiring plugin reinstallation. */
export async function installForAntigravityUser({
  sourceRoot,
  profile='default',
  configFile,
  env=process.env,
  nodeCommand=process.execPath,
  signal,
}={}){
  if(!profileFormat.test(profile))fail('profile_invalid');
  if(!path.isAbsolute(configFile??''))fail('config_path_invalid');
  signal?.throwIfAborted();
  const payload=await inspectRuntimePackage(sourceRoot);
  const suffix=profile==='default'?'':'-'+profile;
  const pluginDirName='promptframe-creation'+suffix;
  const serverName='promptframe-creation'+suffix;
  const dataRoot=path.resolve(env.XDG_DATA_HOME??path.join(homedir(),'.local','share'),'promptframe-creation',profile,'antigravity');
  const versionRoot=path.join(dataRoot,'versions',payload.version);
  const pluginsRoot=path.join(antigravityConfigRoot(env),'plugins');
  const pluginDir=path.join(pluginsRoot,pluginDirName);
  const markerFile=path.join(pluginDir,'promptframe-installation.json');

  const existing=await readJsonOrNull(markerFile);
  if(existing){
    if(existing.host!=='antigravity'||existing.profile!==profile||existing.configFile!==configFile
      ||typeof existing.version!=='string'||!/^\d+\.\d+\.\d+$/.test(existing.version))fail('managed_installation_invalid');
    const cmp=compareBridgeVersions(existing.version,payload.version);
    if(cmp>0){
      return {registered:true,pluginInstalled:true,pluginEnabled:true,reused:true,host:'antigravity',
        installationMode:'antigravity-plugin',profile,version:existing.version,requestedVersion:payload.version,
        versionStatus:'newer_installed_kept',recordedRuntimeRetained:true,pluginDir,serverName,
        skillsInstalled:true,skills:[{name:'creation-setup'},{name:'video-creation'}]};
    }
    if(cmp===0&&existing.payloadDigest===payload.payloadDigest&&existing.versionRoot===versionRoot){
      return {registered:true,pluginInstalled:true,pluginEnabled:true,reused:true,host:'antigravity',
        installationMode:'antigravity-plugin',profile,version:payload.version,requestedVersion:payload.version,
        versionStatus:'already_current',recordedRuntimeRetained:false,pluginDir,serverName,
        skillsInstalled:true,skills:[{name:'creation-setup'},{name:'video-creation'}]};
    }
  }

  let versionExists=false;
  try{const s=await lstat(versionRoot);versionExists=s.isDirectory()&&!s.isSymbolicLink();}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!versionExists){
    await mkdir(path.dirname(versionRoot),{recursive:true,mode:0o700});
    await copyPackagePayload(payload,versionRoot);
  }
  signal?.throwIfAborted();

  await mkdir(pluginDir,{recursive:true,mode:0o700});
  const pluginJson=JSON.stringify(antigravityPluginManifest({
    version:payload.version,
    name:pluginDirName,
    displayName:profile==='default'?'PromptFrame Creation':'PromptFrame Creation ('+profile+')',
  }),null,2)+'\n';
  const mcpJson=JSON.stringify(antigravityMcpConfig({serverName,nodeCommand,runtimeRoot:versionRoot,configFile}),null,2)+'\n';
  const hooksJson=JSON.stringify(antigravityHooksConfig({nodeCommand,runtimeRoot:versionRoot,configFile}),null,2)+'\n';

  await writeFileAtomic(path.join(pluginDir,'plugin.json'),pluginJson,0o644);
  await writeFileAtomic(path.join(pluginDir,'mcp_config.json'),mcpJson,0o600);
  await writeFileAtomic(path.join(pluginDir,'hooks.json'),hooksJson,0o600);

  const skillEntries=payload.files.filter(f=>f.path.startsWith('skills/')&&f.path.endsWith('/SKILL.md'));
  for(const skill of skillEntries){
    const dest=path.join(pluginDir,...skill.path.split('/'));
    await writeFileAtomic(dest,skill.body,0o644);
  }

  const record={
    contractVersion:'antigravity-plugin-installation/v1',
    host:'antigravity',
    profile,
    configFile,
    pluginDirName,
    serverName,
    version:payload.version,
    versionRoot,
    nodeCommand,
    payloadDigest:payload.payloadDigest,
    mcpDigest:hash(mcpJson),
    hooksDigest:hash(hooksJson),
    installedAt:new Date().toISOString(),
  };
  await writeFileAtomic(markerFile,JSON.stringify(record,null,2)+'\n',0o600);

  return {
    registered:true,
    pluginInstalled:true,
    pluginEnabled:true,
    reused:false,
    host:'antigravity',
    installationMode:'antigravity-plugin',
    profile,
    version:payload.version,
    requestedVersion:payload.version,
    versionStatus:existing?'upgraded':'installed',
    recordedRuntimeRetained:false,
    pluginDir,
    serverName,
    skillsInstalled:true,
    skills:skillEntries.map(s=>({name:s.path.split('/')[1]})),
  };
}
