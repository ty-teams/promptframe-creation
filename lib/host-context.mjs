import {LOCAL_UPLOAD_PROTOCOL} from './local-upload.mjs';
import {createHash} from 'node:crypto';
import {CreationClientError} from './credentials.mjs';
import {hostParameters,resolveHostIdentity} from './host-identity.mjs';
import {assertMcpResponseBudget} from './content-budget.mjs';
import {CLAUDE_HOST_PROOF} from './claude-host-session.mjs';
export {hostParameters} from './host-identity.mjs';

const digestPattern=/^sha256:[a-f0-9]{64}$/;
const accesses=new Set(['independent-read','controlled','authority']);
const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const canonical=value=>{
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value)))
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  throw new CreationClientError('creation.request_invalid');
};
const argumentsDigest=value=>digest(canonical(value));
const boundedSet=(map,key,value)=>{if(!map.has(key)&&map.size>=1024)map.delete(map.keys().next().value);map.set(key,value);};

/** The authenticated platform owns classification and editor authority.
 * Business text and model annotations never populate this cache. */
export function createHostCallBridge(client,{credentials,host=resolveHostIdentity(),hostSession,localUploads,onCatalogChange=()=>{},onKnowledgeChange=()=>{}}={}){
  if(!credentials?.endpoint||!credentials.clientId)throw new CreationClientError('creation.bridge_identity_required');
  const installationDigest=digest(credentials.clientId);
  const versions=new Map(),controllers=new Map(),catalogs=new Map(),inflight=new Map();
  const knowledgeVersions=new Map(),upstream=client.getServerCapabilities?.()??{};
  let platformDigest,accountDigest,directory,directoryRead,sequence=0,hostEpoch;
  function catalog(channel,version,order){
    if(typeof version!=='string'||!digestPattern.test(version))return;
    const old=catalogs.get(channel);if(old&&old.order>order)return;
    boundedSet(catalogs,channel,{version,order});
    if(old&&old.version!==version)Promise.resolve().then(onCatalogChange).catch(()=>{});
  }
  function keyFor(params){
    const {projectId,sessionId}=params.arguments??{},thread=params._meta?.threadId;
    return typeof thread==='string'&&[projectId,sessionId].every(v=>typeof v==='string'&&v.length>0&&v.length<=160)
      ?JSON.stringify([thread.toLowerCase(),projectId,sessionId]):null;
  }
  function metadata(params,result){
    const v=result?._meta?.['promptframe.creation'];
    if(!v||v.contractVersion!=='creation-transport-metadata/v1'||!digestPattern.test(v.platformDigest)
      ||platformDigest&&v.platformDigest!==platformDigest
      ||v.installationDigest!==installationDigest||!digestPattern.test(v.accountDigest)||!digestPattern.test(v.controllerDigest))return null;
    const thread=params._meta?.threadId?.toLowerCase();
    if(thread?v.host?.kind!==host.kind||v.host.threadDigest!==digest(thread):v.host?.kind!=='legacy')return null;
    for(const field of ['projectId','sessionId'])if(params.arguments?.[field]!==undefined&&v[field]!==params.arguments[field])return null;
    if(accountDigest&&accountDigest!==v.accountDigest)return null;
    const controllerKey=thread??'legacy',prior=controllers.get(controllerKey);
    if(prior&&prior!==v.controllerDigest)return null;
    // The connection URL can be a supported alias. Pin the canonical identity
    // received outside business text on this one authenticated connection.
    platformDigest??=v.platformDigest;accountDigest??=v.accountDigest;boundedSet(controllers,controllerKey,v.controllerDigest);return v;
  }
  function remember(params,result,order){
    const v=metadata(params,result);if(!v)return null;
    catalog(JSON.stringify([v.projectId??null,v.sessionId??null]),v.catalogVersion,order);
    const target=v.sessionId&&!params.arguments?.sessionId?{...params,arguments:{...params.arguments,sessionId:v.sessionId}}:params;
    const key=keyFor(target),c=v.control;
    if(!key||!c||!Number.isSafeInteger(c.controlVersion)||c.controlVersion<=0||!['web','client'].includes(c.editor?.kind)
      ||typeof c.editor.isCurrentClient!=='boolean'||c.editor.kind==='web'&&c.editor.isCurrentClient)return v;
    const old=versions.get(key),version=c.controlVersion,owned=c.editor.kind==='client'&&c.editor.isCurrentClient;
    const authorityRead=directory?.tools.get(params.name)?._meta?.['promptframe.role']==='control-read';
    if(!old||version>old.version)boundedSet(versions,key,{version,owned,needsRead:false,authorityOrder:order});
    else if(version===old.version&&order>=(old.authorityOrder??0)){
      const freshRead=!result.isError&&authorityRead&&order>(old.invalidatedAt??0);
      if(freshRead)boundedSet(versions,key,{version,owned,needsRead:false,authorityOrder:order});
      else if(old.owned!==owned)boundedSet(versions,key,{...old,owned:false,needsRead:true,invalidatedAt:++sequence});
      // A normal same-generation result cannot erase a newer error or conflict.
    }
    return v;
  }
  async function send(params,binding,{signal,timeout=60000}={}){
    await binding?.assertCurrent();
    const order=++sequence,result=assertMcpResponseBudget(await client.callTool(params,undefined,{timeout,...(signal?{signal}:{})}));
    await binding?.assertCurrent();
    return {result,trusted:remember(params,result,order)};
  }
  async function listTools(){
    const order=++sequence,result=assertMcpResponseBudget(await client.listTools());
    if(result.tools.some(tool=>!accesses.has(tool._meta?.['promptframe.access'])))throw new CreationClientError('creation.upgrade_required');
    if(!directory||order>=directory.order)directory={tools:new Map(result.tools.map(t=>[t.name,t])),order};
    catalog('outer',result._meta?.['promptframe.catalogVersion'],order);
    return {...result,tools:result.tools.map(tool=>{
      const local=tool._meta?.['promptframe.localFileUpload'];
      const schema=local?.contractVersion===LOCAL_UPLOAD_PROTOCOL?local.inputSchema:tool.inputSchema;
      if(!schema||schema.type!=='object')throw new CreationClientError('creation.upgrade_required');
      const p=schema.properties;
      const {controlVersion:_managed,...properties}=p??{};
      return {...tool,inputSchema:{...schema,properties:{...properties,...(host.kind==='claude-code'?{
        [CLAUDE_HOST_PROOF]:{type:'string',pattern:'^[a-f0-9]{64}$',description:'由当前宿主hook填入的单次身份凭证；请保留，不自行填写。'}
      }:{})},...(schema.required
        ?{required:schema.required.filter(name=>name!=='controlVersion')}:{})}};
    })};
  }
  async function ensureDirectory(){
    if(!directory){directoryRead??=listTools().finally(()=>{directoryRead=undefined;});await directoryRead;}
  }
  function role(name){
    const found=[...directory.tools.values()].filter(t=>t._meta?.['promptframe.role']===name);
    if(found.length!==1)throw new CreationClientError('creation.upgrade_required');return found[0].name;
  }
  async function controlRead(params,key,binding){
    if(!inflight.has(key)){
      const pending=send({name:role('control-read'),_meta:params._meta,
        arguments:{projectId:params.arguments.projectId,sessionId:params.arguments.sessionId,pageSize:1}},binding)
        .finally(()=>{if(inflight.get(key)===pending)inflight.delete(key);});
      inflight.set(key,pending);
    }
    const observation=await inflight.get(key);if(observation.result.isError)return observation.result;
    if(!observation.trusted||!versions.has(key)||versions.get(key).needsRead)throw new CreationClientError('creation.control_unverified');
  }
  async function knowledgeRead(kind,method,raw={}){
    if(!upstream[kind])throw new CreationClientError('creation.knowledge_unsupported');
    const params=hostParameters(raw,host.kind==='claude-code'?{kind:host.kind}:host,'independent-read'),order=++sequence;
    const result=assertMcpResponseBudget(await client[method](params,undefined,{timeout:60000}));
    const version=result._meta?.[kind==='resources'&&method==='listResources'
      ?'promptframe.guideDirectoryVersion':'promptframe.guideVersion'];
    const key=JSON.stringify([kind,method,raw.uri??raw.arguments?.projectId??null]);
    if(digestPattern.test(version??'')){
      const old=knowledgeVersions.get(key);
      if(!old||order>=old.order){
        boundedSet(knowledgeVersions,key,{version,order});
        if(old&&old.version!==version)Promise.resolve().then(()=>onKnowledgeChange(kind)).catch(()=>{});
      }
    }
    return result;
  }
  return {listTools,knowledgeCapabilities:{...(upstream.resources?{resources:{listChanged:true}}:{}),
    ...(upstream.prompts?{prompts:{listChanged:true}}:{})},
    listResources:params=>knowledgeRead('resources','listResources',params),
    listResourceTemplates:params=>knowledgeRead('resources','listResourceTemplates',params),
    readResource:params=>knowledgeRead('resources','readResource',params),
    listPrompts:params=>knowledgeRead('prompts','listPrompts',params),
    getPrompt:params=>knowledgeRead('prompts','getPrompt',params),close:()=>localUploads?.close(),async call(raw,{signal}={}){
    for(const field of ['threadId','controller','clientDigest','token','controlVersion'])if(Object.hasOwn(raw.arguments??{},field))
      throw new CreationClientError('creation.transport_authority_managed_by_bridge');
    let binding={host,arguments:raw.arguments,assertCurrent:async()=>{}};
    if(host.kind==='claude-code'){
      if(hostSession)binding=await hostSession.begin(raw);
      else if(raw.arguments?.[CLAUDE_HOST_PROOF]!==undefined)throw new CreationClientError('creation.host_identity_invalid');
      else binding={host:{kind:'claude-code'},arguments:raw.arguments,assertCurrent:async()=>{}};
      if(binding.epoch!==hostEpoch){versions.clear();controllers.clear();inflight.clear();hostEpoch=binding.epoch;}
    }else if(Object.hasOwn(raw.arguments??{},CLAUDE_HOST_PROOF))throw new CreationClientError('creation.transport_authority_managed_by_bridge');
    raw={...raw,arguments:binding.arguments};
    await ensureDirectory();await binding.assertCurrent();const definition=directory.tools.get(raw.name);
    if(!definition)throw new CreationClientError('creation.tool_unavailable');
    const access=definition._meta['promptframe.access'],managed=Object.hasOwn(definition.inputSchema.properties??{},'controlVersion');
    // Resolve parameter-dependent access before requiring a controller. A
    // missing host UUID must not block an independently authorized read.
    let params=hostParameters(raw,binding.host,'independent-read');let effectiveAccess=access,resolvedControl;
    if(definition._meta['promptframe.resolveAccess']==='target'){
      const {projectId,sessionId,tool,arguments:input}=params.arguments??{};
      if(typeof tool!=='string'||!input||typeof input!=='object'||Array.isArray(input))throw new CreationClientError('creation.request_invalid');
      const observed=await send({name:role('describe-target'),_meta:params._meta,arguments:{projectId,sessionId,tool,arguments:input}},binding);
      if(observed.result.isError)return observed.result;
      const resolved=observed.trusted?.resolvedAccess;
      const defaults=resolved?.scopeDefaults??{};
      if(!defaults||typeof defaults!=='object'||Array.isArray(defaults)||Object.entries(defaults).some(([key,value])=>
        !['projectId','sessionId'].includes(key)||value!==params.arguments[key]||Object.hasOwn(input,key)))
        throw new CreationClientError('creation.access_unverified');
      const normalized={...input,...defaults};
      if(resolved?.tool!==tool||resolved.argumentsDigest!==argumentsDigest(normalized)||!accesses.has(resolved.access))throw new CreationClientError('creation.access_unverified');
      params={...params,arguments:{...params.arguments,arguments:normalized}};
      effectiveAccess=resolved.access;
      resolvedControl=observed.trusted?.control;
    }
    hostParameters(raw,binding.host,effectiveAccess);
    const local=definition._meta['promptframe.localFileUpload'];
    if(local?.contractVersion===LOCAL_UPLOAD_PROTOCOL){
      if(!localUploads)throw new CreationClientError('creation.upgrade_required');
      // Resolve account/platform and the live work from an authenticated read,
      // without taking its editor or starting any business execution.
      const {projectId,sessionId}=params.arguments??{};
      if(typeof projectId!=='string'||typeof sessionId!=='string')throw new CreationClientError('creation.request_invalid');
      const observed=await send({name:role('control-read'),_meta:params._meta,arguments:{projectId,sessionId,pageSize:1}},binding);
      if(observed.result.isError)return observed.result;
      if(!observed.trusted)throw new CreationClientError('creation.access_unverified');
      const value=await localUploads.call({input:params.arguments,binding,signal,scope:{platform:observed.trusted.platformDigest,
        account:observed.trusted.accountDigest,installation:installationDigest,host:binding.host.kind,
        thread:params._meta.threadId.toLowerCase(),projectId,sessionId},
        send:(transfer,options)=>send({name:params.name,_meta:params._meta,arguments:{projectId,sessionId,transfer}},binding,{timeout:30000,...options})});
      return assertMcpResponseBudget({content:[{type:'text',text:JSON.stringify(value)}]});
    }
    const key=keyFor(params);let outgoing=params;
    if(managed){
      if(!key){
        if(effectiveAccess!=='independent-read'||!Number.isSafeInteger(resolvedControl?.controlVersion)||resolvedControl.controlVersion<=0)
          throw new CreationClientError('creation.control_unverified');
        outgoing={...params,arguments:{...params.arguments,controlVersion:resolvedControl.controlVersion}};
      }else{let entry=versions.get(key);
      if(!entry||entry.needsRead){const denied=await controlRead(params,key,binding);if(denied)return denied;entry=versions.get(key);}
      if(effectiveAccess!=='independent-read'&&!entry.owned)throw new CreationClientError('creation.editor_not_current');
      outgoing={...params,arguments:{...params.arguments,controlVersion:entry.version}};
      }
    }
    const dispatched=key&&versions.get(key);
    const invalidate=()=>{
      if(host.kind==='claude-code'&&binding.epoch!==hostEpoch)return;
      const current=key&&versions.get(key);
      if(dispatched&&current&&current.version<=dispatched.version)
        boundedSet(versions,key,{...current,needsRead:true,invalidatedAt:++sequence});
    };
    let response;
    try{response=await send(outgoing,binding);}catch(error){invalidate();throw error;}
    if(response.result.isError)invalidate();
    return response.result;
  }};
}
