import {CreationClientError} from './credentials.mjs';
import {MCP_BLOCK_BYTES,MCP_RESPONSE_BYTES} from './content-budget.mjs';

export const CONTENT_TYPES=Object.freeze(['text','image','audio','resource_link','resource']);
const STANDARD_CONTENT_TYPES=Object.freeze(['text','image','resource']);
const versionParts=value=>{
  if(typeof value!=='string'||value.length>40||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    throw new CreationClientError('creation.bridge_policy_invalid');
  const parts=value.split('.').map(Number);
  if(parts.some(n=>!Number.isSafeInteger(n)))throw new CreationClientError('creation.bridge_policy_invalid');
  return parts;
};
export function compareBridgeVersions(left,right){
  const a=versionParts(left),b=versionParts(right);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]<b[i]?-1:1;
  return 0;
}
export function readPlatformBridgePolicy(capabilities){
  const policy=capabilities?.experimental?.['promptframe.creation'];
  if(policy===undefined)return null;
  if(!policy||policy.contractVersion!=='creation-bridge-capabilities/v1'
    ||policy.blockMaxBytes!==MCP_BLOCK_BYTES||policy.responseMaxBytes!==MCP_RESPONSE_BYTES
    ||!Array.isArray(policy.contentTypes)||policy.contentTypes.length>CONTENT_TYPES.length
    ||new Set(policy.contentTypes).size!==policy.contentTypes.length||!policy.contentTypes.includes('text')
    ||policy.contentTypes.some(type=>!CONTENT_TYPES.includes(type))
    ||policy.standardContentTypes!==undefined&&(!Array.isArray(policy.standardContentTypes)
      ||policy.standardContentTypes.length!==STANDARD_CONTENT_TYPES.length
      ||STANDARD_CONTENT_TYPES.some(type=>!policy.standardContentTypes.includes(type)))
    ||compareBridgeVersions(policy.recommendedBridge,policy.minBridge)<0)
    throw new CreationClientError('creation.bridge_policy_invalid');
  return Object.freeze({contractVersion:policy.contractVersion,minBridge:policy.minBridge,
    recommendedBridge:policy.recommendedBridge,contentTypes:[...policy.contentTypes],
    blockMaxBytes:policy.blockMaxBytes,responseMaxBytes:policy.responseMaxBytes,
    ...(policy.standardContentTypes?{standardContentTypes:[...STANDARD_CONTENT_TYPES]}:{})});
}
export function assertBridgeCompatible(capabilities,version){
  const policy=readPlatformBridgePolicy(capabilities);
  if(policy&&compareBridgeVersions(version,policy.minBridge)<0)
    throw new BridgeCompatibilityError(version,policy);
  return policy;
}
class BridgeCompatibilityError extends CreationClientError{
  constructor(version,policy){
    super('creation.upgrade_required');
    this.bridgeFacts=Object.freeze({currentVersion:version,minimumVersion:policy.minBridge,
      recommendedVersion:policy.recommendedBridge,action:'upgrade_bridge_in_new_session'});
  }
}
export const bridgeErrorDetails=error=>error instanceof BridgeCompatibilityError?error.bridgeFacts:undefined;

/** Image and embedded-resource results are standard MCP content, including the
 * oldest protocol supported by our SDK. No private capability is required for
 * them after initialization. Audio/resource_link still need explicit support;
 * host/model names and the Studio director version do not establish it. */
export function declaredHostContentCapabilities(capabilities,{initialized=false,standardContent=false}={}){
  const requested=capabilities?.experimental?.['promptframe.contentTypes'];
  if(requested===undefined&&initialized&&standardContent)
    return{types:[...STANDARD_CONTENT_TYPES],source:'mcp-protocol'};
  if(!Array.isArray(requested)||requested.length>CONTENT_TYPES.length
    ||requested.some(type=>!CONTENT_TYPES.includes(type)))return{types:['text'],source:'text-fallback'};
  return{types:['text',...CONTENT_TYPES.filter(type=>type!=='text'&&requested.includes(type))],source:'declared'};
}
export const declaredHostContentTypes=capabilities=>declaredHostContentCapabilities(capabilities).types;
