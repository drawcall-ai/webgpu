/** Return a real browser canvas; CSS, events and layout remain browser-owned. */
export async function createCanvas(width, height, { offscreen = false } = {}) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new RangeError('Canvas dimensions must be positive integers');
  }
  if (typeof offscreen !== 'boolean') throw new TypeError('offscreen must be a boolean');
  if (offscreen) return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function gpu() {
  if (!globalThis.navigator?.gpu) throw new Error('WebGPU is unavailable; use a supported browser in a secure context');
  return navigator.gpu;
}

/** Forward standard adapter selection to the browser, including its null result. */
export async function requestAdapter(options) {
  return gpu().requestAdapter(options);
}

export function getPreferredCanvasFormat() {
  return gpu().getPreferredCanvasFormat();
}
