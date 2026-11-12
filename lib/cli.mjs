#!/usr/bin/env node
import {createLocalUploadManager} from './local-upload.mjs';
import {CLIENT_VERSION} from "./version.mjs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CreationClientError,
  normalizeEndpoint,
  readCredentials,
  writeCredentials,
} from "./credentials.mjs";
import { connectPlatform } from "./connection.mjs";
import { createHostCallBridge } from "./host-context.mjs";
import { resolveHostIdentity } from "./host-identity.mjs";
import {createClaudeHostSession,runClaudeHostHook} from './claude-host-session.mjs';
import {declaredHostContentCapabilities,readPlatformBridgePolicy,bridgeErrorDetails} from './bridge-negotiation.mjs';
import {selectBridgeRuntime,runtimeErrorDetails} from './runtime-bootstrap.mjs';
import {launchSelectedBridge} from './runtime-launch.mjs';
import {installForUser,profileCredentialsPath,installationErrorDetails} from './user-installation.mjs';
import {installForClaudeUser,claudeInstallationDetails} from './claude-installation.mjs';
import {claudeErrorDetails} from './claude-command.mjs';
import {fallbackErrorDetails} from './claude-mcp-installation.mjs';
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
  const client = await connectPlatform(credentials,{host:resolveHostIdentity({host:value('--host')})});
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
    clientName: value("--name") ?? existing?.clientName ?? (resolveHostIdentity({host:value('--host')}).kind==='claude-code'?'Claude Code PromptFrame':'Codex PromptFrame'),
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
  let contentTypes=['text'],contentSource='text-fallback';
  const identity=resolveHostIdentity({host:value('--host')}),startup=new AbortController(),abort=()=>startup.abort();
  let client,upstream,policy,selection;
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{
    client=await connectPlatform(credentials,{host:identity,contentTypes:()=>contentTypes,contentSource:()=>contentSource,
      enforceMinimum:false,signal:startup.signal});
    upstream=client.getServerCapabilities()??{};policy=readPlatformBridgePolicy(upstream);
    selection=await selectBridgeRuntime({policy,currentVersion:CLIENT_VERSION,lockedVersion:value('--bridge-version'),
      resolvedVersion:value('--resolved-runtime-version'),signal:startup.signal,hostKind:identity.kind,
      cacheRoot:path.join(path.dirname(configFile()),'runtime-cache')});
    startup.signal.throwIfAborted();
  }catch(error){await client?.close().catch(()=>{});
    if(startup.signal.aborted)throw new CreationClientError('creation.runtime_selection_interrupted');throw error;}
  finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
  if(!selection.current){
    await client.close();const result=await launchSelectedBridge(selection,{host:identity,configFile:configFile()});
    process.exitCode=result.code;return;
  }
  const hostSession=identity.kind==='claude-code'?await createClaudeHostSession({configFile:configFile()}):undefined;
  const server = new Server(
      { name: "promptframe-creation", version: CLIENT_VERSION },
      { capabilities: { tools: {listChanged:true},...(upstream.resources?{resources:{listChanged:true}}:{}),
        ...(upstream.prompts?{prompts:{listChanged:true}}:{}),
        experimental:{...(policy?{'promptframe.creation':policy}:{}),
          'promptframe.runtime':{version:selection.version,locked:selection.locked,status:selection.status}} } },
    ),
    host=createHostCallBridge(client,{credentials,host:identity,hostSession,
      localUploads:createLocalUploadManager({stateRoot:path.join(path.dirname(configFile()),'local-upload-state')}),onCatalogChange:()=>server.sendToolListChanged(),
      onKnowledgeChange:kind=>kind==='resources'?server.sendResourceListChanged():server.sendPromptListChanged()});
  server.oninitialized=()=>{const declared=declaredHostContentCapabilities(server.getClientCapabilities(),
      {initialized:true,standardContent:!!policy?.standardContentTypes});
    contentTypes=declared.types;contentSource=declared.source;};
  const knowledgeHandler=(schema,method)=>server.setRequestHandler(schema,async request=>{
    try{return await host[method](request.params??{});}catch(error){
      const remote=error?.data?.errorCode;
      const code=error instanceof CreationClientError?error.message
        :typeof remote==='string'&&/^(?:creation|creative_skill)\.[a-z0-9_.:-]{1,160}$/.test(remote)
          ?remote:'creation.connection_unresolved';
      const knownRemote=typeof remote==='string'&&code===remote
        &&typeof error.code==='number'&&Object.values(ErrorCode).includes(error.code);
      throw new McpError(knownRemote?error.code:error instanceof CreationClientError
        ?ErrorCode.InvalidParams:ErrorCode.InternalError,code,{errorCode:code});
    }
  });
  if(upstream.resources){
    knowledgeHandler(ListResourcesRequestSchema,'listResources');
    knowledgeHandler(ListResourceTemplatesRequestSchema,'listResourceTemplates');
    knowledgeHandler(ReadResourceRequestSchema,'readResource');
  }
  if(upstream.prompts){
    knowledgeHandler(ListPromptsRequestSchema,'listPrompts');
    knowledgeHandler(GetPromptRequestSchema,'getPrompt');
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await host.listTools();
    } catch {
      throw new Error("creation.connection_unresolved");
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request,extra) => {
    try {
      return await host.call(request.params,{signal:extra.signal});
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
              ...(error instanceof CreationClientError&&error.message==='creation.host_session_changed'
                ?{effectStatus:'unknown',automaticReplayAllowed:false}:{}),
              action: error instanceof CreationClientError
                ? error.message==='creation.host_session_changed'?'read_original_task_without_replaying_business':error.message.startsWith("creation.host_")
                  ? "use_supported_host_with_session_identity"
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
    await host.close();
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
      const host=resolveHostIdentity({host:value('--host')}),installer=host.kind==='claude-code'?installForClaudeUser:installForUser;
      const installed=await installer({sourceRoot:fileURLToPath(new URL('..',import.meta.url)),
        executable:value('--claude-bin'),profile:value('--profile')??'default',configFile:configFile(),signal:signal.signal});
      const skillNames=installed.skills?.map(skill=>skill.name)??['creation-setup','video-creation'];
      log({...connection,pluginRegistered:(installed.pluginInstalled??true)&&installed.registered,
        mcpRegistered:installed.registered,version:installed.version,
        host:host.kind,pluginInstalled:installed.pluginInstalled??true,pluginEnabled:installed.pluginEnabled??true,
        ...(installed.installationMode?{installationMode:installed.installationMode,skillsInstalled:installed.skillsInstalled,skills:skillNames}:{}),
        hostMcpConnected:'not_verified',sessionLoaded:'not_verified',
        installationReused:installed.reused,profile:installed.profile,
        requestedVersion:installed.requestedVersion,versionStatus:installed.versionStatus,
        recordedRuntimeRetained:installed.recordedRuntimeRetained??false,
        next:(host.kind==='claude-code'?'On this host, start a new Claude Code session.':'On this host, open a new Local chat (CLI: start a new session).')+' Check '+skillNames.join(', ')+' and the PromptFrame MCP tools together. Keep the existing Token; no reinstall or product repository is needed.'+(installed.recordedRuntimeRetained?' Keep this version\'s recorded Node path available.':''),
        hostThreadIdentity:'verified_by_the_platform_on_actual_host_tool_calls'});
    }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
  }
  else if (command === "bridge") await bridge();
  else if(command==='claude-host-hook')await runClaudeHostHook({configFile:configFile()});
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
      "promptframe-creation connect --endpoint <platform-api-base> [--host codex|claude-code] [--profile <environment-account>] [--claude-bin <absolute-file>] [--no-open]\npromptframe-creation setup --endpoint <platform-api-base> [--host codex|claude-code] [--no-open] [--replace] [--name <client-name>]\npromptframe-creation status [--profile <environment-account>] [--host codex|claude-code]\npromptframe-creation bridge [--config <private-file>] [--host codex|claude-code] [--bridge-version <X.Y.Z>]\npromptframe-creation --version\nNode.js >=20 is required. Plugin installation supports Codex >=0.160.0 or Claude Code >=2.1.295 with its structured plugin commands. Token input is masked in a terminal or accepted through --token-stdin; never use a Token command argument.\nBridge startup checks the platform minimum/recommended version. --bridge-version locks one exact compatible version for this new session; active bridges are not replaced.\n",
    );
  } else throw new CreationClientError("command.unknown");
} catch (error) {
  // Never print raw SDK/fetch errors, response bodies or credentials.
  process.stderr.write(
    JSON.stringify({
      ...installationErrorDetails(error),
      ...claudeInstallationDetails(error),
      ...claudeErrorDetails(error),
      ...fallbackErrorDetails(error),
      ...bridgeErrorDetails(error),
      ...runtimeErrorDetails(error),
      error:
        error instanceof CreationClientError
          ? error.message
          : "creation.connection_failed",
    }) + "\n",
  );
  process.exitCode = 1;
}
