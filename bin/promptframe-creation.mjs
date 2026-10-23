#!/usr/bin/env node
if (Number(process.versions.node.split('.')[0]) < 20) {
  process.stderr.write('{"error":"creation.node_20_required","action":"Install Node.js 20 or newer, then repeat the same command."}\n');
  process.exitCode = 1;
} else {
  try { await import('../dist/cli.mjs'); }
  catch { process.stderr.write('{"error":"creation.runtime_bundle_unavailable","action":"Reinstall this complete package version; keep existing credentials."}\n'); process.exitCode = 1; }
}
