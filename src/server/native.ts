import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import type { NativePassRender, NativePassNode, NativeRenderFace } from '../core/types.js';
import { validatePassArchive } from '../core/archive.js';
import { cropPassPng } from './png.js';

export const MAX_NATIVE_PASS_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_TTL = 60_000;
const sourcePath = () => fileURLToPath(new URL('../../native/native-render.m', import.meta.url));
const cache = new Map<string, { at: number; result: NativePassRender }>();
let compilation: Promise<string> | undefined;
let compiledSourceTime = 0;
let referenceCompilation: Promise<string> | undefined;
let referenceCompiledSourceTime = 0;
let running = 0;
const waiting: Array<() => void> = [];

export class NativeRenderError extends Error {
  status: number;
  workerStartupAborted = false;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

export function nativeRendererAvailable() {
  return process.platform === 'darwin';
}

async function command(
  executable: string,
  args: string[],
  timeout = 15_000,
  abort?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (abort?.aborted) {
      reject(new NativeRenderError('Native rendering cancelled.', 499));
      return;
    }
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      settled = false;
    let passRenderingStarted = false;
    let stdoutTail = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeout);
    const cancel = () => {
      child.kill('SIGKILL');
    };
    abort?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      const streamed = stdoutTail + text;
      if (streamed.includes('PASSMK_RENDER_STARTED\n')) passRenderingStarted = true;
      stdoutTail = streamed.slice(-32);
      if (stdout.length < 16_384) stdout += text;
    });
    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length < 16_384) stderr += data.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      abort?.removeEventListener('abort', cancel);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      abort?.removeEventListener('abort', cancel);
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout.trim());
      // Do not return framework logs: they can contain the uploaded pass contents.
      else {
        const error = new NativeRenderError(
          abort?.aborted
            ? 'Native rendering cancelled.'
            : signal === 'SIGKILL'
              ? 'Native rendering timed out.'
              : `Native renderer failed (${code ?? signal}).${stderr.includes('Signature is missing') ? ' Pass template could not be loaded.' : ''}`,
          abort?.aborted ? 499 : 500,
        );
        // Only the geometry call uses this classification. Its marker is
        // emitted before any pass input is read. Never retry a data/layout
        // failure, a timeout, or a cancelled request.
        error.workerStartupAborted = signal === 'SIGABRT' && !passRenderingStarted;
        reject(error);
      }
    });
  });
}

async function nativeExecutable() {
  if (process.platform !== 'darwin')
    throw new NativeRenderError(
      'Native rendering needs macOS 27. Use renderPass with an HTTP endpoint to reach a Mac.',
      503,
    );
  const infoPath = path.join(path.dirname(sourcePath()), 'Info.plist');
  const modified = Math.max(
    (await fs.stat(sourcePath())).mtimeMs,
    (await fs.stat(infoPath)).mtimeMs,
  );
  if (modified !== compiledSourceTime) {
    compilation = undefined;
    compiledSourceTime = modified;
  }
  if (!compilation)
    compilation = (async () => {
      const source = await fs.readFile(sourcePath());
      const info = await fs.readFile(infoPath);
      const hash = createHash('sha256')
        .update(source)
        .update(info)
        .update(process.arch)
        .digest('hex')
        .slice(0, 16);
      const directory = path.join(tmpdir(), 'awp-native-renderer');
      const bundle = path.join(directory, `render-${hash}.app`, 'Contents');
      const executable = path.join(bundle, 'MacOS', 'render');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await fs.access(executable);
        return executable;
      } catch {
        /* Compile this source revision. */
      }
      await fs.mkdir(path.dirname(executable), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(path.join(bundle, 'Info.plist'), info, {
        mode: 0o600,
      });
      const sdk = await command('xcrun', ['--sdk', 'macosx', '--show-sdk-path']);
      const temporary = `${executable}.${process.pid}.tmp`;
      try {
        await command(
          'xcrun',
          [
            'clang',
            '-w',
            '-fobjc-arc',
            '-fblocks',
            '-target',
            `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios27.0-macabi`,
            '-isysroot',
            sdk,
            `-F${sdk}/System/iOSSupport/System/Library/Frameworks`,
            '-framework',
            'Foundation',
            '-framework',
            'UIKit',
            '-framework',
            'QuartzCore',
            '-framework',
            'CoreGraphics',
            sourcePath(),
            '-o',
            temporary,
          ],
          60_000,
        );
        await fs.rename(temporary, executable);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return executable;
    })().catch((error) => {
      compilation = undefined;
      throw error;
    });
  return compilation;
}

const referenceSourcePath = () => path.join(path.dirname(sourcePath()), 'capture-reference.swift');

async function officialRenderDirectory() {
  if (process.platform !== 'darwin') return undefined;
  const app = process.env.AWP_PASS_DESIGNER_APP || '/Applications/Pass Designer.app';
  try {
    await fs.access(path.join(app, 'Contents/Frameworks/PassRenderSDK.framework/PassRenderSDK'));
    return await fs.realpath(
      path.join(homedir(), 'Library/Group Containers/group.com.apple.passdesigner'),
    );
  } catch {
    return undefined;
  }
}

async function officialExecutable() {
  const modified = (await fs.stat(referenceSourcePath())).mtimeMs;
  if (modified !== referenceCompiledSourceTime) {
    referenceCompilation = undefined;
    referenceCompiledSourceTime = modified;
  }
  if (!referenceCompilation)
    referenceCompilation = (async () => {
      const source = await fs.readFile(referenceSourcePath());
      const hash = createHash('sha256')
        .update(source)
        .update(process.arch)
        .digest('hex')
        .slice(0, 16);
      const contents = path.join(
        tmpdir(),
        'awp-official-renderer',
        `render-${hash}.app`,
        'Contents',
      );
      const executable = path.join(contents, 'MacOS', 'render');
      try {
        await fs.access(executable);
        return executable;
      } catch {
        /* Compile this source revision. */
      }
      await fs.mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
      await fs.writeFile(
        path.join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>render</string>
<key>CFBundleIdentifier</key><string>dev.iebb.awp.official-renderer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>Pass Designer Renderer</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>27.0</string>
</dict></plist>`,
        { mode: 0o600 },
      );
      const temporary = `${executable}.${process.pid}.tmp`;
      try {
        await command(
          'xcrun',
          [
            'swiftc',
            '-suppress-warnings',
            '-parse-as-library',
            '-target',
            `${process.arch}-apple-macos27.0`,
            referenceSourcePath(),
            '-o',
            temporary,
          ],
          60_000,
        );
        await fs.rename(temporary, executable);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return executable;
    })().catch((error) => {
      referenceCompilation = undefined;
      throw error;
    });
  return referenceCompilation;
}

async function boundedZipEntry(entry: JSZip.JSZipObject, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = entry.nodeStream('nodebuffer') as unknown as import('node:stream').Readable;
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximum) {
        stream.destroy();
        reject(new NativeRenderError('A pass resource exceeds the size limit.', 413));
      } else chunks.push(bytes);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function unpackPass(archive: Buffer, destination: string) {
  try {
    validatePassArchive(new Uint8Array(archive));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid pass archive.';
    throw new NativeRenderError(message, /limit|exceed/i.test(message) ? 413 : 400);
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive);
  } catch {
    throw new NativeRenderError('Invalid .pkpass archive.', 400);
  }
  const jsonFile = zip.file('pass.json');
  if (!jsonFile) throw new NativeRenderError('The archive has no pass.json.', 400);
  let pass: Record<string, unknown>;
  try {
    pass = JSON.parse((await boundedZipEntry(jsonFile, 256 * 1024)).toString());
  } catch (error) {
    if (error instanceof NativeRenderError) throw error;
    throw new NativeRenderError('Invalid pass.json.', 400);
  }
  if (!pass || Array.isArray(pass) || typeof pass !== 'object')
    throw new NativeRenderError('Invalid pass.json.', 400);
  if (
    !['generic', 'posterGeneric', 'boardingPass', 'eventTicket', 'coupon', 'storeCard'].some(
      (key) => pass[key] && typeof pass[key] === 'object',
    )
  ) {
    throw new NativeRenderError('No supported pass style was found.', 400);
  }
  await fs.mkdir(destination, { mode: 0o700 });
  await fs.writeFile(path.join(destination, 'pass.json'), JSON.stringify(pass), { mode: 0o600 });
  let totalBytes = 0;
  // Only known resource names are ever written. Archive paths, signatures,
  // symlinks, executables, and tooling metadata are not extracted.
  const resourceName =
    /^(?:(?:[A-Za-z]{2,3}|Base)(?:[-_][A-Za-z0-9]{2,8}){0,3}\.lproj\/)?[A-Za-z0-9_@~-]+\.png$/;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (
      /^(?:[A-Za-z]{2,3}|Base)(?:[-_][A-Za-z0-9]{2,8}){0,3}\.lproj\/pass\.strings$/.test(name) &&
      !entry.dir
    ) {
      const bytes = await boundedZipEntry(entry, 64 * 1024);
      totalBytes += bytes.length;
      if (totalBytes > MAX_NATIVE_PASS_BYTES)
        throw new NativeRenderError('Pass resources exceed the size limit.', 413);
      await fs.mkdir(path.join(destination, path.dirname(name)), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(path.join(destination, name), bytes, { mode: 0o600 });
      continue;
    }
    if (!resourceName.test(name) || entry.dir) continue;
    const bytes = await boundedZipEntry(entry, MAX_IMAGE_BYTES);
    totalBytes += bytes.length;
    if (totalBytes > MAX_NATIVE_PASS_BYTES)
      throw new NativeRenderError('Pass artwork exceeds the size limit.', 413);
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new NativeRenderError('Pass artwork must be PNG.', 400);
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 32_000_000)
      throw new NativeRenderError('Pass artwork dimensions exceed the limit.', 413);
    await fs.mkdir(path.dirname(path.join(destination, name)), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(path.join(destination, name), bytes, { mode: 0o600 });
  }
}

export async function renderNativePass(
  archive: Buffer,
  options: {
    face?: NativeRenderFace;
    scale?: number;
    locale?: string;
    signal?: AbortSignal;
  } = {},
): Promise<NativePassRender> {
  if (archive.length > MAX_NATIVE_PASS_BYTES)
    throw new NativeRenderError('The pass exceeds the size limit.', 413);
  const face = options.face || 'front';
  if (!['front', 'semantic', 'watch'].includes(face))
    throw new NativeRenderError('Invalid preview face.', 400);
  const scale = options.scale ?? 4;
  if (![1, 2, 3, 4].includes(scale)) throw new NativeRenderError('Invalid image scale.', 400);
  const locale = options.locale || '';
  if (locale && !/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8}){0,3}$/.test(locale))
    throw new NativeRenderError('Invalid preview locale.', 400);
  const sourceTime =
    process.platform === 'darwin'
      ? Math.max(
          (await fs.stat(sourcePath())).mtimeMs,
          (await fs.stat(path.join(path.dirname(sourcePath()), 'Info.plist'))).mtimeMs,
          (await fs.stat(referenceSourcePath())).mtimeMs,
        )
      : 0;
  const key = createHash('sha256')
    .update(archive)
    .update(JSON.stringify({ face, scale, locale, sourceTime }))
    .digest('hex');
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.result;
  if (running >= 2) {
    if (waiting.length >= 12)
      throw new NativeRenderError('The native renderer is busy. Please retry.', 429);
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        options.signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        const index = waiting.indexOf(resume);
        if (index >= 0) waiting.splice(index, 1);
        reject(new NativeRenderError('Native rendering cancelled.', 499));
      };
      if (options.signal?.aborted) {
        cancel();
        return;
      }
      waiting.push(resume);
      options.signal?.addEventListener('abort', cancel, { once: true });
    });
  } else running++;
  let directory: string | undefined;
  try {
    const executable = await nativeExecutable();
    if (options.signal?.aborted) throw new NativeRenderError('Native rendering cancelled.', 499);
    const officialRoot = scale === 4 && !locale ? await officialRenderDirectory() : undefined;
    directory = await fs.mkdtemp(path.join(officialRoot || tmpdir(), 'awp-preview-'));
    const bundle = path.join(directory, 'preview.pkpasstemplate');
    await unpackPass(archive, bundle);
    const output = path.join(directory, 'output');
    const geometryArguments = [
      bundle,
      output,
      '343',
      String(scale),
      face,
      ...(locale
        ? [
            '-AppleLocale',
            locale.replaceAll('-', '_'),
            '-AppleLanguages',
            `("${locale.replaceAll('_', '-')}")`,
          ]
        : []),
    ];
    try {
      await command(executable, geometryArguments, 45_000, options.signal);
    } catch (error) {
      if (
        !(error instanceof NativeRenderError) ||
        !error.workerStartupAborted ||
        options.signal?.aborted
      )
        throw error;
      await command(executable, geometryArguments, 45_000, options.signal);
    }
    if (officialRoot) {
      const renderer = await officialExecutable();
      await command(
        renderer,
        [
          bundle,
          path.join(output, 'official.png'),
          face === 'watch' ? 'watch' : 'front',
          '--prepared',
        ],
        45_000,
        options.signal,
      );
    }
    const [fullPng, layoutText] = await Promise.all([
      fs.readFile(path.join(output, officialRoot ? 'official.png' : 'native.png')),
      fs.readFile(path.join(output, 'layout.json'), 'utf8'),
    ]);
    const png = cropPassPng(fullPng, 50 * scale);
    const layout = JSON.parse(layoutText) as NativePassNode[];
    const root = layout[0];
    if (!root?.width || !root.height || !png.length)
      throw new NativeRenderError('The native renderer returned an empty preview.');
    const result: NativePassRender = {
      renderer: 'apple-passkit',
      source: officialRoot ? 'pass-designer' : 'passkit',
      width: png.readUInt32BE(16) / scale,
      height: png.readUInt32BE(20) / scale,
      scale,
      png: png.toString('base64'),
      layout,
    };
    cache.set(key, { at: Date.now(), result });
    // Bound memory and retain no input pass archives after the request finishes.
    for (const [oldKey, entry] of cache)
      if (cache.size > 16 || Date.now() - entry.at > CACHE_TTL) cache.delete(oldKey);
    return result;
  } finally {
    try {
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  }
}
