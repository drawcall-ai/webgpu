---
name: webgpu
description: Use @drawcall/webgpu for portable Three.js rendering and WebGPU compute in browsers and GPU-less Node.js, including headless scene export with standard loaders.
---

# Render a scene

Use the same Three.js scene and renderer code in both environments. Browser canvases are real DOM elements; append them to the application container and use normal CSS and resize handling. In workers, request an offscreen canvas and send dimensions from the main thread. Node has no layout engine: supply output dimensions, and do not infer them from CSS.

In Node, create the canvas before loading assets and keep it alive until loaders and rendering finish. Import scene classes from `three/webgpu` and loaders from `three/addons`. Keep original assets intact; compressed glTF can use the standard `DRACOLoader` with its decoder directory served over HTTP.

Install `three` and `sharp` as application dependencies for this Node export pattern:

```js
import { createCanvas } from '@drawcall/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import sharp from 'sharp';

const canvas = await createCanvas(1280, 720);
const renderer = new WebGPURenderer({ canvas });
const draco = new DRACOLoader().setWorkerLimit(1).setDecoderPath(decoderURL);
try {
  await renderer.init();
  const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(modelURL);
  renderer.render(gltf.scene, camera);
  const pixels = await canvas.readPixels();
  await sharp(pixels, {
    raw: { width: canvas.width, height: canvas.height, channels: 4 },
  }).png().toFile('frame.png');
} finally {
  try { draco.dispose(); } finally {
    try { await renderer.dispose(); } finally { await canvas.dispose(); }
  }
}
```

Use HTTP(S) URLs for standard loaders, including assets on a local file server; Node's fetch does not load `file:` URLs. Supply a camera and framing suitable for the scene. Three.js resources created by your application remain yours to dispose; see [Three.js cleanup guidance](https://threejs.org/manual/en/cleanup.html).

The example above exports a frame in Node. In browsers, use the canvas normally; do not call its Node-only export and cleanup methods. For portable Three readback, use a render target and Three’s readback API.

Render the final frame to the canvas. If custom passes use render targets, call `renderer.setRenderTarget(null)` before the final canvas render and readback. Dispose the renderer and loaders before the canvas. A canvas does not own an application-supplied device: destroy that device after all rendering and compute users finish.

For cold server-side rendering, launch a fresh process per task, render, encode, and await disposal. Node does not supply a browser DOM, video decoding, 2D canvas, or the complete browser Worker API. Blob image decoding and classic workers support the tested glTF and Draco paths; other loaders may need browser APIs outside this scope. Treat unsupported API errors as compatibility gaps rather than replacing assets or patching Three.js.

# Compute without a canvas

Import `requestAdapter` from the package, check its result, then call the adapter’s standard `requestDevice` with the features and limits the workload requires. Use ordinary WGSL, buffers, compute passes, and queue submission. No canvas or loader host is needed. Destroy application-owned devices when finished; do not rely on garbage collection to release GPU resources. Browser and software adapters can expose different capabilities.

For combined raw compute and Three rendering, pass the same application-created device to `WebGPURenderer`. For Three TSL compute nodes, use the renderer’s compute API directly. Neither path requires changing Three.js.
