import {readFile,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {CreationClientError} from './credentials.mjs';

export function claudeConfigRoot(env=process.env){return path.resolve(env.CLAUDE_CONFIG_DIR??path.join(homedir(),'.claude'));}
export async function readClaudeUserServer(serverName,env=process.env){
  const file=env.CLAUDE_CONFIG_DIR?path.join(claudeConfigRoot(env),'.claude.json'):path.join(homedir(),'.claude.json');
  let info;try{info=await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw new CreationClientError('installation.claude_local_registration_unconfirmed');}
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid?.()||info.size>4*1024*1024)
    throw new CreationClientError('installation.claude_local_registration_unconfirmed');
  let state;try{state=JSON.parse(await readFile(file,'utf8'));}catch{throw new CreationClientError('installation.claude_local_registration_unconfirmed');}
  if(!state||typeof state!=='object'||Array.isArray(state))throw new CreationClientError('installation.claude_local_registration_unconfirmed');
  if(state?.mcpServers!==undefined&&(!state.mcpServers||typeof state.mcpServers!=='object'||Array.isArray(state.mcpServers)))
    throw new CreationClientError('installation.claude_local_registration_unconfirmed');
  return state?.mcpServers?.[serverName]??null;
}
