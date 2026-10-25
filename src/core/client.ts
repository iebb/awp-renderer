import type { NativePassRender, NativeRenderFace } from '../core/types.js';
import { buildPassRenderArchive, type PassRenderInput } from './input.js';

export type PassRenderOptions = {
  endpoint?: string;
  face?: NativeRenderFace;
  scale?: 1 | 2 | 3 | 4;
  locale?: string;
  /** Defaults to true. Approximate native captures require an explicit opt-in. */
  requireExact?: boolean;
  /** For a remote service. Keep private service credentials on your server. */
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
};

export class PassRendererError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const availability = new Map<string, Promise<boolean>>();
export function passRendererAvailable(
  endpoint = '/render',
  headers: Readonly<Record<string, string>> = {},
): Promise<boolean> {
  const key = JSON.stringify([endpoint, Object.entries(headers).sort()]);
  let pending = availability.get(key);
  if (!pending) {
    pending = fetch(endpoint, { headers, cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      .then(async (response) => response.ok && (await response.json()).available === true)
      .catch(() => false)
      .then((available) => {
        if (!available) availability.delete(key);
        return available;
      });
    availability.set(key, pending);
  }
  return pending;
}

/** Shared by the JSON component and the editor's archive adapter. */
export async function renderPassArchive(
  archive: Blob,
  options: PassRenderOptions = {},
): Promise<NativePassRender> {
  const {
    endpoint = '/render',
    face = 'front',
    scale = 4,
    locale = '',
    requireExact = true,
  } = options;
  if (requireExact && (scale !== 4 || locale))
    throw new PassRendererError('Exact rendering requires scale 4 and the System language.');
  const query = new URLSearchParams({
    face,
    scale: String(scale),
    ...(locale ? { locale } : {}),
    ...(!requireExact ? { requireExact: 'false' } : {}),
  });
  const separator = endpoint.includes('?') ? '&' : '?';
  const timeout = AbortSignal.timeout(90_000);
  const response = await fetch(`${endpoint}${separator}${query}`, {
    method: 'POST',
    body: archive,
    cache: 'no-store',
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    headers: { ...options.headers, 'Content-Type': 'application/vnd.apple.pkpass' },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new PassRendererError('The renderer returned an invalid response.', response.status);
  }
  if (!response.ok) {
    availability.delete(JSON.stringify([endpoint, Object.entries(options.headers || {}).sort()]));
    throw new PassRendererError(body.error || 'Could not render this pass.', response.status);
  }
  if (
    body.renderer !== 'apple-passkit' ||
    typeof body.png !== 'string' ||
    !body.png.startsWith('iVBORw0KGgo') ||
    !Array.isArray(body.layout) ||
    !Number.isFinite(body.width) ||
    body.width <= 0 ||
    !Number.isFinite(body.height) ||
    body.height <= 0 ||
    body.scale !== scale
  )
    throw new PassRendererError('The renderer returned an invalid image.');
  if (requireExact && body.source !== 'pass-designer')
    throw new PassRendererError(
      'The official Pass Designer renderer is unavailable. Approximate rendering was not enabled.',
      503,
    );
  return body as NativePassRender;
}

/** Non-React API for exports, tests, and callers that need pixels/layout metadata. */
export async function renderPass(input: PassRenderInput, options: PassRenderOptions = {}) {
  const timeout = AbortSignal.timeout(90_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return renderPassArchive(await buildPassRenderArchive(input, signal), { ...options, signal });
}
