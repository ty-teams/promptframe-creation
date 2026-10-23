import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {CLIENT_VERSION,CLIENT_PROTOCOL} from './version.mjs';

export async function connectPlatform(credentials) {
  const client = new Client(
    { name: "promptframe-creation-bridge", version: CLIENT_VERSION },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(credentials.endpoint),
    {
      requestInit: {
        headers: {
          Authorization: "Bearer " + credentials.token,
          "X-PromptFrame-Host-Kind": "codex",
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
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
