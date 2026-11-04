import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { createCanvas, requestAdapter } from '@drawcall/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { buildScene, WIDTH, HEIGHT } from './scenes.js';
import { serve } from './server.js';

// Adapter 'fallback' pins the bundled CPU renderer; 'default' lets WebGPU choose.
const [name, output, adapter = 'default'] = process.argv.slice(2);
if (!['default', 'fallback'].includes(adapter)) throw new Error(`Unknown adapter: ${adapter}`);
const server = await serve();
let canvas, renderer, device;
let hash;
try {
  canvas = await createCanvas(WIDTH, HEIGHT);
  if (adapter === 'fallback') {
    const fallback = await requestAdapter({ forceFallbackAdapter: true });
    device = await fallback.requestDevice({ requiredFeatures: [...fallback.features] });
  }
  renderer = new WebGPURenderer({ canvas, device, antialias: false, alpha: false });
  await renderer.init();
  renderer.shadowMap.enabled = name === 'soldier';
  const { scene, camera } = await buildScene(name, renderer, server.url, WIDTH / HEIGHT);
  renderer.render(scene, camera);
  const pixels = await canvas.readPixels();
  await sharp(pixels, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).png().toFile(output);
  hash = createHash('sha256').update(pixels).digest('hex');
} finally {
  try { await renderer?.dispose(); } finally {
    try { await canvas?.dispose(); } finally {
      try { device?.destroy(); } finally { await server.close(); }
    }
  }
}
const peakRssKiB = process.resourceUsage().maxRSS;
console.log(JSON.stringify({ scene: name, adapter, hash, peakRssMiB: peakRssKiB > 0 ? peakRssKiB / 1024 : null }));
