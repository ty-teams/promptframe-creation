import {CreationClientError} from './credentials.mjs';

export function hostClientName(savedName,host){
  return ['Codex PromptFrame','Claude Code PromptFrame'].includes(savedName)
    ?host.kind==='claude-code'?'Claude Code PromptFrame':'Codex PromptFrame':savedName;
}

export const threadFormat=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Select the transport kind, not a controller. Claude's startup environment
// can remain stale after /clear; only a current host-hook call binds its UUID.
export function resolveHostIdentity({host,env=process.env}={}){
  const kind=host??(env.CLAUDECODE==='1'?'claude-code':'codex');
  if(!['codex','claude-code'].includes(kind))throw new CreationClientError('creation.host_unsupported');
  if(kind==='codex')return Object.freeze({kind});
  return Object.freeze({kind});
}

export function hostParameters(params,host,access){
  const meta=params._meta??{};
  if(Object.keys(meta).some(key=>key.startsWith('promptframe.')||['controlVersion','controller','clientDigest','token','catalogVersion','platformDigest'].includes(key)))
    throw new CreationClientError('creation.transport_authority_managed_by_bridge');
  if(host.kind==='claude-code'){
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
