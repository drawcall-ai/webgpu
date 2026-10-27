import { createCanvas } from '@drawcall/webgpu';
import sharp from 'sharp';
import { createApp } from './scene.js';

const output = process.argv[2] ?? 'frame.png';
const canvas = await createCanvas(800, 600);
let app;
try {
  app = await createApp(canvas);
  app.render();
  await sharp(await canvas.readPixels(), {
    raw: { width: canvas.width, height: canvas.height, channels: 4 },
  }).png().toFile(output);
  console.log(output);
} finally {
  try { await app?.dispose(); } finally { await canvas.dispose(); }
}
