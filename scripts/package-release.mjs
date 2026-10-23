import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACKAGE = "@promptframe/creation";
export const REPOSITORY = "ty-teams/promptframe-creation";
export const REGISTRY = "https://registry.npmjs.org/";
const root = fileURLToPath(new URL("..", import.meta.url));
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const fail = (reason) => { throw new Error(`creation_release.${reason}`); };
const digest = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options,
});

export function validateMetadata(pkg, lock, plugin) {
  if (pkg.name !== PACKAGE || lock.name !== PACKAGE || lock.packages?.[""]?.name !== PACKAGE)
    fail("package_name_mismatch");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version)) fail("stable_version_required");
  if ([lock.version, lock.packages?.[""]?.version, plugin.version].some((v) => v !== pkg.version))
    fail("version_mismatch");
  if (pkg.repository?.url !== `git+https://github.com/${REPOSITORY}.git`)
    fail("repository_mismatch");
  return pkg;
}

export function validateRelease(pkg, env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_EVENT_NAME !== "push"
    || env.GITHUB_REF !== `refs/tags/creation-v${pkg.version}`) fail("release_tag_mismatch");
  if (pkg.private !== false) fail("package_not_ready_private_must_be_false");
}

export function validateFiles(files) {
  const required = ["package.json", "README.md", "LICENSE", "bin/promptframe-creation.mjs",
    "lib/credentials.mjs", "lib/connection.mjs", "skills/video-creation/SKILL.md",
    ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", ".mcp.json",
    "dist/cli.mjs","dist/THIRD_PARTY_NOTICES.txt","skills/creation-setup/SKILL.md"];
  if (required.some((name) => !files.includes(name))) fail("package_file_missing");
  if (files.some((name) => !/^(?:package\.json|README\.md|LICENSE|\.mcp\.json|(?:bin|dist|lib|skills|docs|\.codex-plugin|\.agents\/plugins)\/[^\r\n]+)$/.test(name)
    || name.split("/").some((part) => part === "..")
    || /(?:^|\/)(?:node_modules|credentials\.json|\.env(?:\..*)?)$/.test(name))) fail("package_file_forbidden");
}

async function metadata() {
  return validateMetadata(await json(path.join(root, "package.json")),
    await json(path.join(root, "package-lock.json")), await json(path.join(root, ".codex-plugin/plugin.json")));
}

async function npmEnvironment(directory, { publishing = false } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:NODE_AUTH_TOKEN|NPM_TOKEN|NPM_ID_TOKEN|NPM_.*(?:TOKEN|PASSWORD)|npm_config_.*(?:auth|token|password))$/i.test(key)) {
      if (publishing && env[key]) fail("long_lived_credential_present");
      delete env[key];
    }
  }
  const config = path.join(directory, "empty.npmrc");
  await writeFile(config, "", { mode: 0o600 });
  return { ...env, NPM_CONFIG_USERCONFIG: config, NPM_CONFIG_REGISTRY: REGISTRY,
    NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" };
}

export async function pack(directory) {
  const pkg = await metadata();
  const {buildRuntime}=await import('./build-runtime.mjs');
  await buildRuntime();
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "creation-pack-"));
  try {
    const env = await npmEnvironment(temporary);
    const [result] = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root, env }));
    validateFiles(result.files.map((file) => file.path));
    const integrity = digest(await readFile(path.join(directory, result.filename)));
    if (integrity !== result.integrity) fail("pack_integrity_mismatch");
    const manifest = { schemaVersion: "creation-npm-artifact/v1", name: PACKAGE, version: pkg.version,
      sourceCommit: run("git", ["rev-parse", "HEAD"], { cwd: root }).trim(),
      filename: result.filename, integrity };
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await verify(directory);
    return manifest;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function verify(directory) {
  const pkg = await metadata(), manifest = await json(path.join(directory, "manifest.json"));
  const sourceCommit = run("git", ["rev-parse", "HEAD"], { cwd: root }).trim();
  if (manifest.schemaVersion !== "creation-npm-artifact/v1" || manifest.name !== PACKAGE
    || manifest.version !== pkg.version || manifest.sourceCommit !== sourceCommit
    || manifest.filename !== `promptframe-creation-${pkg.version}.tgz`) fail("artifact_binding_mismatch");
  const artifact = path.join(directory, manifest.filename);
  if (digest(await readFile(artifact)) !== manifest.integrity) fail("artifact_integrity_mismatch");
  const files = run("tar", ["-tzf", artifact]).trim().split("\n").map((name) => {
    if (!name.startsWith("package/")) fail("package_file_forbidden");
    return name.slice("package/".length);
  });
  validateFiles(files);
  const packed = JSON.parse(run("tar", ["-xOzf", artifact, "package/package.json"]));
  const plugin = JSON.parse(run("tar", ["-xOzf", artifact, "package/.codex-plugin/plugin.json"]));
  if (packed.name !== pkg.name || packed.version !== pkg.version || packed.private !== pkg.private
    || packed.repository?.url !== pkg.repository.url || plugin.version !== pkg.version)
    fail("packed_metadata_mismatch");
  return { pkg, manifest, artifact };
}

export async function smoke(directory) {
  const { artifact } = await verify(directory);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "creation-install-"));
  try {
    const env = { ...await npmEnvironment(temporary), XDG_CONFIG_HOME: path.join(temporary, "config"),
      PROMPTFRAME_CREATION_CONFIG: path.join(temporary, "config", "credentials.json") };
    run("npm", ["install", "--prefix", temporary, "--ignore-scripts", "--no-audit", "--no-fund", artifact], { cwd: temporary, env });
    const installed = path.join(temporary, "node_modules", "@promptframe", "creation");
    const output = run(process.execPath, [path.join(installed, "bin/promptframe-creation.mjs"), "--help"], { cwd: temporary, env });
    if (!output.includes("promptframe-creation setup")) fail("installed_cli_failed");
    await Promise.all([".mcp.json", ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json",
      "skills/video-creation/SKILL.md"].map((name) => readFile(path.join(installed, name))));
    return { status: "isolated_install_passed" };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function classifyPublished(metadata, manifest) {
  if (!metadata) return "absent";
  if (metadata.dist?.integrity !== manifest.integrity) fail("registry_integrity_conflict");
  if (metadata.name !== manifest.name || metadata.version !== manifest.version) fail("registry_identity_conflict");
  if (!metadata.dist?.attestations?.provenance) return "awaiting_provenance";
  return "complete";
}

export function validatePublishPlan(manifest, existing, latest) {
  const state = classifyPublished(existing, manifest);
  // npm creates this exact placeholder when staging a package for the first
  // time. It is not a functional release; an existing release must still wait
  // for latest to advance before the publication is considered complete.
  if (latest?.version === "0.0.0-stage") return state === "absent" ? "absent" : "awaiting_latest";
  if (latest) {
    if (!/^\d+\.\d+\.\d+$/.test(latest.version)) fail("registry_latest_version_unsupported");
    const previous = latest.version.split(".").map(Number), next = manifest.version.split(".").map(Number);
    const order = previous.reduce((result, value, index) => result || Math.sign(value - next[index]), 0);
    if (state === "absent" && order > 0) fail("release_older_than_latest");
    if (state !== "absent" && order < 0) return "awaiting_latest";
  } else if (state !== "absent") return "awaiting_latest";
  return state;
}

async function registryVersion(manifest, version = manifest.version) {
  const response = await fetch(`${REGISTRY}${encodeURIComponent(manifest.name)}/${version}`, {
    signal: AbortSignal.timeout(15000), headers: { accept: "application/json" }, cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) fail(`registry_http_${response.status}`);
  return response.json();
}

async function publish(directory) {
  const { pkg, manifest, artifact } = await verify(directory);
  validateRelease(pkg, process.env);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "creation-publish-"));
  try {
    const env = await npmEnvironment(temporary, { publishing: true });
    const match = run("npm", ["--version"], { env }).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match || Number(match[1]) < 11 || (Number(match[1]) === 11 && (Number(match[2]) < 5
      || (Number(match[2]) === 5 && Number(match[3]) < 1)))) fail("npm_oidc_version_unsupported");
    if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) fail("oidc_unavailable");
    const [existing, latest] = await Promise.all([registryVersion(manifest), registryVersion(manifest, "latest")]);
    const before = validatePublishPlan(manifest, existing, latest);
    if (before === "absent") {
      run("npm", ["publish", artifact, "--access", "public", "--tag", "latest", "--ignore-scripts",
        "--provenance", "--registry", REGISTRY], { cwd: temporary, env });
    }
    // A rerun only observes the same version. It never republishes an existing
    // version or moves latest backwards to an older release.
    for (let attempt = 0; attempt < 90; attempt++) {
      const [observed, currentLatest] = await Promise.all([registryVersion(manifest), registryVersion(manifest, "latest")]);
      if (validatePublishPlan(manifest, observed, currentLatest) === "complete") {
        if (before === "absent" && currentLatest.version !== manifest.version) fail("registry_latest_mismatch");
        return { status: before === "absent" ? "published" : "already_published", latest: currentLatest.version, ...manifest };
      }
      if (attempt < 89) await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    fail("registry_readback_pending_do_not_republish");
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, argument] = process.argv.slice(2), directory = argument && path.resolve(argument);
    let result;
    if (command === "check-release") {
      const pkg = await metadata(); validateRelease(pkg, process.env); result = { status: "release_ready", version: pkg.version };
    } else if (directory && command === "pack") result = await pack(directory);
    else if (directory && command === "smoke") result = await smoke(directory);
    else if (directory && command === "publish") result = await publish(directory);
    else fail("command_invalid");
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(/^creation_release\.[a-z_0-9]+$/.test(error.message) ? error.message : "creation_release.command_failed");
    process.exitCode = 1;
  }
}
