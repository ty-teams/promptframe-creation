import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Older fixture children also inherit this isolated directory. A test must
// never discover an account or host-session selection from a personal install.
const cwd = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), 'creation-test-accounts-'));
try {
  const requested = process.argv.slice(2);
  const files = readdirSync(path.join(cwd, 'test')).filter(name => name.endsWith('.test.mjs'))
    .sort().map(name => path.join('test', name));
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1',
    ...(requested.length ? requested : files)], {
    cwd, stdio: 'inherit',
    env: { ...process.env, PROMPTFRAME_ACCOUNT_DIRECTORY: root },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
