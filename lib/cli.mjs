#!/usr/bin/env node
import {CLIENT_VERSION} from "./version.mjs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CreationClientError,
  normalizeEndpoint,
  readCredentials,
  writeCredentials,
} from "./credentials.mjs";
import { connectPlatform } from "./connection.mjs";
import { createHostCallBridge } from "./host-context.mjs";
import {installForUser,profileCredentialsPath} from './user-installation.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2),
  command = args.shift(),
  value = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
const log = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const configFile=()=>value('--config')?path.resolve(value('--config')):
  profileCredentialsPath(value('--profile')??'default');
async function probe(credentials) {
  const client = await connectPlatform(credentials);
  try {
    return (await client.listTools()).tools.length;
  } finally {
    await client.close();
  }
}
async function tokenInput() {
  if (args.includes("--token-stdin")) {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 4096) throw new CreationClientError("token.too_long");
    }
    return text.trim();
  }
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function")
    throw new CreationClientError(
      "setup.interactive_tty_or_token_stdin_required",
    );
  process.stderr.write("创作 Token（不回显）：");
  const input = process.stdin,
    wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise((resolve, reject) => {
      let text = "";
      const read = (chunk) => {
        for (const byte of chunk) {
          if (byte === 3) {
            finish();
            reject(new CreationClientError("setup.cancelled"));
            return;
          }
          if (byte === 10 || byte === 13) {
            finish();
            resolve(text);
            return;
          }
          if (byte === 8 || byte === 127) text = text.slice(0, -1);
          else if (byte >= 32 && byte <= 126) text += String.fromCharCode(byte);
          if (text.length > 4096) {
            finish();
            reject(new CreationClientError("token.too_long"));
            return;
          }
        }
      };
      const finish = () => {
        input.removeListener("data", read);
        input.pause();
      };
      input.on("data", read);
    });
  } finally {
    input.setRawMode(Boolean(wasRaw));
    process.stderr.write("\n");
  }
}
async function setup({silent=false}={}) {
  const file = configFile(),
    existing = await readCredentials(file),
    requested = value("--endpoint");
  const endpoint = normalizeEndpoint(requested ?? existing?.endpoint ?? "");
  if (existing && existing.endpoint !== endpoint)
    throw new CreationClientError(
      "setup.different_endpoint_requires_separate_config",
    );
  if (existing && !args.includes("--replace")) {
    try {
      const tools = await probe(existing);
      const result={connected:true,reused:true,endpoint,tools};
      if(!silent)log(result);
      return result;
    } catch {
      throw new CreationClientError(
        "setup.saved_credential_unverified_retry_or_explicit_replace",
      );
    }
  }
  const studio = new URL(endpoint);
  studio.pathname = studio.pathname.replace(/\/api\/mcp$/, "/studio");
  studio.search = "?connectExternal=1";
  process.stderr.write(
    "在 Studio 登录，在“连接外部 Agent”生成或复制创作 Token。重复 setup 不会自动轮换。\n" +
      studio.href +
      "\n",
  );
  if (!args.includes("--no-open")) {
    const executable =
      process.platform === "darwin"
        ? "open"
        : process.platform === "linux"
          ? "xdg-open"
          : null;
    if (executable) {
      const child = spawn(executable, [studio.href], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => {});
      child.unref();
    }
  }
  const token = await tokenInput();
  if (!/^pf_create_[A-Za-z0-9_-]{43}$/.test(token))
    throw new CreationClientError("token.invalid");
  const credentials = {
    version: 1,
    endpoint,
    token,
    clientId: existing?.clientId ?? randomBytes(24).toString("base64url"),
    clientName: value("--name") ?? existing?.clientName ?? "Codex PromptFrame",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  // Verify before replacing the secure local file. This never calls a token
  // rotate API, starts a model, creates work or approves production.
  const tools = await probe(credentials);
  await writeCredentials(credentials, file);
  const result={connected:true,reused:false,endpoint,tools};
  if(!silent)log(result);
  return result;
}
async function bridge() {
  const credentials = await readCredentials(configFile());
  if (!credentials) throw new CreationClientError("setup.required");
  const client = await connectPlatform(credentials),
    host = createHostCallBridge(client),
    server = new Server(
      { name: "promptframe-creation", version: CLIENT_VERSION },
      { capabilities: { tools: {} } },
    );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await host.listTools();
    } catch {
      throw new Error("creation.connection_unresolved");
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await host.call(request.params);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              errorCode: error instanceof CreationClientError
                ? error.message : "creation.connection_unresolved",
              action: error instanceof CreationClientError
                ? error.message.startsWith("creation.host_")
                  ? "use_supported_codex_plugin_with_host_thread_identity"
                  : error.message === "creation.editor_not_current"
                    ? "request_control_and_confirm_in_studio"
                    : "read_current_platform_facts_without_replaying_business"
                : "read_original_task_or_retry_same_idempotency_key",
            }),
          },
        ],
      };
    }
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => {});
    await client.close().catch(() => {});
  };
  server.onclose = () => {
    void close();
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  await server.connect(new StdioServerTransport());
}
try {
  if (command === "setup") await setup();
  else if(command==='connect'||command==='install'){
    const connection=await setup({silent:true});
    const signal=new AbortController();
    const abort=()=>signal.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
    try{
      const installed=await installForUser({sourceRoot:fileURLToPath(new URL('..',import.meta.url)),
        profile:value('--profile')??'default',configFile:configFile(),signal:signal.signal});
      log({...connection,pluginRegistered:installed.registered,version:installed.version,
        installationReused:installed.reused,profile:installed.profile,
        next:installed.reloadRequired?'Open a new Codex chat or reload plugins, then use the creation Skill.':'Use the creation Skill in a chat that has this plugin loaded.',
        hostThreadIdentity:'verified_by_the_platform_on_actual_host_tool_calls'});
    }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
  }
  else if (command === "bridge") await bridge();
  else if(command==='--version')process.stdout.write(CLIENT_VERSION+'\n');
  else if (command === "status") {
    const saved = await readCredentials(configFile());
    if (!saved) throw new CreationClientError("setup.required");
    log({
      connected: true,
      endpoint: saved.endpoint,
      tools: await probe(saved),
    });
  } else if (command === "help" || command === "--help" || !command) {
    process.stdout.write(
      "promptframe-creation connect --endpoint <platform-api-base> [--profile <environment-account>] [--no-open]\npromptframe-creation setup --endpoint <platform-api-base> [--no-open] [--replace] [--name <client-name>]\npromptframe-creation status [--profile <environment-account>]\npromptframe-creation bridge [--config <private-file>]\npromptframe-creation --version\nNode.js >=20 and Codex >=0.160.0 are required for user-level plugin installation. Token input is masked in a terminal or accepted through --token-stdin; never use a Token command argument.\n",
    );
  } else throw new CreationClientError("command.unknown");
} catch (error) {
  // Never print raw SDK/fetch errors, response bodies or credentials.
  process.stderr.write(
    JSON.stringify({
      error:
        error instanceof CreationClientError
          ? error.message
          : "creation.connection_failed",
    }) + "\n",
  );
  process.exitCode = 1;
}
