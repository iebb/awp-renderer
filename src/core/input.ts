import JSZip from 'jszip';
import { validatePassArchive } from './archive.js';

export type PassJson = Readonly<Record<string, unknown>> | string;
export type PassAsset = string | Blob | Uint8Array | ArrayBuffer;
export type PassAssets = Readonly<Record<string, PassAsset>>;
export type PassRenderInput = { pass: PassJson; assets?: PassAssets };

export const PASS_RENDER_LIMITS = {
  archive: 16 * 1024 * 1024,
  json: 256 * 1024,
  image: 8 * 1024 * 1024,
  localization: 64 * 1024,
  resources: 299,
} as const;
const PNG_RESOURCE =
  /^(?:(?:[A-Za-z]{2,3}|Base)(?:[-_][A-Za-z0-9]{2,8}){0,3}\.lproj\/)?[A-Za-z0-9_@~-]+\.png$/;
const STRINGS_RESOURCE =
  /^(?:[A-Za-z]{2,3}|Base)(?:[-_][A-Za-z0-9]{2,8}){0,3}\.lproj\/pass\.strings$/;
const binaryIds = new WeakMap<object, number>();
let nextBinaryId = 0;
const ZIP_OPTIONS = { date: new Date('1980-01-01T00:00:00Z'), createFolders: false };

export function isPassAssetName(name: string) {
  return PNG_RESOURCE.test(name) || STRINGS_RESOURCE.test(name);
}

/** Validate the source, retaining its exact JSON text when a string was given. */
export function serializePassJson(pass: PassJson): string {
  const source = typeof pass === 'string' ? pass : JSON.stringify(pass);
  if (typeof source !== 'string') throw new Error('Pass JSON must be an object.');
  if (new TextEncoder().encode(source).length > PASS_RENDER_LIMITS.json)
    throw new Error('Pass JSON exceeds the 256 KiB limit.');
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Pass JSON must be an object.');
  return source;
}

/** New object literals containing the same URLs/Blob objects do not refetch. */
export function passAssetsKey(assets: PassAssets = {}): string {
  return JSON.stringify(
    Object.keys(assets)
      .sort()
      .map((name) => {
        const value = assets[name];
        if (typeof value === 'string') return [name, value];
        if (!value || typeof value !== 'object') throw new Error(`Invalid pass asset: ${name}`);
        let id = binaryIds.get(value);
        if (id === undefined) {
          id = ++nextBinaryId;
          binaryIds.set(value, id);
        }
        return [name, id];
      }),
  );
}

async function boundedStream(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  signal?: AbortSignal,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) throw new Error('A pass asset exceeds its size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function assetBytes(
  asset: PassAsset,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (typeof asset === 'string') {
    const response = await fetch(asset, { signal, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok || !response.body)
      throw new Error(`Could not load a pass asset (${response.status}).`);
    return boundedStream(response.body, maximum, signal);
  }
  if (asset instanceof Blob) {
    if (asset.size > maximum) throw new Error('A pass asset exceeds its size limit.');
    return boundedStream(asset.stream(), maximum, signal);
  }
  if (asset instanceof Uint8Array || asset instanceof ArrayBuffer) {
    if (asset.byteLength > maximum) throw new Error('A pass asset exceeds its size limit.');
    return new Uint8Array(asset);
  }
  throw new Error('Pass assets must be URLs, data URLs, Blobs, or bytes.');
}

function validatePng(bytes: Uint8Array) {
  if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte))
    throw new Error('Pass artwork must be PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32_000_000)
    throw new Error('Pass artwork dimensions exceed the limit.');
}

/** Transport packaging only: no defaults, image conversion, field trimming or layout. */
export async function buildPassRenderArchive(
  input: PassRenderInput,
  signal?: AbortSignal,
): Promise<Blob> {
  const controller = new AbortController();
  const operation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const json = serializePassJson(input.pass);
    const entries = Object.entries(input.assets || {}).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    if (entries.length > PASS_RENDER_LIMITS.resources)
      throw new Error('The pass contains too many assets.');
    for (const [name] of entries)
      if (!isPassAssetName(name)) throw new Error(`Unsupported pass asset name: ${name}`);
    const zip = new JSZip();
    zip.file('pass.json', json, ZIP_OPTIONS);
    const files = new Map<string, Uint8Array>();
    let total = new TextEncoder().encode(json).length;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (cursor < entries.length) {
          const [name, value] = entries[cursor++];
          const bytes = await assetBytes(
            value,
            name.endsWith('.png') ? PASS_RENDER_LIMITS.image : PASS_RENDER_LIMITS.localization,
            operation,
          );
          operation.throwIfAborted();
          if (name.endsWith('.png')) validatePng(bytes);
          total += bytes.length;
          if (total > PASS_RENDER_LIMITS.archive)
            throw new Error('Pass assets exceed the 16 MiB limit.');
          files.set(name, bytes);
        }
      }),
    );
    // Stable file order/dates let identical component instances share the
    // server's archive cache; resource bytes and JSON are never rewritten.
    for (const [name] of entries) zip.file(name, files.get(name)!, ZIP_OPTIONS);
    operation.throwIfAborted();
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
    if (bytes.length > PASS_RENDER_LIMITS.archive)
      throw new Error('The pass exceeds the 16 MiB limit.');
    operation.throwIfAborted();
    return new Blob([new Uint8Array(bytes).buffer], { type: 'application/vnd.apple.pkpass' });
  } finally {
    controller.abort();
  }
}

async function zipEntryBytes(file: JSZip.JSZipObject, maximum: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let failed = false;
    // JSZip documents this browser API, but omits it from JSZipObject's types:
    // https://stuk.github.io/jszip/documentation/api_zipobject/internal_stream.html
    const stream = (
      file as JSZip.JSZipObject & {
        internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
      }
    ).internalStream('uint8array');
    stream.on('data', (bytes) => {
      if (failed) return;
      length += bytes.length;
      if (length > maximum) {
        failed = true;
        stream.pause();
        reject(new Error('A pass asset exceeds its size limit.'));
      } else chunks.push(bytes);
    });
    stream.on('error', (error) => {
      failed = true;
      reject(error);
    });
    stream.on('end', () => {
      if (failed) return;
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(bytes);
    });
    stream.resume();
  });
}

/** Read an existing archive without passing through editor state or its defaults. */
export async function passRenderInputFromArchive(
  archive: Blob | Uint8Array,
): Promise<PassRenderInput> {
  if (archive instanceof Blob && archive.size > PASS_RENDER_LIMITS.archive)
    throw new Error('The pass exceeds the 16 MiB limit.');
  const bytes = archive instanceof Blob ? new Uint8Array(await archive.arrayBuffer()) : archive;
  validatePassArchive(bytes);
  const zip = await JSZip.loadAsync(bytes);
  const json = zip.file('pass.json');
  if (!json) throw new Error('The archive has no pass.json.');
  const pass = serializePassJson(
    new TextDecoder().decode(await zipEntryBytes(json, PASS_RENDER_LIMITS.json)),
  );
  const assets: Record<string, Uint8Array> = {};
  let total = new TextEncoder().encode(pass).length;
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir || !isPassAssetName(name)) continue;
    const data = await zipEntryBytes(
      file,
      name.endsWith('.png') ? PASS_RENDER_LIMITS.image : PASS_RENDER_LIMITS.localization,
    );
    total += data.length;
    if (total > PASS_RENDER_LIMITS.archive) throw new Error('Pass assets exceed the 16 MiB limit.');
    assets[name] = data;
  }
  return { pass, assets };
}
