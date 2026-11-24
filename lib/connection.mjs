import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CLIENT_VERSION,CLIENT_PROTOCOL} from './version.mjs';
import {resolveHostIdentity,hostClientName} from './host-identity.mjs';
import {assertBridgeCompatible,declaredHostContentTypes,readPlatformBridgePolicy} from './bridge-negotiation.mjs';
import {parseAccountIdentity,localClientObservationInstance} from './local-accounts.mjs';
import {CreationClientError} from './credentials.mjs';
import path from 'node:path';

/** Only initialize metadata from this authenticated connection is accepted.
 * Business output and local directory captions cannot establish identity. */
export function connectionAccountIdentity(client, expected) {
  const raw=client.getServerCapabilities()?.experimental?.['promptframe.accountIdentity'];
  if(raw===undefined){
    if(expected)throw new CreationClientError('accounts.identity_unavailable');
    return undefined;
  }
  const actual=parseAccountIdentity(raw);
  if(expected){
    expected=parseAccountIdentity(expected);
    if(actual.platformDigest!==expected.platformDigest)throw new CreationClientError('accounts.platform_mismatch');
    if(actual.accountDigest!==expected.accountDigest)throw new CreationClientError('accounts.account_mismatch');
  }
  return actual;
}

export async function connectPlatform(credentials,{host=resolveHostIdentity(),contentTypes=()=>['text'],contentSource=()=> 'text-fallback',enforceMinimum=true,signal,expectedIdentity,clientConfigFile,observationRoot}={}) {
  let observation;
  const client = new Client(
    { name: "promptframe-creation-bridge", version: CLIENT_VERSION },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(credentials.endpoint),
    {
      fetch:(url,init)=>{
        const headers=new Headers(init?.headers);
        const types=declaredHostContentTypes({experimental:{'promptframe.contentTypes':contentTypes()}});
        headers.set('X-PromptFrame-Content-Types',JSON.stringify(types));
        headers.set('X-PromptFrame-Content-Source',contentSource());
        if(observation)headers.set('X-PromptFrame-Client-Observation',encodeURIComponent(JSON.stringify(observation)));
        return fetch(url,{...init,headers,...(signal?{signal:init?.signal?AbortSignal.any([init.signal,signal]):signal}:{})});
      },
      requestInit: {
        headers: {
          Authorization: "Bearer " + credentials.token,
          "X-PromptFrame-Host-Kind": host.kind,
          "X-PromptFrame-Creation-Protocol": CLIENT_PROTOCOL,
          "X-PromptFrame-Client-Version": CLIENT_VERSION,
          "X-PromptFrame-Client-Id": credentials.clientId,
          "X-PromptFrame-Client-Name": encodeURIComponent(
            hostClientName(credentials.clientName,host),
          ),
        },
      },
    },
  );
  try {
    await client.connect(transport,signal?{signal}:undefined);
    const identity=connectionAccountIdentity(client,expectedIdentity);
    if(identity&&clientConfigFile)try{
      const instanceId=await localClientObservationInstance({identity,configFile:clientConfigFile,
        root:observationRoot??path.join(path.dirname(clientConfigFile),'client-observations')});
      const systemFamily=process.platform==='win32'?'Windows':process.platform==='darwin'?'macOS':
        process.platform==='linux'?(process.env.WSL_INTEROP||process.env.WSL_DISTRO_NAME?'WSL':'Linux'):'unknown';
      observation={contractVersion:'promptframe-client-observation/v1',instanceId,systemFamily,
        application:host.kind==='claude-code'?'Claude Code':host.kind==='antigravity'?'Antigravity':host.kind==='codex'?'Codex':'Creation',applicationVersion:CLIENT_VERSION};
    }catch{/* Missing private display metadata must not alter a valid grant. */}
    if(enforceMinimum)assertBridgeCompatible(client.getServerCapabilities(),CLIENT_VERSION);
    else readPlatformBridgePolicy(client.getServerCapabilities());
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
