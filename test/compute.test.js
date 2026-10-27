import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCanvas, requestAdapter, getPreferredCanvasFormat } from '@drawcall/webgpu';

test('compute and multiple canvases share a device without owning its lifetime', async () => {
  const adapter = await requestAdapter();
  assert.ok(adapter);
  const device = await adapter.requestDevice();
  const [first, second] = await Promise.all([createCanvas(3, 2), createCanvas(3, 2)]);
  const storage = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const module = device.createShaderModule({ code: `
    @group(0) @binding(0) var<storage, read_write> result: array<u32>;
    @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
      result[id.x] = id.x * 3u + 7u;
    }
  ` });
  try {
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module } });
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: storage } }] });
    for (const canvas of [first, second]) {
      const context = canvas.getContext('webgpu');
      context.configure({ device, format: getPreferredCanvasFormat() });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 1, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.end();
      device.queue.submit([encoder.finish()]);
      assert.deepEqual([...await canvas.readPixels()], Array(6).fill([255, 0, 0, 255]).flat());
      await canvas.dispose();
    }
    // Last canvas cleanup must not destroy the caller-owned compute device.
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(4);
    pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    assert.deepEqual([...new Uint32Array(readback.getMappedRange())], [7, 10, 13, 16]);
  } finally {
    storage.destroy(); readback.destroy();
    device.destroy();
    await first.dispose(); await second.dispose();
  }
});

test('compute-only process installs no loader host and exits without forced shutdown', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { requestAdapter } from '@drawcall/webgpu';
    const before = [globalThis.Worker, globalThis.ImageBitmap, globalThis.createImageBitmap];
    const adapter = await requestAdapter();
    const device = await adapter.requestDevice();
    await device.queue.onSubmittedWorkDone();
    device.destroy();
    assert.deepEqual([globalThis.Worker, globalThis.ImageBitmap, globalThis.createImageBitmap], before);
    console.log('complete');
  `], { timeout: 15000 });
  assert.match(stdout, /complete/);
});
