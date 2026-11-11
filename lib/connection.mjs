import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CLIENT_VERSION,CLIENT_PROTOCOL} from './version.mjs';
import {resolveHostIdentity} from './host-identity.mjs';
import {assertBridgeCompatible,declaredHostContentTypes} from './bridge-negotiation.mjs';

export async function connectPlatform(credentials,{host=resolveHostIdentity(),contentTypes=()=>['text'],contentSource=()=> 'text-fallback'}={}) {
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
        return fetch(url,{...init,headers});
      },
      requestInit: {
        headers: {
          Authorization: "Bearer " + credentials.token,
          "X-PromptFrame-Host-Kind": host.kind,
          "X-PromptFrame-Creation-Protocol": CLIENT_PROTOCOL,
          "X-PromptFrame-Client-Version": CLIENT_VERSION,
          "X-PromptFrame-Client-Id": credentials.clientId,
          "X-PromptFrame-Client-Name": encodeURIComponent(
            credentials.clientName,
          ),
        },
      },
    },
  );
  try {
    await client.connect(transport);
    assertBridgeCompatible(client.getServerCapabilities(),CLIENT_VERSION);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
