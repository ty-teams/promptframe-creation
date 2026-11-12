import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Versioned public copy consumed by both the package and Studio. Minimum
 * feature versions remain independent of the package currently being built. */
export function installGuidanceManifest(version){
 if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error('creation_build.guidance_version_invalid');
 return{schemaVersion:'creation-install-guidance/v1',package:'@promptframe/creation',version,
  hosts:[
   {kind:'codex',name:'Codex',minimumBridge:'0.2.3',requirements:'Node.js 20+ 与支持插件的 Codex（最低0.160.0）',
    commandArgs:['connect','--endpoint','{{endpoint}}'],nextSession:'在同一主机打开 Local 新聊天；CLI 使用新 session。'},
   {kind:'claude-code',name:'Claude Code',minimumBridge:'0.3.1',requirements:'Node.js 20+ 与 Claude Code 2.1.295+；受控会话身份使用 Linux/WSL 原生 CLI 或桌面版的同机远程入口',
    commandArgs:['connect','--host','claude-code','--endpoint','{{endpoint}}'],nextSession:'在同一主机开始新的 Claude Code session；桌面版远程连接 WSL 时在该 WSL 安装。'},
  ],
  versionInstructions:'比较已安装版本：同版本复用，更新版本不降级；待升级或 Node 不可用时按明确指引处理，不把旧版复用当作升级成功。',
  credentialInstructions:'复用已有有效授权，不轮换 Token。首次 Token 仅在本机终端隐藏输入，不放进聊天。',
  loadingInstructions:'确认 creation-setup/video-creation Skill 与 MCP 都已加载；保留原 Token，无需重装或产品源码。'};
}

export const INSTALL_GUIDANCE_FILES=['README.md','skills/creation-setup/SKILL.md','docs/installing.md'];
const start='<!-- creation-install-command -->',end='<!-- /creation-install-command -->';
/** Only marked current commands follow this package. Historical examples and
 * immutable release notes keep their original versions. */
export function renderInstallGuidance(content,version){
 if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error('creation_build.guidance_version_invalid');
 let blocks=0;
 const rendered=content.replace(/<!-- creation-install-command -->([\s\S]*?)<!-- \/creation-install-command -->/g,(_all,body)=>{
  blocks++;let commands=0;
  const text=body.replace(/@promptframe\/creation@\d+\.\d+\.\d+(?=\s+connect\b)/g,()=>{commands++;return '@promptframe/creation@'+version;});
  if(commands!==1)throw Error('creation_build.guidance_command_invalid');
  return start+text+end;
 });
 if(!blocks||content.split(start).length-1!==blocks||content.split(end).length-1!==blocks)
  throw Error('creation_build.guidance_marker_invalid');
 return rendered;
}
export async function syncInstallGuidance(root,version){
 for(const file of INSTALL_GUIDANCE_FILES){
  const before=await readFile(path.join(root,file),'utf8'),after=renderInstallGuidance(before,version);
  if(after!==before)await writeFile(path.join(root,file),after);
 }
 const file=path.join(root,'docs/install-guidance.json'),body=JSON.stringify(installGuidanceManifest(version),null,2)+'\n';
 let before;try{before=await readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(before!==body)await writeFile(file,body);
}
