import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@drawcall/webgpu';
import { Color, Scene, PerspectiveCamera, WebGPURenderer } from 'three/webgpu';

test('canvas supports default Three alpha, restores globals, and packs unaligned readback rows', async () => {
  const names = ['ImageBitmap', 'createImageBitmap', 'Worker', 'self', 'ProgressEvent', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const before = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  await assert.rejects(createCanvas(0, 2));
  for (let iteration = 0; iteration < 2; iteration++) {
    const canvas = await createCanvas(2, 2);
    const renderer = iteration === 0
      ? new WebGPURenderer({ canvas, antialias: false, alpha: false })
      : new WebGPURenderer({ canvas });
    try {
      await renderer.init();
      await assert.rejects(canvas.readPixels(), /Render a frame/);
      const scene = new Scene();
      scene.background = new Color(0xff0000);
      renderer.render(scene, new PerspectiveCamera());
      assert.deepEqual([...await canvas.readPixels()], Array(4).fill([255, 0, 0, 255]).flat());
      renderer.setSize(3, 2, false);
      scene.background.set(0x00ff00);
      renderer.render(scene, new PerspectiveCamera());
      assert.deepEqual([...await canvas.readPixels()], Array(6).fill([0, 255, 0, 255]).flat());
      if (iteration === 1) {
        scene.background = null;
        renderer.setClearColor(0xff0000, 0.5);
        renderer.render(scene, new PerspectiveCamera());
        const pixels = await canvas.readPixels();
        assert.equal(pixels.length, 24);
        for (let index = 0; index < pixels.length; index += 4) {
          // Three's float32 sRGB transform can quantize red to 127 while alpha rounds to 128.
          assert.ok(Math.abs(pixels[index] - 255) <= 2, 'Half-alpha red must be unpremultiplied');
          assert.deepEqual([...pixels.subarray(index + 1, index + 4)], [0, 0, 128]);
        }
        renderer.setClearAlpha(0);
        renderer.render(scene, new PerspectiveCamera());
        assert.deepEqual([...await canvas.readPixels()], Array(6).fill([0, 0, 0, 0]).flat());
      }
    } finally {
      try { await renderer.dispose(); } finally { await canvas.dispose(); }
    }
    assert.deepEqual(names.map(name => Object.getOwnPropertyDescriptor(globalThis, name)), before);
    await assert.rejects(canvas.readPixels());
  }
});

test('classic Worker failure terminates a waiting loader visibly', { timeout: 15000 }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const source = `
    import { createCanvas } from '@drawcall/webgpu';
    await createCanvas(2, 2);
    const url = URL.createObjectURL(new Blob(['throw new Error("worker-regression-marker")']));
    new Worker(url);
    await new Promise(() => {});
  `;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 10000 }), error => {
    assert.equal(error.killed, false, 'Worker failure must not hang until timeout');
    assert.equal(error.code, 1);
    assert.match(error.stderr, /worker-regression-marker/);
    return true;
  });
});

test('canvas acquisition during final cleanup preserves the new loader host', async () => {
  const first = await createCanvas(2, 2);
  const next = createCanvas(2, 2);
  const disposed = first.dispose();
  const second = await next;
  await disposed;
  try {
    assert.equal(typeof globalThis.createImageBitmap, 'function');
    assert.equal(typeof globalThis.Worker, 'function');
    const renderer = new WebGPURenderer({ canvas: second });
    try {
      await renderer.init();
      const scene = new Scene();
      scene.background = new Color(0xff0000);
      renderer.render(scene, new PerspectiveCamera());
      assert.deepEqual([...await second.readPixels()], Array(4).fill([255, 0, 0, 255]).flat());
    } finally { await renderer.dispose(); }
  } finally { await second.dispose(); }
});
