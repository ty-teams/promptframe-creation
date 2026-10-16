import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, readFile, rm, chmod, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { normalizeEndpoint, readCredentials } from "../lib/credentials.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)),
  bin = path.join(root, "bin/promptframe-creation.mjs");
const cli = (args, config, input = "") =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, PROMPTFRAME_CREATION_CONFIG: config },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });

test("secure setup reuses the grant and stdio forwards an unchanged persistent-task result", async () => {
  const temporary = await mkdtemp(
      path.join(os.tmpdir(), "promptframe-creation-test-"),
    ),
    config = path.join(temporary, "credentials.json");
  const token = "pf_create_" + randomBytes(32).toString("base64url"),
    headers = [],
    calls = [];
  const server = http.createServer(async (req, res) => {
    headers.push(req.headers);
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }
    const chunks = [];
    for await (const x of req) chunks.push(x);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const mcp = new Server(
      { name: "local-protocol-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "platform_call_tool", inputSchema: { type: "object" } }],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (message) => {
      calls.push(message.params);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              taskId: "own-protocol-task",
              executionId: "own-protocol-execution",
              status: "waiting",
              originalDeadline: "2030-01-01T00:00:00.000Z",
              source: "local_protocol_fixture",
            }),
          },
        ],
      };
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await mcp.connect(transport);
    res.once("close", () => {
      void mcp.close();
    });
    await transport.handleRequest(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/mcp`;
  let client;
  try {
    const setup = await cli(
      ["setup", "--endpoint", endpoint, "--no-open", "--token-stdin"],
      config,
      token + "\n",
    );
    assert.equal(setup.code, 0, setup.stderr);
    assert.equal(JSON.parse(setup.stdout).reused, false);
    assert.equal((await stat(config)).mode & 0o077, 0);
    assert.equal((await stat(temporary)).mode & 0o077, 0);
    const stored = await readFile(config, "utf8"),
      identity = (await readCredentials(config)).clientId;
    const again = await cli(
      ["setup", "--endpoint", endpoint, "--no-open"],
      config,
    );
    assert.equal(again.code, 0);
    assert.equal(JSON.parse(again.stdout).reused, true);
    assert.equal(await readFile(config, "utf8"), stored);
    assert.equal(
      calls.length,
      0,
      "setup has no token rotation, approval or business call",
    );
    assert.ok(
      !setup.stdout.includes(token) &&
        !setup.stderr.includes(token) &&
        !again.stdout.includes(token),
    );
    client = new Client(
      { name: "clean-supported-sdk-client", version: "1" },
      { capabilities: {} },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bin, "bridge"],
        env: { PROMPTFRAME_CREATION_CONFIG: config },
        stderr: "pipe",
      }),
    );
    assert.equal(
      (await client.listTools()).tools[0].name,
      "platform_call_tool",
    );
    const request = {
      name: "platform_call_tool",
      arguments: {
        projectId: "own-project",
        sessionId: "own-work",
        tool: "own_async_fixture",
        arguments: { text: "Own protocol fixture" },
        controlVersion: 2,
        expectedRevision: 1,
        idempotencyKey: "same-original-request",
      },
    };
    const result = await client.callTool(request),
      value = JSON.parse(result.content[0].text);
    assert.deepEqual(calls[0], request);
    assert.equal(value.taskId, "own-protocol-task");
    assert.equal(value.status, "waiting");
    assert.equal(value.originalDeadline, "2030-01-01T00:00:00.000Z");
    assert.ok(headers.every((h) => h["x-promptframe-client-id"] === identity));
    assert.ok(headers.every((h) => h.authorization === "Bearer " + token));
    await client.close();
    client = null;
    await chmod(config, 0o644);
    await assert.rejects(readCredentials(config), /private_owner_required/);
    const denied = await cli(["status"], config);
    assert.equal(denied.code, 1);
    assert.ok(!denied.stderr.includes(token));
  } finally {
    await client?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test("endpoint normalization rejects credential URLs and remote cleartext", () => {
  assert.equal(
    normalizeEndpoint("https://video.example/api"),
    "https://video.example/api/mcp",
  );
  assert.equal(
    normalizeEndpoint("http://localhost:3500/api/mcp/"),
    "http://localhost:3500/api/mcp",
  );
  for (const value of [
    "http://remote.example/api",
    "https://user:secret@video.example/api",
    "https://video.example/api?token=secret",
    "file:///api",
  ])
    assert.throws(() => normalizeEndpoint(value));
});
