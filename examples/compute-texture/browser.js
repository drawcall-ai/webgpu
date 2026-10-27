import { createCanvas } from '@drawcall/webgpu';
import WebGPU from 'three/addons/capabilities/WebGPU.js';
import { createApp } from './scene.js';

if (!WebGPU.isAvailable()) {
  document.body.appendChild(WebGPU.getErrorMessage());
  throw new Error('No WebGPU support');
}

const canvas = await createCanvas(window.innerWidth, window.innerHeight);
const app = await createApp(canvas, window.devicePixelRatio);
document.body.appendChild(canvas);
app.render();
window.addEventListener('resize', () => app.resize(window.innerWidth, window.innerHeight));
