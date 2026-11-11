import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CLIENT_VERSION,CLIENT_PROTOCOL} from './version.mjs';
import {resolveHostIdentity,hostClientName} from './host-identity.mjs';
import {assertBridgeCompatible,declaredHostContentTypes,readPlatformBridgePolicy} from './bridge-negotiation.mjs';

export async function connectPlatform(credentials,{host=resolveHostIdentity(),contentTypes=()=>['text'],contentSource=()=> 'text-fallback',enforceMinimum=true,signal}={}) {
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
    if(enforceMinimum)assertBridgeCompatible(client.getServerCapabilities(),CLIENT_VERSION);
    else readPlatformBridgePolicy(client.getServerCapabilities());
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
