import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestAdapter } from '@drawcall/webgpu';
import { SCENES } from './scenes.js';

const execute = promisify(execFile);
// Without a native GPU the default adapter is the fallback; render it once.
const standard = await requestAdapter();
assert.ok(standard, 'No WebGPU adapter');
const adapters = standard.info.isFallbackAdapter ? ['fallback'] : ['default', 'fallback'];
for (const scene of SCENES) for (const adapter of adapters) {
  test(`${scene} renders original assets with stock Three loaders on the ${adapter} adapter`, { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webgpu-test-'));
    const output = join(directory, 'render.png');
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    try {
      const { stdout } = await execute(process.execPath, ['test/render.js', scene, output, adapter], { cwd, timeout: 90000 });
      const { hash } = JSON.parse(stdout);
      await execute(process.execPath, ['test/verify.js', scene, output, hash], { cwd, timeout: 20000 });
    } catch (error) {
      console.error({ scene, adapter, code: error.code, signal: error.signal, killed: error.killed });
      throw error;
    } finally { await rm(directory, { recursive: true }); }
  });
}
