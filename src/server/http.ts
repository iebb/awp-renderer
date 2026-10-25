import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAX_NATIVE_PASS_BYTES, NativeRenderError, renderNativePass } from './native.js';
import { rendererDiagnostics } from './doctor.js';

export type RendererServerOptions = {
  token?: string;
  corsOrigin?: string;
  playgroundDirectory?: string | false;
  /** Dependency injection for application integration and deterministic tests. */
  render?: typeof renderNativePass;
  available?: () => Promise<boolean>;
};
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/** Local HTTP API + prebuilt playground. Does not listen until the caller asks. */
export function createRendererServer(options: RendererServerOptions = {}) {
  const token = options.token ?? process.env.AWP_RENDER_TOKEN;
  const render = options.render ?? renderNativePass;
  const directory =
    options.playgroundDirectory === false
      ? false
      : path.resolve(
          options.playgroundDirectory ||
            fileURLToPath(new URL('../../playground/', import.meta.url)),
        );
  let diagnostics: ReturnType<typeof rendererDiagnostics> | undefined;
  const available =
    options.available ?? (async () => (await (diagnostics ??= rendererDiagnostics())).available);
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    const reply = (status: number, body: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      const origin = request.headers.origin;
      const sameOrigin =
        origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
      if (origin && !sameOrigin && origin !== options.corsOrigin) {
        reply(403, { error: 'This origin is not allowed.' });
        return;
      }
      // Limit loopback listeners to loopback Host headers, including DNS rebinding.
      const host = new URL(`http://${request.headers.host || 'localhost'}`).hostname;
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        request.socket.localAddress || '',
      );
      if (local && !['localhost', '127.0.0.1', '[::1]'].includes(host)) {
        reply(403, { error: 'Invalid local host.' });
        return;
      }
      if (origin && options.corsOrigin === origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      const api = ['/render', '/health'].includes(url.pathname);
      if (api && token) {
        const actual = Buffer.from((request.headers.authorization || '').replace(/^Bearer /, ''));
        const expected = Buffer.from(token);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          reply(401, { error: 'A renderer token is required.' });
          return;
        }
      }
      if (request.method === 'GET' && api) {
        reply(200, { available: await available(), renderer: 'apple-passkit' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/render') {
        if (!(await available())) {
          reply(503, {
            error: 'The Mac renderer is unavailable. Run awp-renderer doctor for setup checks.',
          });
          return;
        }
        const length = Number(request.headers['content-length'] || 0);
        if (length > MAX_NATIVE_PASS_BYTES) {
          reply(413, { error: 'The pass exceeds the 16 MiB limit.' });
          request.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_NATIVE_PASS_BYTES) {
            reply(413, { error: 'The pass exceeds the 16 MiB limit.' });
            return;
          }
          chunks.push(chunk);
        }
        const scale = Number(url.searchParams.get('scale') || 4);
        const locale = url.searchParams.get('locale') || undefined;
        const requireExact = url.searchParams.get('requireExact') !== 'false';
        if (requireExact && (scale !== 4 || locale)) {
          reply(400, { error: 'Exact rendering requires scale 4 and the System language.' });
          return;
        }
        const result = await render(Buffer.concat(chunks), {
          face: (url.searchParams.get('face') || 'front') as 'front' | 'semantic' | 'watch',
          scale,
          locale,
          signal: controller.signal,
        });
        if (requireExact && result.source !== 'pass-designer') {
          reply(503, { error: 'The official Pass Designer renderer is unavailable.' });
          return;
        }
        response.setHeader('X-Pass-Renderer', result.source || 'apple-passkit');
        reply(200, result);
        return;
      }
      if (request.method === 'GET' && directory) {
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(directory, relative);
        if (!file.startsWith(directory + path.sep)) {
          reply(404, { error: 'Not found.' });
          return;
        }
        try {
          const bytes = await readFile(file);
          response.writeHead(200, {
            'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end(bytes);
          return;
        } catch {
          /* Unknown routes are a JSON 404, not a hidden SPA fallback. */
        }
      }
      reply(404, { error: 'Not found.' });
    } catch (error) {
      reply(error instanceof NativeRenderError ? error.status : 500, {
        error: error instanceof NativeRenderError ? error.message : 'Pass rendering failed.',
      });
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  return server;
}
