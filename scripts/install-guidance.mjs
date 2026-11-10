import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

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
}
