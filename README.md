# @drawcall/webgpu

Use standard Three.js rendering and WebGPU compute in browsers and GPU-less Node.js. Browsers use their own WebGPU implementation; Node uses bundled native CPU rendering. Three.js and original assets stay unchanged.

```js
import { createCanvas } from '@drawcall/webgpu';
import { WebGPURenderer } from 'three/webgpu';

const canvas = await createCanvas(1280, 720);
const renderer = new WebGPURenderer({ canvas });
await renderer.init();
// Build or load your scene with three/webgpu and standard Three.js loaders.
renderer.render(scene, camera);
```

In a browser, append the returned canvas to your container. It is a real canvas with normal CSS, events, and resizing. Use `{ offscreen: true }` as the third argument for an `OffscreenCanvas`. Browser support requires WebGPU in a secure context. Node canvases are always headless: CSS assignments are inert; explicit dimensions control output resolution.

For Node image export, canvas-free compute, loading assets, and cleanup, see the shipped [usage skill](skills/webgpu/SKILL.md). Compute uses `requestAdapter()` followed by standard WebGPU device and command APIs. Node does not provide DOM layout, video, or canvas-2D texture sources.

Node requires version 22+. Native packages bundle the software renderer and Vulkan loader for Linux x64/ARM64 (glibc 2.28+ or musl 1.2.5+/Alpine 3.22+), macOS 13.5+ (Intel/Apple Silicon), and Windows x64/ARM64. x64 requires SSE4.2. No GPU, browser, compiler, SDK, or system graphics packages are needed. Keep npm optional dependencies enabled. Other platform/CPU combinations are unsupported.

Run the upstream Three.js [compute-texture example](examples/compute-texture) with `npm install --prefix examples/compute-texture` and `npm run dev --prefix examples/compute-texture`. Browser and Node entry points share the same scene, compute, and camera logic, extracted from the upstream example. Render a PNG without a browser using `npm run render --prefix examples/compute-texture -- frame.png`.
