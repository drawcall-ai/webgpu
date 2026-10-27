import { test, expect } from '@playwright/test';

test('upstream compute texture renders and resizes through the browser export', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    window.passes = { compute: 0, render: 0 };
    for (const [method, kind] of [['beginComputePass', 'compute'], ['beginRenderPass', 'render']]) {
      const original = GPUCommandEncoder.prototype[method];
      GPUCommandEncoder.prototype[method] = function (...args) {
        window.passes[kind]++;
        return original.apply(this, args);
      };
    }
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.passes.compute)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.passes.render)).toBeGreaterThan(0);
  const canvas = page.locator('canvas');
  await expect(canvas).toHaveAttribute('width', '800');
  await expect(canvas).toHaveAttribute('height', '600');
  await canvas.screenshot({ path: testInfo.outputPath('render.png') });

  const rendered = await page.evaluate(() => window.passes.render);
  await page.setViewportSize({ width: 640, height: 360 });
  await expect(canvas).toHaveAttribute('width', '640');
  await expect(canvas).toHaveAttribute('height', '360');
  await expect.poll(() => page.evaluate(() => window.passes.render)).toBeGreaterThan(rendered);
  await expect(canvas).toHaveCSS('width', '640px');
  await expect(canvas).toHaveCSS('height', '360px');
  await canvas.screenshot({ path: testInfo.outputPath('resized.png') });
  expect(errors).toEqual([]);
});

test('standard compute readback and offscreen rendering share a browser device', async ({ page }) => {
  await page.goto('/test/fixtures/runtime.html');
  await page.waitForFunction(() => window.webgpu);
  const result = await page.evaluate(async () => {
    const { createCanvas, requestAdapter, getPreferredCanvasFormat } = window.webgpu;
    const adapter = await requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter available');
    const device = await adapter.requestDevice();
    const errors = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    device.pushErrorScope('validation');
    const output = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var<storage, read_write> result: array<u32>;
      @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
        result[id.x] = id.x * 3u + 7u;
      }
    ` });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module } });
    const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] });
    const canvas = await createCanvas(32, 16, { offscreen: true });
    const context = canvas.getContext('webgpu');
    const format = getPreferredCanvasFormat();
    context.configure({ device, format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const texture = context.getCurrentTexture();
    const pixels = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    const compute = encoder.beginComputePass();
    compute.setPipeline(pipeline);
    compute.setBindGroup(0, bindings);
    compute.dispatchWorkgroups(4);
    compute.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 16);
    const render = encoder.beginRenderPass({ colorAttachments: [{
      view: texture.createView(),
      clearValue: { r: 1, g: 0, b: 0, a: 1 },
      loadOp: 'clear', storeOp: 'store',
    }] });
    render.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: pixels, bytesPerRow: 256 }, [1, 1]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Uint32Array(readback.getMappedRange()));
    readback.unmap();
    const validation = await device.popErrorScope();
    if (validation) errors.push(validation.message);
    await pixels.mapAsync(GPUMapMode.READ);
    const rgba = Array.from(new Uint8Array(pixels.getMappedRange()).slice(0, 4));
    if (format === 'bgra8unorm') [rgba[0], rgba[2]] = [rgba[2], rgba[0]];
    pixels.unmap();
    pixels.destroy();
    context.unconfigure();
    output.destroy();
    readback.destroy();
    device.destroy();
    return { values, rgba, errors, offscreen: canvas instanceof OffscreenCanvas };
  });
  expect(result).toEqual({ values: [7, 10, 13, 16], rgba: [255, 0, 0, 255], errors: [], offscreen: true });
});
