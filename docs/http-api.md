# HTTP API

`awp-renderer serve` exposes the prebuilt playground at `/` and the rendering API at `/render`. It binds to loopback by default. `createRendererServer()` returns a Node HTTP server without listening, for embedding in another application.

```ts
import { createRendererServer } from 'awp-renderer/server';
const server = createRendererServer();
server.listen(43877, '127.0.0.1');
```

If embedding, enforce your own bind policy: unlike the CLI, this low-level factory does not know the intended listen address. Set `token` for a remote listener.

## Routes

- `GET /render` or `GET /health`: `{available, renderer}` prerequisites. Actual renders verify execution.
- `POST /render?face=front&scale=4`: body is an unsigned ZIP or .pkpass, Content-Type `application/vnd.apple.pkpass`. Returns a render result with base64 PNG and native layout.
- Add `requireExact=false` for approximate opt-in, with optional `locale` and scales 1–3.
- Errors: `{error}` with HTTP 400/401/403/413/429/499/500/503 as appropriate.

If configured, send `Authorization: Bearer <AWP_RENDER_TOKEN>` for API requests. Never put the token in a URL. The CLI refuses non-loopback binds without a token; the HTTP handler blocks unapproved browser origins and loopback DNS rebinding Host headers. `--cors-origin` permits one exact additional origin and its preflight requests. No wildcard CORS is enabled.

## Same-origin proxy example

In a Next.js app, install this package and add an application-owned route:

```ts
// app/render/route.ts (use another route name if /render is already a page)
export const runtime = 'nodejs';

export async function GET() {
  return proxy();
}
export async function POST(request: Request) {
  return proxy(request);
}
async function proxy(request?: Request) {
  // Apply your application's authentication/rate limits before forwarding.
  const origin = process.env.AWP_MAC_ORIGIN!; // e.g. https://private-mac.example
  const query = request ? new URL(request.url).search : '';
  const response = await fetch(`${origin}/render${query}`, {
    method: request ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${process.env.AWP_RENDER_TOKEN!}`,
      'Content-Type': 'application/vnd.apple.pkpass',
    },
    body: request ? await boundedBody(request) : undefined,
    signal: request
      ? AbortSignal.any([request.signal, AbortSignal.timeout(90_000)])
      : AbortSignal.timeout(90_000),
    cache: 'no-store',
  });
  return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing pass archive.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16 * 1024 * 1024) {
      await reader.cancel();
      throw new Error('Pass archive exceeds 16 MiB.');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
```

Map proxy exceptions to your application's HTTP error format. The CLI service already bounds its own request body, validates the archive, and limits native jobs, but an application proxy should also enforce its own authentication, quota, timeout, and body limits. The service is a rendering worker, not an open public SaaS endpoint.
