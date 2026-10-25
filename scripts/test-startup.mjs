#!/usr/bin/env node
// Fault injection exercises real child exits and the rendering engine's queue,
// bounded restart and cleanup. No pass-dependent crash is eligible for retry.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

const originalSpawn = childProcess.spawn;
let mode = 'normal';
let calls = 0;
let cancellation;
const serialPrefix = `awp-startup-test-${process.pid}-${Date.now()}-`;
childProcess.spawn = (executable, args, options) => {
  if (args?.[2] === '343' && args?.[4] === 'front') {
    calls++;
    if (
      mode === 'always-before' ||
      mode === 'cancel-before' ||
      (mode === 'once-before' && calls === 1)
    ) {
      const child = originalSpawn('/bin/sh', ['-c', 'kill -ABRT $$'], options);
      if (mode === 'cancel-before') queueMicrotask(() => cancellation.abort());
      return child;
    }
    if (mode === 'after-marker') {
      return originalSpawn(
        '/bin/sh',
        ['-c', "printf 'PASSMK_RENDER_STARTED\\n'; kill -ABRT $$"],
        options,
      );
    }
  }
  return originalSpawn(executable, args, options);
};
syncBuiltinESMExports();
const { renderNativePass, NativeRenderError } = await import('../dist/server/native.js');
const zip = new JSZip();
const originalJson = JSON.parse(
  await fs.readFile(new URL('../examples/membership.json', import.meta.url), 'utf8'),
);
const group = path.join(homedir(), 'Library/Group Containers/group.com.apple.passdesigner');
const spools = async () =>
  (
    await Promise.all(
      (await fs.readdir(group))
        .filter((name) => name.startsWith('awp-preview-'))
        .map(async (name) => {
          try {
            const pass = JSON.parse(
              await fs.readFile(path.join(group, name, 'preview.pkpasstemplate/pass.json'), 'utf8'),
            );
            return pass.serialNumber?.startsWith(serialPrefix) ? name : null;
          } catch {
            return null;
          }
        }),
    )
  ).filter(Boolean);
const results = [];
const output = path.resolve(
  process.env.AWP_STARTUP_TEST_OUTPUT || path.join(tmpdir(), 'awp-worker-startup-verification'),
);
await fs.mkdir(output, { recursive: true });
try {
  for (const [testMode, expectedCalls, success] of [
    ['once-before', 2, true],
    ['always-before', 2, false],
    ['after-marker', 1, false],
    ['cancel-before', 1, false],
    ['normal', 1, true],
  ]) {
    mode = testMode;
    calls = 0;
    cancellation = new AbortController();
    zip.file(
      'pass.json',
      JSON.stringify({ ...originalJson, serialNumber: serialPrefix + testMode }),
    );
    let result;
    let failure;
    try {
      result = await renderNativePass(await zip.generateAsync({ type: 'nodebuffer' }), {
        face: 'front',
        scale: 4,
        signal: cancellation.signal,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(calls, expectedCalls, `${testMode}: unexpected process count`);
    if (success) {
      assert.equal(failure, undefined);
      assert.equal(result.source, 'pass-designer');
      await fs.writeFile(path.join(output, `${testMode}.api.json`), JSON.stringify(result));
    } else {
      assert(failure instanceof NativeRenderError);
      assert.equal(failure.status, testMode === 'cancel-before' ? 499 : 500);
      if (testMode !== 'cancel-before')
        assert.equal(failure.workerStartupAborted, testMode === 'always-before');
    }
    const leaked = await spools();
    assert.deepEqual(leaked, [], `${testMode}: input directory leaked`);
    results.push({
      mode: testMode,
      processCount: calls,
      succeeded: !!result,
      newSpools: leaked.length,
      passed: true,
    });
    console.log(`${testMode}: passed (${calls} process${calls === 1 ? '' : 'es'})`);
  }
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
await fs.writeFile(
  path.join(output, 'report.json'),
  JSON.stringify(
    { total: results.length, passed: results.filter((r) => r.passed).length, results },
    null,
    2,
  ) + '\n',
);
