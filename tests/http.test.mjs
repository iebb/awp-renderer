import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createRendererServer, NativeRenderError } from '../dist/server/index.js';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=';
const image = {
  renderer: 'apple-passkit',
  source: 'pass-designer',
  width: 1,
  height: 1,
  scale: 4,
  png,
  layout: [],
};
async function fixture(t, options = {}) {
  const server = createRendererServer({
    available: async () => true,
    render: async () => image,
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
test('HTTP API and prebuilt playground work without Next.js', async (t) => {
  let received;
  const base = await fixture(t, {
    render: async (archive, options) => {
      received = { archive, options };
      return image;
    },
  });
  assert.match(await (await fetch(base)).text(), /AWP Renderer/);
  const health = await fetch(`${base}/render`);
  assert.equal((await health.json()).available, true);
  const response = await fetch(`${base}/render?face=watch`, { method: 'POST', body: 'archive' });
  assert.deepEqual(await response.json(), image);
  assert.equal(received.archive.toString(), 'archive');
  assert.equal(received.options.face, 'watch');
  assert.equal(received.options.scale, 4);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
});
test('strict source and scale by default; approximation must be explicit', async (t) => {
  const base = await fixture(t, { render: async () => ({ ...image, source: 'passkit' }) });
  assert.equal((await fetch(`${base}/render`, { method: 'POST', body: '' })).status, 503);
  assert.equal((await fetch(`${base}/render?scale=2`, { method: 'POST', body: '' })).status, 400);
  assert.equal(
    (await fetch(`${base}/render?scale=2&requireExact=false`, { method: 'POST', body: '' })).status,
    200,
  );
});
test('token protection, origin policy, CORS, and DNS rebinding protection', async (t) => {
  const base = await fixture(t, {
    token: 'test-only-token',
    corsOrigin: 'https://allowed.example',
  });
  assert.equal((await fetch(`${base}/render`)).status, 401);
  assert.equal(
    (await fetch(`${base}/render`, { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
  assert.equal(
    (await fetch(`${base}/render`, { headers: { Authorization: 'Bearer test-only-token' } }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/render`, { headers: { Origin: 'https://blocked.example' } })).status,
    403,
  );
  const forgedHost = await new Promise((resolve, reject) => {
    http
      .get(`${base}/render`, { headers: { Host: 'rebinding.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });
  assert.equal(forgedHost, 403);
  const preflight = await fetch(`${base}/render`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://allowed.example' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://allowed.example');
});
test('HTTP errors preserve safe messages and hide private framework details', async (t) => {
  const a = await fixture(t, {
    render: async () => {
      throw new Error('PRIVATE PASS CONTENT');
    },
  });
  const response = await fetch(`${a}/render`, { method: 'POST', body: '' });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /PRIVATE/);
  const b = await fixture(t, {
    render: async () => {
      throw new NativeRenderError('Too many resources.', 413);
    },
  });
  assert.equal((await fetch(`${b}/render`, { method: 'POST', body: '' })).status, 413);
});
test('unavailable renderer reports a setup action', async (t) => {
  const base = await fixture(t, { available: async () => false });
  assert.equal((await (await fetch(`${base}/health`)).json()).available, false);
  const response = await fetch(`${base}/render`, { method: 'POST', body: '' });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /doctor/);
});
