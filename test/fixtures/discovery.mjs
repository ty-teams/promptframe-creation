import {createHash} from 'node:crypto';
export const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
export const credentials={endpoint:'http://127.0.0.1:23456/api/mcp',clientId:'own-isolated-installation'};
export const threadA='01a10000-0000-7000-8000-000000000001';
export const threadB='01a10000-0000-7000-8000-000000000002';
export const canonical=value=>{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
};
export const inputDigest=value=>sha(canonical(value));
export const descriptor=(name,access,extra={},managed=false)=>({name,inputSchema:{type:'object',properties:managed?{controlVersion:{type:'integer'}}:{},...(managed?{required:['controlVersion']}:{})},_meta:{'promptframe.access':access,...extra}});
export const directory=()=>({tools:[
  descriptor('platform_call_tool','controlled',{'promptframe.resolveAccess':'target'},true),
  descriptor('platform_read_session','independent-read',{'promptframe.role':'control-read'}),
  descriptor('platform_describe_tool','independent-read',{'promptframe.role':'describe-target'}),
  descriptor('platform_read_onboarding','independent-read'),
  descriptor('platform_create_session','authority'),
],_meta:{'promptframe.catalogVersion':sha('outer1')}});
export function wire(params,{controlVersion=3,editor={kind:'web'},host='codex',...extra}={}){
  const thread=params._meta?.threadId?.toLowerCase();
  return {contractVersion:'creation-transport-metadata/v1',platformDigest:sha(credentials.endpoint),installationDigest:sha(credentials.clientId),
    accountDigest:sha('own-account'),controllerDigest:sha(thread??'legacy'),host:thread?{kind:host,threadDigest:sha(thread)}:{kind:'legacy'},
    ...Object.fromEntries(['projectId','sessionId'].filter(k=>params.arguments?.[k]!==undefined).map(k=>[k,params.arguments[k]])),
    ...(params.arguments?.sessionId?{control:{controlVersion,editor:{...editor,isCurrentClient:editor.kind==='client'&&editor.isCurrentClient===true}}}:{}),...extra};
}
export const result=(value,metadata)=>({content:[{type:'text',text:JSON.stringify(value)}],...(metadata?{_meta:{'promptframe.creation':metadata}}:{})});
