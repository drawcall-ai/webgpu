import { canvas } from './canvas.js';
import { getRuntime } from './gpu.js';

export { requestAdapter, getPreferredCanvasFormat } from './gpu.js';

/**
 * Create a headless WebGPU canvas. CSS style assignments are inert in Node;
 * width/height control output resolution. The offscreen option is browser-only
 * selection: every Node canvas is already headless.
 * readPixels() returns straight-alpha RGBA8. Dispose renderer/loaders before the
 * canvas. Canvas disposal never destroys an application-owned GPUDevice.
 */
export async function createCanvas(width, height, { offscreen = false } = {}) {
  if (typeof offscreen !== 'boolean') throw new TypeError('offscreen must be a boolean');
  let disposal;
  const target = canvas(width, height, () => {
    if (disposal) throw new Error('Canvas is disposed');
  });
  const { native } = getRuntime();
  const { acquireHost } = await import('./host.js');
  const release = await acquireHost(native);
  target.output.dispose = () => disposal ??= (async () => {
    const failures = [];
    for (const action of [() => target.close(), release]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Canvas cleanup failed');
  })();
  return target.output;
}
