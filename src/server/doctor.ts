import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const command = promisify(execFile);
export async function rendererDiagnostics() {
  const app = process.env.AWP_PASS_DESIGNER_APP || '/Applications/Pass Designer.app';
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, action: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await action() });
    } catch {
      checks.push({ name, ok: false, detail: 'Unavailable' });
    }
  };
  checks.push({ name: 'macOS', ok: process.platform === 'darwin', detail: process.platform });
  if (process.platform === 'darwin') {
    await check('macOS version', async () => {
      const version = (await command('sw_vers', ['-productVersion'])).stdout.trim();
      if (Number(version.split('.')[0]) < 27) throw new Error();
      return version;
    });
    await check('Xcode SDK', async () => {
      const sdk = (await command('xcrun', ['--sdk', 'macosx', '--show-sdk-path'])).stdout.trim();
      await access(path.join(sdk, 'System/iOSSupport/System/Library/Frameworks/UIKit.framework'));
      return sdk;
    });
    await check(
      'Swift compiler',
      async () => (await command('xcrun', ['swiftc', '--version'])).stdout.split('\n')[0],
    );
    await check('Pass Designer SDK', async () => {
      await access(path.join(app, 'Contents/Frameworks/PassRenderSDK.framework/PassRenderSDK'));
      return app;
    });
    await check('Pass Designer extension', async () => {
      await access(path.join(app, 'Contents/Extensions/Pass Designer Render Extension.appex'));
      const build = (
        await command('/usr/libexec/PlistBuddy', [
          '-c',
          'Print :CFBundleVersion',
          path.join(app, 'Contents/Info.plist'),
        ])
      ).stdout.trim();
      return `Build ${build}${build === '28' ? ' (verified integration)' : ' (run the parity suite for this build)'}`;
    });
    await check('Pass Designer app group', async () =>
      realpath(path.join(homedir(), 'Library/Group Containers/group.com.apple.passdesigner')),
    );
  }
  return { available: checks.every((item) => item.ok), renderer: 'apple-passkit' as const, checks };
}
