// Compare package exports to an independent snapshot of the installed Apple app.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { renderNativePass } from '../dist/server/index.js';
import { buildPassRenderArchive, renderPass } from '../dist/index.js';
const run = promisify(execFile);
if (process.platform !== 'darwin') {
  console.error('Native parity needs a configured Mac. Run awp-renderer doctor.');
  process.exit(1);
}
const output = path.resolve(process.env.AWP_TEST_OUTPUT || 'artifacts/native-parity');
await mkdir(output, { recursive: true });
const names = ['membership', 'boarding', 'event', 'coupon', 'store-card', 'poster'];
const jobs = names.flatMap((name) =>
  ['front', 'watch'].flatMap((face) =>
    ['baseline', '200k'].map((profile) => ({ name, face, profile })),
  ),
);
const results = [];
const concurrency = Number(process.env.AWP_TEST_CONCURRENCY || 1);
if (![1, 2].includes(concurrency)) throw new Error('AWP_TEST_CONCURRENCY must be 1 or 2.');
let cursor = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++],
        id = `${job.name}-${job.face}-${job.profile}`;
      const pass = JSON.parse(await readFile(`examples/${job.name}.json`, 'utf8'));
      if (job.profile === '200k') {
        const style = [
          'generic',
          'posterGeneric',
          'boardingPass',
          'eventTicket',
          'coupon',
          'storeCard',
        ].find((key) => pass[key]);
        const field = ['primaryFields', 'secondaryFields', 'headerFields'].flatMap(
          (group) => pass[style][group] || [],
        )[0];
        field.value = 'W'.repeat(200000);
        for (const key of [
          'numberStyle',
          'dateStyle',
          'timeStyle',
          'currencyCode',
          'attributedValue',
        ])
          delete field[key];
      }
      const directory = path.join(output, `${id}.pkpasstemplate`),
        reference = path.join(output, `${id}.official.png`),
        api = path.join(output, `${id}.json`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'pass.json'), JSON.stringify(pass));
      try {
        const input = { pass };
        const result = process.env.AWP_TEST_ENDPOINT
          ? await renderPass(input, { endpoint: process.env.AWP_TEST_ENDPOINT, face: job.face })
          : await renderNativePass(
              Buffer.from(await (await buildPassRenderArchive(input)).arrayBuffer()),
              { face: job.face, scale: 4 },
            );
        if (result.source !== 'pass-designer') throw new Error('Exact source unavailable.');
        await writeFile(api, JSON.stringify(result));
        await writeFile(path.join(output, `${id}.png`), Buffer.from(result.png, 'base64'));
        await run(
          process.execPath,
          ['scripts/capture-reference.mjs', directory, reference, job.face],
          { timeout: 75000 },
        );
        const { stdout } = await run('python3', [
          'scripts/compare.py',
          reference,
          api,
          '--output',
          path.join(output, `${id}.comparison`),
        ]);
        const comparison = JSON.parse(stdout);
        results.push({
          id,
          ok: comparison.exact,
          changedPixels: comparison.changedPixels,
          colorMetadataEqual: comparison.colorMetadataEqual,
        });
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      }
      console.log(
        `${results.length}/${jobs.length} ${id}: ${results.at(-1).ok ? 'exact' : 'FAILED'}`,
      );
    }
  }),
);
const report = {
  testedAt: new Date().toISOString(),
  concurrency,
  scope: 'Pass Designer build 28, macOS 27, 4x, System language; synthetic examples',
  total: jobs.length,
  passed: results.filter((result) => result.ok).length,
  results,
};
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ total: report.total, passed: report.passed, output }));
if (report.passed !== report.total) process.exitCode = 1;
