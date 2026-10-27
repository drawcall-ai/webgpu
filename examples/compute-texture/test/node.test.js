import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

test('shared scene computes and exports a colorful PNG in a fresh Node process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'webgpu-example-'));
  try {
    const output = join(directory, 'frame.png');
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../node.js', import.meta.url)), output], { timeout: 30000 });
    const { width, height, format } = await sharp(output).metadata();
    assert.deepEqual({ width, height, format }, { width: 800, height: 600, format: 'png' });
    const { channels } = await sharp(output).extract({ left: 325, top: 225, width: 150, height: 150 }).stats();
    for (const channel of channels.slice(0, 3)) {
      assert.ok(channel.stdev > 20, 'Computed texture must contain varying color, not just a clear frame');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
