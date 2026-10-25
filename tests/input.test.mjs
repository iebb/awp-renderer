#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  buildPassRenderArchive,
  passRenderInputFromArchive,
  passAssetsKey,
  serializePassJson,
} from '../dist/core/input.js';
import { renderPass, renderPassArchive, PassRendererError } from '../dist/core/client.js';

const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=',
    'base64',
  ),
);
const pass = {
  formatVersion: 1,
  organizationName: 'Demo',
  unknownOption: { keep: true },
  generic: {
    primaryFields: [{ key: '', label: '名字', value: 'W'.repeat(200000), custom: false }],
  },
  barcodes: [
    { format: 'PKBarcodeFormatQR', message: 'one' },
    { format: 'PKBarcodeFormatAztec', message: 'two' },
  ],
};

test('JSON strings, long fields, multiple barcodes and resource bytes survive packaging', async () => {
  const source = JSON.stringify(pass, null, 1);
  const strings = new TextEncoder().encode('"名字" = "姓名";');
  const blob = await buildPassRenderArchive({
    pass: source,
    assets: { 'logo@2x.png': png, 'zh-CN.lproj/pass.strings': new Blob([strings]) },
  });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.equal(await zip.file('pass.json').async('string'), source);
  assert.deepEqual(await zip.file('logo@2x.png').async('uint8array'), png);
  assert.deepEqual(await zip.file('zh-CN.lproj/pass.strings').async('uint8array'), strings);
  assert.equal(zip.file('manifest.json'), null);
});

test('archive input bypasses editor defaults and preserves all supported resources', async () => {
  const original = await buildPassRenderArchive({ pass, assets: { 'thumbnail@3x.png': png } });
  const input = await passRenderInputFromArchive(original);
  assert.deepEqual(JSON.parse(input.pass), pass);
  const repacked = await JSZip.loadAsync(await (await buildPassRenderArchive(input)).arrayBuffer());
  assert.deepEqual(await repacked.file('thumbnail@3x.png').async('uint8array'), png);
  assert.equal(
    JSON.parse(await repacked.file('pass.json').async('string')).backgroundColor,
    undefined,
  );
});

test('rejects invalid JSON, unsafe/reserved filenames and invalid image data', async () => {
  for (const value of [
    '{',
    '[]',
    'null',
    '"text"',
    '{"generic":{},"value":"' + 'x'.repeat(262144) + '"}',
  ])
    assert.throws(() => serializePassJson(value));
  for (const name of [
    '../logo.png',
    '/logo.png',
    'pass.json',
    'manifest.json',
    'en.lproj/../../logo.png',
    'photo.jpg',
  ])
    await assert.rejects(
      buildPassRenderArchive({ pass: {}, assets: { [name]: png } }),
      /asset name/,
    );
  await assert.rejects(
    buildPassRenderArchive({ pass: {}, assets: { 'logo.png': new Uint8Array([1, 2]) } }),
    /must be PNG/,
  );
  await assert.rejects(
    buildPassRenderArchive({
      pass: {},
      assets: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`asset${i}.png`, png])),
    }),
    /too many assets/,
  );
});

test('stable URL/immutable binary inputs have stable resource keys', () => {
  const blob = new Blob([png]);
  assert.equal(
    passAssetsKey({ 'logo.png': blob, 'icon.png': '/icon.png' }),
    passAssetsKey({ 'icon.png': '/icon.png', 'logo.png': blob }),
  );
  assert.notEqual(
    passAssetsKey({ 'logo.png': blob }),
    passAssetsKey({ 'logo.png': new Blob([png]) }),
  );
});

test('equivalent input packages identically without extra ZIP directory entries', async () => {
  const strings = new TextEncoder().encode('"name" = "Name";');
  const a = await buildPassRenderArchive({
    pass: {},
    assets: { 'logo.png': png, 'en.lproj/pass.strings': strings },
  });
  const b = await buildPassRenderArchive({
    pass: {},
    assets: { 'en.lproj/pass.strings': strings, 'logo.png': new Uint8Array(png) },
  });
  assert.deepEqual(new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer()));
  const zip = await JSZip.loadAsync(await a.arrayBuffer());
  assert.equal(Object.keys(zip.files).length, 3);
});

test('an already cancelled input stops before downloading assets', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    buildPassRenderArchive({ pass: {}, assets: { 'logo.png': png } }, controller.signal),
    { name: 'AbortError' },
  );
});

test('data URL assets retain their original PNG bytes', async () => {
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  const blob = await buildPassRenderArchive({ pass: {}, assets: { 'icon.png': dataUrl } });
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.deepEqual(await zip.file('icon.png').async('uint8array'), png);
});

test('oversized streamed assets are cancelled before accumulation completes', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  try {
    await assert.rejects(
      buildPassRenderArchive({ pass: {}, assets: { 'logo.png': 'http://test/large.png' } }),
      /size limit/,
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('client transport sends source JSON and requires exact rendering by default', async () => {
  const originalFetch = globalThis.fetch;
  const response = {
    renderer: 'apple-passkit',
    source: 'pass-designer',
    width: 343,
    height: 503,
    scale: 4,
    png: Buffer.from(png).toString('base64'),
    layout: [],
  };
  let mode = 'exact';
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    if (mode === 'error') return Response.json({ error: 'Offline' }, { status: 503 });
    return Response.json({
      ...response,
      ...(mode === 'approximate' ? { source: 'passkit' } : {}),
      ...(mode === 'invalid' ? { png: 'not an image' } : {}),
    });
  };
  try {
    const result = await renderPass(
      { pass },
      { endpoint: 'http://test/render?project=one', face: 'watch' },
    );
    assert.equal(result.source, 'pass-designer');
    assert.match(captured.url, /project=one&face=watch&scale=4/);
    assert.equal(captured.options.method, 'POST');
    const zip = await JSZip.loadAsync(await captured.options.body.arrayBuffer());
    assert.deepEqual(JSON.parse(await zip.file('pass.json').async('string')), pass);
    mode = 'approximate';
    await assert.rejects(renderPass({ pass }), /official Pass Designer renderer/);
    assert.equal((await renderPass({ pass }, { requireExact: false })).source, 'passkit');
    await assert.rejects(renderPassArchive(new Blob(), { scale: 2 }), /scale 4/);
    mode = 'invalid';
    await assert.rejects(renderPass({ pass }), /invalid image/);
    mode = 'error';
    await assert.rejects(
      renderPass({ pass }),
      (error) => error instanceof PassRendererError && error.status === 503,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
