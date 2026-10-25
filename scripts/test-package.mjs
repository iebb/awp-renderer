// Install the real tarball in a clean consumer, exercising runtime exports + CLI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const run = promisify(execFile),
  root = process.cwd();
await mkdir('artifacts', { recursive: true });
const { stdout } = await run('npm', [
  'pack',
  '--ignore-scripts',
  '--json',
  '--pack-destination',
  'artifacts',
]);
const [packed] = JSON.parse(stdout);
for (const file of [
  'LICENSE',
  'NOTICE',
  'dist/index.js',
  'dist/react/index.js',
  'dist/server/index.js',
  'native/capture-reference.swift',
  'playground/index.html',
  'bin/awp-renderer.mjs',
])
  assert.ok(
    packed.files.some((item) => item.path === file),
    `Missing package file: ${file}`,
  );
assert.ok(!packed.files.some((item) => /(^|\/)(node_modules|\.env|analysis)\//.test(item.path)));
const consumer = await mkdtemp(path.join(tmpdir(), 'awp-consumer-'));
try {
  await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}');
  await run(
    'npm',
    ['install', '--no-audit', '--no-fund', path.join(root, 'artifacts', packed.filename)],
    { cwd: consumer },
  );
  await assert.rejects(access(path.join(consumer, 'node_modules/react')));
  const core = `import {buildPassRenderArchive} from 'awp-renderer'; const zip=await buildPassRenderArchive({pass:{generic:{}}});if(!zip.size)throw Error('empty');console.log('core: OK without React');`;
  assert.match(
    (await run(process.execPath, ['--input-type=module', '-e', core], { cwd: consumer })).stdout,
    /core: OK/,
  );
  assert.match(
    (
      await run(process.execPath, ['node_modules/awp-renderer/bin/awp-renderer.mjs', '--help'], {
        cwd: consumer,
      })
    ).stdout,
    /JSON/,
  );
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', 'react@18.3.1', 'react-dom@18.3.1'],
    { cwd: consumer },
  );
  const react = `import React from 'react';import{renderToString}from'react-dom/server';import{PassRenderer}from'awp-renderer/react';const s=renderToString(React.createElement(PassRenderer,{pass:{generic:{}},enabled:false}));if(!s.includes('disabled'))throw Error(s);console.log('React 18 SSR: OK');`;
  assert.match(
    (await run(process.execPath, ['--input-type=module', '-e', react], { cwd: consumer })).stdout,
    /React 18 SSR: OK/,
  );
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@types/react@18', '@types/node@22'],
    { cwd: consumer },
  );
  await writeFile(
    path.join(consumer, 'consumer.mts'),
    `
import {renderPass, type PassRenderInput} from 'awp-renderer';
import {PassRenderer, type PassRendererProps} from 'awp-renderer/react';
import {createRendererServer} from 'awp-renderer/server';
const input: PassRenderInput = {pass: {generic: {}}};
const props: PassRendererProps = {...input, face: 'watch'};
void renderPass; void PassRenderer; void createRendererServer; void props;
`,
  );
  await run(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.mts',
    ],
    { cwd: consumer },
  );
  const server = `import{createRendererServer}from'awp-renderer/server';const s=createRendererServer();if(typeof s.listen!=='function')throw Error('server');console.log('server: OK');`;
  assert.match(
    (await run(process.execPath, ['--input-type=module', '-e', server], { cwd: consumer })).stdout,
    /server: OK/,
  );
  console.log(
    JSON.stringify({
      ok: true,
      package: packed.filename,
      bytes: packed.size,
      unpackedBytes: packed.unpackedSize,
      files: packed.files.length,
    }),
  );
} finally {
  await rm(consumer, { recursive: true, force: true });
}
