import { globals } from './globals.js';
import { loadNative } from './native.js';

let runtime;

// Keep Dawn's instance alive independently of canvases and devices. It does not
// keep Node's event loop alive when no GPU operations are pending.
export function getRuntime() {
  if (runtime) return runtime;
  const installed = globals();
  const loaded = loadNative();
  try {
    const gpu = loaded.native.create(['backend=vulkan']);
    for (const [name, value] of Object.entries(loaded.native.globals)) {
      if (name !== 'ImageBitmap') installed.set(name, value);
    }
    const navigator = globalThis.navigator ?? {};
    Object.defineProperty(navigator, 'gpu', { value: gpu, configurable: true });
    if (!globalThis.navigator) installed.set('navigator', navigator);
    runtime = { gpu, native: loaded.native };
    return runtime;
  } catch (error) {
    installed.restore();
    loaded.restore();
    throw error;
  }
}

/** Select a native software adapter using standard GPURequestAdapterOptions. */
export async function requestAdapter(options) {
  return getRuntime().gpu.requestAdapter(options);
}

/** Preferred canvas format of the active WebGPU implementation. */
export function getPreferredCanvasFormat() {
  return getRuntime().gpu.getPreferredCanvasFormat();
}
