import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createCanvas } from '@drawcall/webgpu';
import { imageCases } from './images.js';
import { contractCases } from './contract.js';

for (const [name, probe] of [['images', imageCases], ['contract', contractCases]]) for (const forceFallbackAdapter of [false, true]) {
  test(`native external images match browser ${name} contract on the ${forceFallbackAdapter ? 'fallback' : 'default'} adapter`, async () => {
    const reference = JSON.parse(await readFile(new URL(`reference/${name}.json`, import.meta.url)));
    const canvas = await createCanvas(2, 2);
    const adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter });
    // Match the reference browser device: rg11b10ufloat is renderable, snorm formats are not.
    const requiredFeatures = name === 'contract' ? ['rg11b10ufloat-renderable'] : [];
    const device = await adapter.requestDevice({ requiredFeatures });
    try {
      const actual = await probe(device, Buffer.from(reference.fixturePngBase64, 'base64'));
      assert.equal(actual.length, reference.results.length);
      for (let index = 0; index < actual.length; index++) {
        const value = actual[index], expected = reference.results[index];
        assert.equal(value.name, expected.name);
        assert.equal(value.error?.name, expected.error?.name, value.name);
        assert.equal(Boolean(value.validation), Boolean(expected.validation), value.name);
        assert.equal(Boolean(value.creationError), Boolean(expected.creationError), value.name);
        if (expected.pixels) {
          assert.equal(value.pixels?.length, expected.pixels.length, value.name);
          for (let i = 0; i < expected.pixels.length; i++) {
            assert.ok(Math.abs(value.pixels[i] - expected.pixels[i]) <= 1, `${value.name}: byte ${i}`);
          }
        }
      }
    } finally {
      device.destroy();
      await canvas.dispose();
    }
  });
}

test('identity upload keeps WebGPU validation including zero-sized copies', async () => {
  const reference = JSON.parse(await readFile(new URL('reference/images.json', import.meta.url)));
  const canvas = await createCanvas(2, 2);
  const device = await (await navigator.gpu.requestAdapter()).requestDevice();
  const other = await (await navigator.gpu.requestAdapter()).requestDevice();
  const bitmap = await createImageBitmap(new Blob([Buffer.from(reference.fixturePngBase64, 'base64')]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    for (const zero of [false, true]) {
      for (const invalid of ['wrong-device', 'destroyed', 'mip', 'origin', 'usage']) {
        const texture = (invalid === 'wrong-device' ? other : device).createTexture({
          size: [3, 2], format: 'rgba8unorm',
          usage: GPUTextureUsage.COPY_DST | (invalid === 'usage' ? 0 : GPUTextureUsage.RENDER_ATTACHMENT),
        });
        if (invalid === 'destroyed') texture.destroy();
        device.pushErrorScope('validation');
        device.queue.copyExternalImageToTexture({ source: bitmap }, {
          texture, mipLevel: invalid === 'mip' ? 9 : 0,
          origin: invalid === 'origin' ? [4, 0] : [0, 0],
        }, zero ? [0, 0] : [3, 2]);
        assert.ok(await device.popErrorScope(), `${invalid}, zero=${zero}`);
        texture.destroy();
      }
    }
  } finally {
    bitmap.close();
    other.destroy();
    device.destroy();
    await canvas.dispose();
  }
});

test('ICC conversion can be disabled without converting tagged pixels', async () => {
  const { default: sharp } = await import('sharp');
  const source = Uint8Array.from([220, 40, 30, 255, 20, 180, 40, 255, 40, 60, 230, 255, 127, 87, 201, 255]);
  const png = await sharp(source, { raw: { width: 4, height: 1, channels: 4 } }).withIccProfile('p3').png().toBuffer();
  // Stock Chromium reference for the same tagged P3 pixels, uploaded to sRGB.
  const expected = {
    none: [202, 59, 44, 255, 83, 177, 65, 255, 44, 59, 221, 255, 121, 89, 195, 255],
    default: [220, 40, 31, 255, 20, 180, 41, 255, 40, 60, 230, 255, 127, 87, 201, 255],
  };
  const canvas = await createCanvas(4, 1);
  const device = await (await navigator.gpu.requestAdapter()).requestDevice();
  try {
    for (const conversion of ['none', 'default']) {
      const bitmap = await createImageBitmap(new Blob([png]), { colorSpaceConversion: conversion, premultiplyAlpha: 'none' });
      const texture = device.createTexture({ size: [4, 1], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [4, 1]);
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [4, 1]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(buffer.getMappedRange());
        for (let i = 0; i < 16; i++) assert.ok(Math.abs(bytes[i] - expected[conversion][i]) <= 1, `${conversion}: byte ${i}`);
        buffer.unmap();
      } finally { bitmap.close(); buffer.destroy(); texture.destroy(); }
    }
  } finally { device.destroy(); await canvas.dispose(); }
});
