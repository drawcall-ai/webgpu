import assert from 'node:assert/strict';
import { createCanvas } from '@drawcall/webgpu';

// The Mesa release that deps/mesa.py bundles; test/tools/release.test.js keeps them in step.
const MESA = '25.0.7';

// Installed Vulkan drivers are selected by the standard loader variables; the package must not alter them.
const names = ['VK_DRIVER_FILES', 'VK_ICD_FILENAMES'];
const before = names.map(name => process.env[name]);
const unchanged = when => assert.deepEqual(names.map(name => process.env[name]), before, `Vulkan driver selection changed ${when}`);

function describe(adapter) {
  assert.ok(adapter, 'No WebGPU adapter');
  const { vendor, architecture, device, description, isFallbackAdapter } = adapter.info;
  return { vendor, architecture, device, description, isFallbackAdapter, features: [...adapter.features].sort() };
}

const canvas = await createCanvas(1, 1);
try {
  unchanged('while a canvas was active');
  const standard = describe(await navigator.gpu.requestAdapter());
  const fallback = describe(await navigator.gpu.requestAdapter({ forceFallbackAdapter: true }));
  unchanged('during adapter selection');
  console.log(JSON.stringify({ default: standard, fallback }));
  assert.ok(fallback.description.startsWith(`llvmpipe: Mesa ${MESA} (`), `The fallback adapter must be the bundled Mesa ${MESA}: ${fallback.description}`);
  assert.equal(fallback.isFallbackAdapter, true);
  // A native GPU ranks first; without one, the bundled renderer is the default.
  if (standard.isFallbackAdapter) assert.deepEqual(standard, fallback);
} finally {
  await canvas.dispose();
}
unchanged('after canvas disposal');
