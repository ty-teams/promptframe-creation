#!/usr/bin/env node
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
  credentialsPath,
  normalizeEndpoint,
  readCredentials,
  writeCredentials,
} from "../lib/credentials.mjs";
import { connectPlatform } from "../lib/connection.mjs";

const args = process.argv.slice(2),
  command = args.shift(),
  value = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
const log = (value) => process.stdout.write(JSON.stringify(value) + "\n");
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
async function setup() {
  const file = credentialsPath(),
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
      log({ connected: true, reused: true, endpoint, tools });
      return;
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
  log({ connected: true, reused: false, endpoint, tools });
}
async function bridge() {
  const credentials = await readCredentials();
  if (!credentials) throw new CreationClientError("setup.required");
  const client = await connectPlatform(credentials),
    server = new Server(
      { name: "promptframe-creation", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await client.listTools();
    } catch {
      throw new Error("creation.connection_unresolved");
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await client.callTool(request.params, undefined, {
        timeout: 60_000,
      });
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              errorCode: "creation.connection_unresolved",
              action: "read_original_task_or_retry_same_idempotency_key",
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
  else if (command === "bridge") await bridge();
  else if (command === "status") {
    const saved = await readCredentials();
    if (!saved) throw new CreationClientError("setup.required");
    log({
      connected: true,
      endpoint: saved.endpoint,
      tools: await probe(saved),
    });
  } else if (command === "help" || command === "--help" || !command) {
    process.stdout.write(
      "promptframe-creation setup --endpoint <platform-api-base> [--no-open] [--replace] [--name <client-name>]\npromptframe-creation status\npromptframe-creation bridge\n",
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
