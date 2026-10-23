import { CreationClientError } from "./credentials.mjs";

const observations = new Set([
  "platform_list_projects", "platform_list_sessions", "platform_read_session",
  "platform_list_tools", "platform_describe_tool", "platform_list_tasks",
  "platform_task", "platform_read_budget",
]);
const threadFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hostParameters(params) {
  const thread = params._meta?.threadId;
  if (thread === undefined) {
    if (observations.has(params.name)) return params;
    throw new CreationClientError("creation.host_identity_required");
  }
  if (typeof thread !== "string" || !threadFormat.test(thread))
    throw new CreationClientError("creation.host_identity_invalid");
  return params;
}

const controlled = new Set([
  "platform_call_tool", "platform_save_brief", "platform_release_control", "platform_handoff",
]);
const authorityReads = new Set([
  "platform_create_session", "platform_read_session", "platform_request_control",
  "platform_release_control", "platform_handoff",
]);
const data = (result) => {
  const text = result.content?.find((part) => part.type === "text")?.text;
  try { return text ? JSON.parse(text) : null; } catch { return null; }
};

/** A bridge process freezes its endpoint/account/installation credentials at
 * startup. Inside that boundary each host thread and work has its own approved
 * generation cache. Cache loss only causes an authoritative ownership read;
 * neither that read nor a schema refresh requests or grants control. */
export function createHostCallBridge(client) {
  const versions = new Map();
  const keyFor = (params) => {
    const { projectId, sessionId } = params.arguments ?? {};
    if (typeof projectId !== "string" || typeof sessionId !== "string"
      || !projectId || !sessionId || projectId.length > 160 || sessionId.length > 160)
      return null;
    return JSON.stringify([params._meta?.threadId?.toLowerCase(), projectId, sessionId]);
  };
  const remember = (params, result) => {
    if (!authorityReads.has(params.name)) return;
    const value = data(result);
    if (result.isError || !value) return;
    const target = params.name === "platform_create_session"
      && value.projectId === params.arguments?.projectId && typeof value.sessionId === "string"
      ? { ...params, arguments: { ...params.arguments, sessionId: value.sessionId } } : params;
    const key = keyFor(target);
    if (!key || !value.control) return;
    if (params.name === "platform_read_session" && value.sessionId !== params.arguments.sessionId) {
      versions.delete(key);
      return;
    }
    const control = value.control;
    if (control.editor?.kind === "client" && control.editor.isCurrentClient === true
      && Number.isSafeInteger(control.controlVersion) && control.controlVersion > 0) {
      versions.delete(key);
      if (versions.size >= 1024) versions.delete(versions.keys().next().value);
      versions.set(key, control.controlVersion);
    } else versions.delete(key);
  };
  const send = (params) => client.callTool(params, undefined, { timeout: 60_000 });
  return {
    async listTools() {
      const result = await client.listTools();
      return { ...result, tools: result.tools.map((tool) => {
        if (!controlled.has(tool.name)) return tool;
        const { controlVersion: _managed, ...properties } = tool.inputSchema.properties ?? {};
        return { ...tool, inputSchema: { ...tool.inputSchema, properties,
          ...(tool.inputSchema.required ? {
            required: tool.inputSchema.required.filter((name) => name !== "controlVersion"),
          } : {}),
        } };
      }) };
    },
    async call(raw) {
      const params = hostParameters(raw);
      for (const field of ["threadId", "controller", "clientDigest", "token", "controlVersion"])
        if (Object.hasOwn(params.arguments ?? {}, field))
          throw new CreationClientError("creation.transport_authority_managed_by_bridge");
      const key = keyFor(params);
      let outgoing = params;
      if (controlled.has(params.name)) {
        if (!key) throw new CreationClientError("creation.request_invalid");
        if (!versions.has(key)) {
          const read = { name: "platform_read_session", _meta: params._meta,
            arguments: { projectId: params.arguments.projectId, sessionId: params.arguments.sessionId, pageSize: 1 } };
          const result = await send(read);
          if (result.isError) return result;
          remember(read, result);
          if (!versions.has(key)) {
            if (!data(result)?.control) throw new CreationClientError("creation.control_unverified");
            throw new CreationClientError("creation.editor_not_current");
          }
        }
        outgoing = { ...params, arguments: { ...params.arguments, controlVersion: versions.get(key) } };
      }
      const result = await send(outgoing);
      if (result.isError && key) versions.delete(key);
      else remember(params, result);
      return result;
    },
  };
}
