import {CreationClientError} from './credentials.mjs';

export const SUPPORTED_HOSTS=Object.freeze(['codex','claude-code','antigravity']);
export const isHookProofHost=kind=>kind==='claude-code'||kind==='antigravity';
const DEFAULT_CLIENT_NAMES=Object.freeze({
  codex:'Codex PromptFrame',
  'claude-code':'Claude Code PromptFrame',
  antigravity:'Antigravity PromptFrame',
});

export function hostClientName(savedName,host){
  return Object.values(DEFAULT_CLIENT_NAMES).includes(savedName)
    ?(DEFAULT_CLIENT_NAMES[host.kind]??DEFAULT_CLIENT_NAMES.codex):savedName;
}

export const threadFormat=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Select the transport kind, not a controller. Startup environments can remain
// stale across sessions; hook-proof hosts bind each call via PreToolUse hook.
export function resolveHostIdentity({host,env=process.env}={}){
  const kind=host??(env.CLAUDECODE==='1'?'claude-code':'codex');
  if(!SUPPORTED_HOSTS.includes(kind))throw new CreationClientError('creation.host_unsupported');
  return Object.freeze({kind});
}

export function hostParameters(params,host,access){
  const meta=params._meta??{};
  if(Object.keys(meta).some(key=>key.startsWith('promptframe.')||['controlVersion','controller','clientDigest','token','catalogVersion','platformDigest'].includes(key)))
    throw new CreationClientError('creation.transport_authority_managed_by_bridge');
  if(isHookProofHost(host.kind)){
    if(Object.hasOwn(meta,'threadId'))throw new CreationClientError('creation.transport_authority_managed_by_bridge');
    if(!host.threadId){if(access==='independent-read')return params;throw new CreationClientError('creation.host_identity_unavailable');}
    return {...params,_meta:{...meta,threadId:host.threadId}};
  }
  if(meta.threadId===undefined){
    if(access==='independent-read')return params;
    throw new CreationClientError('creation.host_identity_required');
  }
  if(typeof meta.threadId!=='string'||!threadFormat.test(meta.threadId))throw new CreationClientError('creation.host_identity_invalid');
  return params;
}
