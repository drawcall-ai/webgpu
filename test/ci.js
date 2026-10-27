import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SCENES } from './scenes.js';

const repetitions = Number(process.argv[2] ?? 3);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0, 'Repetitions must be a positive integer');
const root = fileURLToPath(new URL('../', import.meta.url));
assert.equal(process.env.DRAWCALL_WEBGPU_NATIVE, undefined, 'CI must resolve the installed native package');
assert.equal(fileURLToPath(import.meta.resolve('@drawcall/webgpu')), join(root, 'node_modules/@drawcall/webgpu/src/index.js'), 'CI must test the installed package in a clean consumer');
const output = join(root, 'test/out');
await mkdir(output, { recursive: true });
const execute = promisify(execFile);
const run = args => execute(process.execPath, args, { cwd: root, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const threeRoot = dirname(dirname(fileURLToPath(import.meta.resolve('three'))));

async function fingerprint(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fingerprint(path));
    else if (entry.isFile()) result[path] = await digest(path);
  }
  return result;
}

const sources = async () => ({
  three: await fingerprint(threeRoot),
  models: await fingerprint(join(root, 'test/models')),
});
const provenance = JSON.parse(await readFile(join(root, 'test/reference/manifest.json'), 'utf8'));
for (const [name, hash] of Object.entries(provenance.models)) {
  assert.equal(await digest(join(root, 'test/models', name)), hash, `Original asset changed: ${name}`);
}
for (const scene of SCENES) {
  assert.equal(await digest(join(root, 'test/reference', `${scene}.png`)), provenance[scene].sha256, `Reference changed: ${scene}`);
}
const before = await sources();
const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  reference: provenance,
  memoryMeasurement: 'Render process.resourceUsage().maxRSS after cleanup; null when unavailable',
  rows: [],
};
const reportPath = join(output, `ci-${process.platform}-${process.arch}.json`);
try {
  const adapter = await run(['test/adapter.js']);
  report.adapter = JSON.parse(adapter.stdout);
  process.stdout.write(adapter.stdout);
  process.stderr.write(adapter.stderr);
  const tests = (await readdir(join(root, 'test'))).filter(name => name.endsWith('.test.js')).sort();
  report.tests = await run(['--test', '--test-concurrency=1', ...tests.map(name => `test/${name}`)]);
  process.stdout.write(report.tests.stdout);
  process.stderr.write(report.tests.stderr);
  report.example = await run(['--test', 'examples/compute-texture/test/node.test.js']);
  process.stdout.write(report.example.stdout);
  process.stderr.write(report.example.stderr);
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const scene of SCENES) {
      const png = join(output, `${scene}-${repetition}.png`);
      const start = performance.now();
      const rendered = await run(['test/render.js', scene, png]);
      const wallSeconds = (performance.now() - start) / 1000;
      const result = JSON.parse(rendered.stdout);
      const verified = await run(['test/verify.js', scene, png, result.hash]);
      const row = { ...result, repetition, wallSeconds, quality: JSON.parse(verified.stdout), stderr: rendered.stderr };
      report.rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  assert.deepEqual(await sources(), before, 'Three.js or original model bytes changed');
  for (const scene of SCENES) {
    assert.equal(new Set(report.rows.filter(row => row.scene === scene).map(row => row.hash)).size, 1, `${scene} changed between fresh processes`);
  }
  report.sourcesUnchanged = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = { message: error.message, stack: error.stack, stdout: error.stdout, stderr: error.stderr };
  throw error;
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(reportPath);
}
