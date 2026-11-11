import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from "node:fs/promises";
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from "node:os";
import path from "node:path";
import { PACKAGE, REPOSITORY, validateMetadata, validateRelease, validateFiles,
  classifyPublished, validatePublishPlan, pack, verify } from "../scripts/package-release.mjs";

const pkg = { name: PACKAGE, version: "0.1.0", private: false,
  repository: { url: `git+https://github.com/${REPOSITORY}.git` } };
const lock = { name: PACKAGE, version: pkg.version, packages: { "": { name: PACKAGE, version: pkg.version } } };
const plugin = { version: pkg.version };
const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/creation-v0.1.0" };

test('tag preflight and publisher module load before npm ci without build dependencies',async()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));const tmp=await mkdtemp(path.join(os.tmpdir(),'creation-release-preflight-'));
 try{
  await mkdir(path.join(tmp,'scripts'));await mkdir(path.join(tmp,'.codex-plugin'));await mkdir(path.join(tmp,'.claude-plugin'));
  for(const file of ['package.json','package-lock.json','.codex-plugin/plugin.json','.claude-plugin/plugin.json','scripts/package-release.mjs','scripts/build-runtime.mjs'])
   await cp(path.join(root,file),path.join(tmp,file));
  const pkg=JSON.parse(await readFile(path.join(tmp,'package.json'),'utf8'));
  const result=execFileSync(process.execPath,[path.join(tmp,'scripts/package-release.mjs'),'check-release'],{
   cwd:tmp,encoding:'utf8',env:{...process.env,GITHUB_REPOSITORY:REPOSITORY,GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/tags/creation-v'+pkg.version},
  });
  assert.equal(JSON.parse(result).status,'release_ready');
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test("release metadata binds package, lock and plugin versions", () => {
  assert.equal(validateMetadata(pkg, lock, plugin), pkg);
  assert.throws(() => validateMetadata(pkg, lock, { version: "0.2.0" }), /version_mismatch/);
  assert.throws(() => validateMetadata(pkg, lock, plugin, {version:'0.2.0'}), /version_mismatch/);
  assert.throws(() => validateMetadata(pkg, { ...lock, version: "0.2.0" }, plugin), /version_mismatch/);
  assert.throws(() => validateMetadata({ ...pkg, name: "other" }, lock, plugin), /package_name_mismatch/);
});

test("only an explicit public release with the exact repository and tag can publish", () => {
  validateRelease(pkg, env);
  assert.throws(() => validateRelease({ ...pkg, private: true }, env), /package_not_ready/);
  assert.throws(() => validateRelease({ ...pkg, private: undefined }, env), /package_not_ready/);
  for (const altered of [{ GITHUB_REPOSITORY: "other/fork" }, { GITHUB_REF: "refs/heads/main" },
    { GITHUB_REF: "refs/tags/creation-v0.2.0" }, { GITHUB_EVENT_NAME: "workflow_dispatch" }])
    assert.throws(() => validateRelease(pkg, { ...env, ...altered }), /release_tag_mismatch/);
});

test("the packed artifact preserves hidden plugin entries and rejects private files or tampering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "creation-artifact-test-"));
  try {
    const manifest = await pack(directory);
    const { artifact } = await verify(directory);
    const bytes = await readFile(artifact);
    await writeFile(artifact, Buffer.concat([bytes, Buffer.from("changed")]));
    await assert.rejects(verify(directory), /artifact_integrity_mismatch/);
    await writeFile(artifact, bytes);
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, filename: "../other.tgz" }));
    await assert.rejects(verify(directory), /artifact_binding_mismatch/);
    const required = ["package.json", "README.md", "LICENSE", "bin/promptframe-creation.mjs",
      "lib/credentials.mjs", "lib/connection.mjs", "skills/video-creation/SKILL.md",
      ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", ".mcp.json",
      ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".claude-mcp.json",
      "dist/cli.mjs","dist/THIRD_PARTY_NOTICES.txt","skills/creation-setup/SKILL.md"];
    assert.throws(() => validateFiles(required.slice(1)), /package_file_missing/);
    for (const name of ["credentials.json", "lib/credentials.json", "docs/.env", "test/private.mjs", "lib/../private.mjs"])
      assert.throws(() => validateFiles([...required, name]), /package_file_forbidden/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("registry reruns require matching bytes and provenance without republishing", () => {
  const manifest = { name: PACKAGE, version: "0.1.0", integrity: "sha512-fixed" };
  const metadata = { ...manifest, dist: { integrity: manifest.integrity, attestations: { provenance: {} } } };
  assert.equal(classifyPublished(null, manifest), "absent");
  assert.equal(classifyPublished(metadata, manifest), "complete");
  assert.equal(classifyPublished({ ...metadata, dist: { integrity: manifest.integrity } }, manifest), "awaiting_provenance");
  assert.throws(() => classifyPublished({ ...metadata, dist: { integrity: "sha512-other" } }, manifest), /integrity_conflict/);
  assert.throws(() => validatePublishPlan(manifest, null, { version: "0.2.0" }), /release_older_than_latest/);
  assert.equal(validatePublishPlan(manifest, null, { version: "0.0.9" }), "absent");
  assert.equal(validatePublishPlan(manifest, metadata, { version: "0.2.0" }), "complete");
  assert.equal(validatePublishPlan(manifest, metadata, null), "awaiting_latest");
  assert.equal(validatePublishPlan(manifest, metadata, { version: "0.0.9" }), "awaiting_latest");
});

test("npm's first-package stage placeholder permits publishing but never proves completion", () => {
  const manifest = { name: PACKAGE, version: "0.1.0", integrity: "sha512-fixed" };
  const placeholder = { version: "0.0.0-stage" };
  const metadata = { ...manifest, dist: { integrity: manifest.integrity, attestations: { provenance: {} } } };
  assert.equal(validatePublishPlan(manifest, null, placeholder), "absent");
  assert.equal(validatePublishPlan(manifest, metadata, placeholder), "awaiting_latest");
  assert.equal(validatePublishPlan(manifest, { ...metadata, dist: { integrity: manifest.integrity } }, placeholder), "awaiting_latest");
  assert.throws(() => validatePublishPlan(manifest, { ...metadata, dist: { integrity: "sha512-other" } }, placeholder), /integrity_conflict/);
  assert.throws(() => validatePublishPlan(manifest, { ...metadata, name: "other" }, placeholder), /identity_conflict/);
  assert.equal(validatePublishPlan(manifest, { ...metadata, dist: { integrity: manifest.integrity } }, manifest), "awaiting_provenance");
  for (const version of ["0.0.0-preview", "0.1.0-beta.1", "0.2.0-stage"])
    assert.throws(() => validatePublishPlan(manifest, null, { version }), /registry_latest_version_unsupported/);
});

test('marked current instructions follow package version while historical examples remain exact',async()=>{
 const {renderInstallGuidance,INSTALL_GUIDANCE_FILES,installGuidanceManifest}=await import('../scripts/install-guidance.mjs');
 const root=fileURLToPath(new URL('..',import.meta.url)),pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 const example='<!-- creation-install-command -->npx --yes @promptframe/creation@0.1.0 connect --endpoint <API><!-- /creation-install-command -->\nHistorical: @promptframe/creation@0.1.1';
 const current=renderInstallGuidance(example,pkg.version);assert(current.includes('@promptframe/creation@'+pkg.version+' connect'));
 assert(current.includes('Historical: @promptframe/creation@0.1.1'));assert.equal(renderInstallGuidance(current,pkg.version),current);
 for(const file of INSTALL_GUIDANCE_FILES){const body=await readFile(path.join(root,file),'utf8');
  assert.equal(renderInstallGuidance(body,pkg.version),body,file);for(const command of body.matchAll(/@promptframe\/creation@(\d+\.\d+\.\d+) connect/g))assert.equal(command[1],pkg.version,file);}
 assert.throws(()=>renderInstallGuidance('unmarked',pkg.version),/guidance_marker_invalid/);
 assert.throws(()=>renderInstallGuidance('<!-- creation-install-command -->bad<!-- /creation-install-command -->',pkg.version),/guidance_command_invalid/);
 const manifest=JSON.parse(await readFile(path.join(root,'docs/install-guidance.json'),'utf8'));
 assert.deepEqual(manifest,installGuidanceManifest(pkg.version));
 assert.deepEqual(manifest.hosts.map(h=>h.kind),['codex','claude-code']);
 assert.equal(manifest.hosts[1].minimumBridge,'0.3.0','new host support is not retroactively claimed for old public versions');
 assert.deepEqual(manifest.hosts[1].commandArgs,['connect','--host','claude-code','--endpoint','{{endpoint}}']);
});
