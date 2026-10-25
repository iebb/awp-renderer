#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  renderPass,
  buildPassRenderArchive,
  passRenderInputFromArchive,
  isPassAssetName,
} from '../dist/index.js';
import {
  createRendererServer,
  rendererDiagnostics,
  renderNativePass,
} from '../dist/server/index.js';

const help = `awp-renderer — JSON → Apple Wallet pixels

Usage:
  awp-renderer [serve] [--port 43877] [--open]
  awp-renderer doctor [--json]
  awp-renderer render <pass.json|directory|pass.pkpass|-> --output pass.png

Commands:
  serve, demo  Start the Mac API and local JSON playground (default command)
  render       Export a PNG from a JSON file, resource directory, archive, or stdin
  doctor       Check macOS, Xcode, Pass Designer, and the app-group directory

Options:
  --face front|semantic|watch   Preview face (default: front)
  --output, -o FILE            PNG output (default: pass.png)
  --layout FILE               Also write native layout metadata as JSON
  --assets DIRECTORY          Artwork/localizations beside a JSON file
  --endpoint URL              Render through a running service instead of this Mac
  --scale 1|2|3|4              Raster scale (default: 4)
  --locale LANGUAGE           Language override (requires --allow-approximate)
  --allow-approximate          Explicitly permit the alternative PassKit capture
  --host ADDRESS              Listen address (default: 127.0.0.1)
  --port NUMBER               Listen port (default: 43877; 0 chooses a free port)
  --cors-origin URL           Allow one extra browser origin
  --open                      Open the local playground in the default browser
  --json                      Machine-readable doctor output
  --help, -h                  Show this help
  --version, -v               Show the package version

Environment: AWP_RENDER_TOKEN, AWP_PASS_DESIGNER_APP, AWP_RENDER_URL
Exact rendering needs macOS 27+, Xcode 27+, and installed Pass Designer build 28.
`;

async function loadInput(location, assetDirectory) {
  if (location === '-') {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 256 * 1024) throw new Error('JSON stdin exceeds the 256 KiB limit.');
      chunks.push(chunk);
    }
    return {
      pass: Buffer.concat(chunks).toString('utf8'),
      assets: await loadAssets(assetDirectory),
    };
  }
  const file = path.resolve(location);
  const info = await stat(file);
  if (info.isDirectory()) return loadInput(path.join(file, 'pass.json'), file);
  if (info.size > 16 * 1024 * 1024) throw new Error('The input exceeds the 16 MiB limit.');
  const bytes = await readFile(file);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b)
    return passRenderInputFromArchive(new Uint8Array(bytes));
  return {
    pass: bytes.toString('utf8'),
    assets: await loadAssets(assetDirectory || path.dirname(file)),
  };
}
async function loadAssets(directory) {
  if (!directory) return {};
  const root = path.resolve(directory),
    assets = {};
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile()) entries.push(entry.name);
    else if (
      entry.isDirectory() &&
      /^(?:[A-Za-z]{2,3}|Base)(?:[-_][A-Za-z0-9]{2,8}){0,3}\.lproj$/.test(entry.name)
    ) {
      for (const localized of await readdir(path.join(root, entry.name), { withFileTypes: true })) {
        if (localized.isFile()) entries.push(`${entry.name}/${localized.name}`);
      }
    }
  }
  for (const name of entries) {
    const file = path.join(root, name);
    if (!isPassAssetName(name)) continue;
    if (Object.keys(assets).length >= 299) throw new Error('Too many pass resources.');
    if ((await stat(file)).size > (name.endsWith('.png') ? 8 * 1024 * 1024 : 64 * 1024))
      throw new Error(`Resource exceeds the size limit: ${name}`);
    assets[name] = new Uint8Array(await readFile(file));
  }
  return assets;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      open: { type: 'boolean' },
      json: { type: 'boolean' },
      'allow-approximate': { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      face: { type: 'string' },
      scale: { type: 'string' },
      locale: { type: 'string' },
      endpoint: { type: 'string' },
      assets: { type: 'string' },
      output: { type: 'string', short: 'o' },
      layout: { type: 'string' },
      'cors-origin': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(help);
  } else if (values.version) {
    console.log(
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
    );
  } else {
    const [command = 'serve', input] = positionals;
    if (command === 'doctor') {
      const diagnostics = await rendererDiagnostics();
      console.log(
        values.json
          ? JSON.stringify(diagnostics, null, 2)
          : diagnostics.checks
              .map((item) => `${item.ok ? '✓' : '✗'} ${item.name}: ${item.detail}`)
              .join('\n'),
      );
      if (!diagnostics.available) {
        if (!values.json)
          console.log('\nInstall and open Pass Designer once. See docs/native-setup.md.');
        process.exitCode = 1;
      }
    } else if (command === 'serve' || command === 'demo') {
      const host = values.host || '127.0.0.1',
        port = Number(values.port ?? 43877);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
      if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !process.env.AWP_RENDER_TOKEN)
        throw new Error('AWP_RENDER_TOKEN is required beyond loopback.');
      if (values['cors-origin']) {
        const origin = new URL(values['cors-origin']);
        if (
          origin.origin !== values['cors-origin'] ||
          !['http:', 'https:'].includes(origin.protocol)
        )
          throw new Error('--cors-origin must be one exact HTTP(S) origin.');
      }
      const server = createRendererServer({ corsOrigin: values['cors-origin'] });
      server.on('error', (error) => {
        console.error(`awp-renderer: ${error.message}`);
        process.exitCode = 1;
      });
      server.listen(port, host, () => {
        const address = server.address();
        const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
        console.log(
          `AWP Renderer\nPlayground  ${url}\nAPI         ${url}/render\nStop        Ctrl+C`,
        );
        if (process.env.AWP_RENDER_TOKEN)
          console.log(
            'API authentication is enabled. Enter the token in the playground to connect.',
          );
        if (values.open)
          spawn(
            process.platform === 'darwin'
              ? 'open'
              : process.platform === 'win32'
                ? 'cmd'
                : 'xdg-open',
            process.platform === 'win32' ? ['/c', 'start', '', url] : [url],
            { stdio: 'ignore' },
          ).on('error', () => {});
      });
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, () => {
          server.close(() => process.exit(0));
          setTimeout(() => {
            server.closeAllConnections();
            process.exit(0);
          }, 5000).unref();
        });
    } else if (command === 'render') {
      if (!input)
        throw new Error('Provide a JSON file, resource directory, archive, or - for stdin.');
      if (positionals.length > 2) throw new Error('Unexpected positional arguments.');
      const face = values.face || 'front',
        scale = Number(values.scale || 4),
        requireExact = !values['allow-approximate'];
      if (!['front', 'semantic', 'watch'].includes(face)) throw new Error('Invalid --face.');
      if (![1, 2, 3, 4].includes(scale)) throw new Error('Invalid --scale.');
      if (requireExact && (scale !== 4 || values.locale))
        throw new Error(
          'Exact rendering requires scale 4 and the System language. Use --allow-approximate to opt in.',
        );
      const payload = await loadInput(input, values.assets);
      const endpoint = values.endpoint || process.env.AWP_RENDER_URL;
      const result = endpoint
        ? await renderPass(payload, {
            endpoint,
            face,
            scale,
            locale: values.locale,
            requireExact,
            headers: process.env.AWP_RENDER_TOKEN
              ? { Authorization: `Bearer ${process.env.AWP_RENDER_TOKEN}` }
              : undefined,
          })
        : await renderNativePass(
            Buffer.from(await (await buildPassRenderArchive(payload)).arrayBuffer()),
            { face, scale, locale: values.locale },
          );
      if (requireExact && result.source !== 'pass-designer')
        throw new Error('Official Pass Designer output is unavailable.');
      const output = path.resolve(values.output || 'pass.png');
      await writeFile(output, Buffer.from(result.png, 'base64'));
      if (values.layout)
        await writeFile(
          values.layout,
          JSON.stringify({ ...result, png: undefined }, null, 2) + '\n',
        );
      console.log(
        JSON.stringify({
          output,
          source: result.source,
          width: result.width,
          height: result.height,
          scale: result.scale,
        }),
      );
    } else throw new Error(`Unknown command: ${command}. Run awp-renderer --help.`);
  }
} catch (error) {
  console.error(`awp-renderer: ${error.message}`);
  process.exitCode = 1;
}
