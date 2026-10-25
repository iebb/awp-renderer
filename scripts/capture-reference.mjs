#!/usr/bin/env node
// Capture the installed, unmodified Pass Designer extension's own PNG output.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const command = promisify(execFile);
const [input, output, face = 'front'] = process.argv.slice(2);
if (process.platform !== 'darwin' || !input || !output || !['front', 'watch'].includes(face)) {
  console.error(
    'Usage (macOS): node scripts/capture-reference.mjs PASS_DIRECTORY OUTPUT_PNG [front|watch]',
  );
  process.exit(64);
}
const sourcePath = fileURLToPath(new URL('../native/capture-reference.swift', import.meta.url));
const source = await fs.readFile(sourcePath);
const hash = createHash('sha256').update(source).update(process.arch).digest('hex').slice(0, 16);
const contents = path.join(tmpdir(), 'awp-official-references', `capture-${hash}.app`, 'Contents');
const executable = path.join(contents, 'MacOS', 'capture');
await fs.mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
try {
  await fs.access(executable);
} catch {
  await fs.writeFile(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>capture</string>
<key>CFBundleIdentifier</key><string>dev.iebb.awp.official-reference</string>
<key>CFBundleName</key><string>Pass Designer Reference Capture</string>
<key>CFBundlePackageType</key><string>APPL</string>
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
        sourcePath,
        '-o',
        temporary,
      ],
      { timeout: 60_000 },
    );
    await fs.rename(temporary, executable);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
const destination = path.resolve(output);
await fs.mkdir(path.dirname(destination), { recursive: true });
await command(executable, [path.resolve(input), destination, face], {
  timeout: 45_000,
  killSignal: 'SIGTERM',
});
const app = process.env.AWP_PASS_DESIGNER_APP || '/Applications/Pass Designer.app';
const png = await fs.readFile(destination);
const passJson = await fs.readFile(path.join(path.resolve(input), 'pass.json'));
const metadata = {
  renderer: 'official-pass-designer-extension',
  extensionBundleIdentifier: 'com.apple.passdesigner.passrenderextension',
  capturedAt: new Date().toISOString(),
  inputDirectory: path.resolve(input),
  passJsonSha256: createHash('sha256').update(passJson).digest('hex'),
  pngSha256: createHash('sha256').update(png).digest('hex'),
  extensionSha256: createHash('sha256')
    .update(
      await fs.readFile(
        path.join(
          app,
          'Contents/Extensions/Pass Designer Render Extension.appex/Contents/MacOS/Pass Designer Render Extension',
        ),
      ),
    )
    .digest('hex'),
  face,
  scale: 4,
  marginPoints: 50,
  pixelWidth: png.readUInt32BE(16),
  pixelHeight: png.readUInt32BE(20),
};
await fs.writeFile(`${destination}.json`, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(
  JSON.stringify({
    output: destination,
    width: metadata.pixelWidth,
    height: metadata.pixelHeight,
    sha256: metadata.pngSha256,
  }),
);
