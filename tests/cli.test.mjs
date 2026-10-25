import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('CLI help, version, and actionable input validation', async () => {
  const { stdout } = await run(process.execPath, ['bin/awp-renderer.mjs', '--help']);
  assert.match(stdout, /doctor/);
  assert.match(stdout, /--endpoint/);
  assert.equal(
    (await run(process.execPath, ['bin/awp-renderer.mjs', '--version'])).stdout.trim(),
    '0.1.0',
  );
  for (const args of [
    ['render'],
    ['render', 'examples/membership.json', '--scale', '2'],
    ['serve', '--host', '0.0.0.0'],
    ['oops'],
  ]) {
    await assert.rejects(
      run(process.execPath, ['bin/awp-renderer.mjs', ...args], {
        env: { ...process.env, AWP_RENDER_TOKEN: '' },
      }),
      (error) => error.code === 1 && error.stderr.startsWith('awp-renderer:'),
    );
  }
});
