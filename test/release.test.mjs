import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PACKAGE, REPOSITORY, validateMetadata, validateRelease, validateFiles,
  classifyPublished, validatePublishPlan, pack, verify } from "../scripts/package-release.mjs";

const pkg = { name: PACKAGE, version: "0.1.0", private: false,
  repository: { url: `git+https://github.com/${REPOSITORY}.git` } };
const lock = { name: PACKAGE, version: pkg.version, packages: { "": { name: PACKAGE, version: pkg.version } } };
const plugin = { version: pkg.version };
const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/creation-v0.1.0" };

test("release metadata binds package, lock and plugin versions", () => {
  assert.equal(validateMetadata(pkg, lock, plugin), pkg);
  assert.throws(() => validateMetadata(pkg, lock, { version: "0.2.0" }), /version_mismatch/);
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
