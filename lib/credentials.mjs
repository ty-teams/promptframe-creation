import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export class CreationClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "CreationClientError";
  }
}
export function credentialsPath(env = process.env) {
  return path.resolve(
    env.PROMPTFRAME_CREATION_CONFIG ??
      path.join(
        env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
        "promptframe-creation",
        "credentials.json",
      ),
  );
}
export function normalizeEndpoint(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new CreationClientError("endpoint.invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  )
    throw new CreationClientError("endpoint.https_or_loopback_required");
  const base = url.href.replace(/\/+$/, "");
  if (base.endsWith("/api/mcp")) return base;
  if (base.endsWith("/api")) return base + "/mcp";
  throw new CreationClientError("endpoint.api_base_required");
}
const secure = async (file, directory = false) => {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (
    info.isSymbolicLink() ||
    !(directory ? info.isDirectory() : info.isFile()) ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new CreationClientError("credentials.private_owner_required");
  return info;
};
export async function readCredentials(file = credentialsPath()) {
  if (!(await secure(file))) return null;
  if (!(await secure(path.dirname(file), true)))
    throw new CreationClientError("credentials.private_owner_required");
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new CreationClientError("credentials.invalid");
  }
  if (
    value.version !== 1 ||
    typeof value.token !== "string" ||
    !/^pf_create_[A-Za-z0-9_-]{43}$/.test(value.token) ||
    typeof value.clientId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.clientId) ||
    typeof value.clientName !== "string" ||
    !value.clientName.trim() ||
    value.clientName.length > 160 ||
    /[\x00-\x1f\x7f]/.test(value.clientName)
  )
    throw new CreationClientError("credentials.invalid");
  return { ...value, endpoint: normalizeEndpoint(value.endpoint) };
}
export async function writeCredentials(value, file = credentialsPath()) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await secure(directory, true);
  await secure(file);
  const temporary = file + "." + randomBytes(12).toString("hex") + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
