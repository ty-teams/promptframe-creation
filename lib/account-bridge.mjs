import path from 'node:path';
import { CreationClientError, readCredentials, normalizeEndpoint } from './credentials.mjs';
import { connectPlatform, connectionAccountIdentity } from './connection.mjs';
import { createHostCallBridge, resolveHostCallBinding, hostParameters } from './host-context.mjs';
import { CLAUDE_HOST_PROOF } from './claude-host-session.mjs';
import { localAccountsRoot, localAccountKey, localAgentDigest, localCredentialDigest, localReferenceId,
  listLocalAccounts, readLocalAuthorizations, readSelectedLocalAccount, selectLocalAccount } from './local-accounts.mjs';

const listName = 'promptframe_local_accounts';
const selectName = 'promptframe_local_select_account';
const error = code => new CreationClientError('accounts.' + code);
const sameIdentity = (a,b) => a && b && localAccountKey(a) === localAccountKey(b);

function identityFromKey(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(key)) throw error('identity_invalid');
  return { contractVersion: 'promptframe-account-identity/v1', platformDigest: 'sha256:' + key.slice(0,64),
    accountDigest: 'sha256:' + key.slice(65) };
}

function localTool(name,host) {
  const properties = name === selectName ? {
    identityKey: {type:'string',pattern:'^[a-f0-9]{64}-[a-f0-9]{64}$'},
    referenceId: {type:'string',pattern:'^sha256:[a-f0-9]{64}$',description:'同一账号有多份创作授权时可明确选择列表中的引用。'},
  } : {};
  if(host.kind==='claude-code')properties[CLAUDE_HOST_PROOF]={type:'string',pattern:'^[a-f0-9]{64}$',description:'由当前宿主hook填入，保留原值。'};
  return {name,description:name===listName?'列出本机已登记账号的安全摘要和缺少的授权类型，不返回凭据或本机路径。'
    :'只为当前宿主会话选择本机已授权账号；不切换其它Agent，不申请编辑权或重放业务。',
    inputSchema:{type:'object',properties,additionalProperties:false,...(name===selectName?{required:['identityKey']}:{})},
    annotations:{readOnlyHint:name===listName,destructiveHint:false,openWorldHint:false}};
}

/** Keep connections and their control/upload caches separate. Changing one
 * host selection never mutates credentials or closes an in-flight old caller. */
export function createAccountAwareBridge(defaultClient,{credentials,configFile,host,hostSession,
  root=localAccountsRoot(),connect=connectPlatform,connectionOptions={},localUploads,createLocalUploads,
  onCatalogChange=()=>{},onKnowledgeChange=()=>{}}={}){
  const primaryIdentity=connectionAccountIdentity(defaultClient),contexts=new Map(),preferences=new Map();
  let switched=false;
  const makeBridge=(client,creds,uploads)=>createHostCallBridge(client,{credentials:creds,host,
    localUploads:uploads,onCatalogChange,onKnowledgeChange});
  const primary={client:defaultClient,bridge:makeBridge(defaultClient,credentials,localUploads),identity:primaryIdentity,owned:false};

  function caller(raw,binding,required=false){
    const params={...raw,arguments:binding.arguments};
    hostParameters(params,binding.host,required?'authority':'independent-read');
    const sessionId=binding.host.kind==='claude-code'?binding.host.threadId:params._meta?.threadId;
    return sessionId?{kind:binding.host.kind,sessionId}:undefined;
  }
  async function context(identity,agent,referenceId){
    if(sameIdentity(identity,primaryIdentity)&&(!referenceId||referenceId===localReferenceId('creation',path.resolve(configFile))))return primary;
    const refs=await readLocalAuthorizations({root,identity,client:'creation'});
    if(!refs.length)throw error('creation_authorization_missing');
    let ref=referenceId?refs.find(value=>value.referenceId===referenceId):refs.length===1?refs[0]:undefined;
    if(!ref)throw error(referenceId?'reference_unavailable':'authorization_ambiguous');
    if(ref.expiresAt&&Date.parse(ref.expiresAt)<=Date.now())throw error('authorization_expired');
    const key=[localAccountKey(identity),ref.referenceId,localAgentDigest(agent)].join('|');
    if(!contexts.has(key)){
      const pending=(async()=>{
        const saved=await readCredentials(ref.configFile);
        if(!saved||localCredentialDigest(saved.token)!==ref.credentialDigest
          ||normalizeEndpoint(saved.endpoint)!==normalizeEndpoint(ref.endpoint))throw error('reference_changed');
        const client=await connect(saved,{...connectionOptions,host,expectedIdentity:identity});
        try{
          connectionAccountIdentity(client,identity);
          return{client,bridge:makeBridge(client,saved,createLocalUploads?.({identity,agent,configFile:ref.configFile})),identity,owned:true};
        }catch(cause){await client.close().catch(()=>{});throw cause;}
      })();
      contexts.set(key,pending);pending.catch(()=>{if(contexts.get(key)===pending)contexts.delete(key);});
    }
    return contexts.get(key);
  }
  async function selected(raw,binding){
    const agent=caller(raw,binding);
    if(!agent){if(switched)throw new CreationClientError('creation.host_identity_required');return{entry:primary};}
    const choice=await readSelectedLocalAccount({root,agent});
    if(!choice)return{entry:primary,agent};
    const preference=preferences.get(localAgentDigest(agent));
    const referenceId=preference?.generation===choice.generation?preference.referenceId:undefined;
    return{entry:await context(choice.identity,agent,referenceId),agent,choice};
  }
  async function knowledge(method,raw={}){
    const binding=await resolveHostCallBinding(raw,{host,hostSession});await binding.assertCurrent();
    const {entry}=await selected(raw,binding);
    // Knowledge calls do not consume another Claude hook proof. They keep the
    // original verified host metadata and the selected connection's token.
    return entry.bridge[method]({...raw,arguments:binding.arguments});
  }
  return{
    knowledgeCapabilities:primary.bridge.knowledgeCapabilities,
    async listTools(raw={}){
      let entry=primary;
      // ListTools has no required hook proof. A caller that supplies its real
      // Codex context can obtain that account's platform catalog directly.
      if(host.kind==='codex'&&raw._meta?.threadId){
        const binding=await resolveHostCallBinding(raw,{host,hostSession});entry=(await selected(raw,binding)).entry;
      }
      const directory=await entry.bridge.listTools();
      if(directory.tools.some(tool=>[listName,selectName].includes(tool.name)))throw error('tool_name_conflict');
      return{...directory,tools:[...directory.tools,localTool(listName,host),localTool(selectName,host)]};
    },
    listResources:raw=>knowledge('listResources',raw),listResourceTemplates:raw=>knowledge('listResourceTemplates',raw),
    readResource:raw=>knowledge('readResource',raw),listPrompts:raw=>knowledge('listPrompts',raw),getPrompt:raw=>knowledge('getPrompt',raw),
    async call(raw,options={}){
      const binding=await resolveHostCallBinding(raw,{host,hostSession});await binding.assertCurrent();
      if(raw.name===listName||raw.name===selectName){
        const input=binding.arguments??{},allowed=raw.name===selectName?['identityKey','referenceId']:[];
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw error('request_invalid');
        let value;
        if(raw.name===listName)value=await listLocalAccounts({root});
        else{
          const agent=caller(raw,binding,true),identity=identityFromKey(input.identityKey);
          if(!agent)throw error('agent_required');
          if(input.referenceId!==undefined&&(typeof input.referenceId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(input.referenceId)))throw error('reference_invalid');
          await context(identity,agent,input.referenceId);await binding.assertCurrent();
          const choice=await selectLocalAccount({root,agent,identity});await binding.assertCurrent();
          preferences.set(localAgentDigest(agent),{generation:choice.generation,referenceId:input.referenceId});switched=true;
          Promise.resolve().then(onCatalogChange).catch(()=>{});
          value={selected:true,identityKey:localAccountKey(identity),identity,generation:choice.generation,otherAgentsChanged:0};
        }
        return{content:[{type:'text',text:JSON.stringify(value)}]};
      }
      const {entry}=await selected(raw,binding);await binding.assertCurrent();
      return entry.bridge.call({...raw,arguments:binding.arguments},{...options,resolvedBinding:binding});
    },
    async close(){
      await primary.bridge.close();
      for(const result of await Promise.allSettled(contexts.values()))if(result.status==='fulfilled'){
        await result.value.bridge.close();await result.value.client.close().catch(()=>{});
      }
    },
  };
}
