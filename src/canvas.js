function dimension(value) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError('Canvas dimensions must be positive integers');
  return value;
}

// A native canvas keeps its last frame available until resize or reconfiguration.
export function canvas(width, height, check) {
  width = dimension(width);
  height = dimension(height);
  let configuration, texture, device, lost;
  let closed = false;
  const errors = [];
  const events = new EventTarget();
  const onError = event => errors.push(event.error);

  function ready() {
    check();
    if (closed) throw new Error('Canvas is disposed');
    if (lost) throw new Error(`Device lost: ${lost.reason}: ${lost.message}`);
    if (errors.length) throw new AggregateError(errors, 'WebGPU rendering failed');
  }

  function reset() {
    texture?.destroy();
    texture = undefined;
  }

  const output = {
    get width() { return width; },
    set width(value) { ready(); width = dimension(value); reset(); },
    get height() { return height; },
    set height(value) { ready(); height = dimension(value); reset(); },
    style: {},
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    getContext(type) { ready(); return type === 'webgpu' ? context : null; },
    /** Returns the current frame as packed, top-row-first straight-alpha RGBA8 bytes. */
    async readPixels() {
      ready();
      if (!texture) throw new Error('Render a frame before reading canvas pixels');
      const source = texture;
      const premultiplied = configuration.alphaMode === 'premultiplied';
      const rowBytes = source.width * 4;
      const stride = Math.ceil(rowBytes / 256) * 256;
      const buffer = device.createBuffer({ size: stride * source.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: stride }, [source.width, source.height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        ready();
        const mapped = new Uint8Array(buffer.getMappedRange());
        const pixels = new Uint8Array(rowBytes * source.height);
        for (let row = 0; row < source.height; row++) {
          pixels.set(mapped.subarray(row * stride, row * stride + rowBytes), row * rowBytes);
        }
        const bgra = source.format === 'bgra8unorm';
        if (premultiplied) {
          for (let index = 0; index < pixels.length; index += 4) {
            const alpha = pixels[index + 3];
            const scale = alpha === 0 ? 0 : 255 / alpha;
            const red = pixels[index + (bgra ? 2 : 0)];
            const blue = pixels[index + (bgra ? 0 : 2)];
            pixels[index] = Math.min(255, Math.round(red * scale));
            pixels[index + 1] = Math.min(255, Math.round(pixels[index + 1] * scale));
            pixels[index + 2] = Math.min(255, Math.round(blue * scale));
          }
        } else if (bgra) {
          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index + 2];
            pixels[index + 2] = pixels[index];
            pixels[index] = red;
          }
        }
        return pixels;
      } finally {
        buffer.destroy();
      }
    },
  };

  const context = {
    canvas: output,
    configure(value) {
      ready();
      if (device && value.device !== device) throw new TypeError('A canvas cannot switch WebGPU devices');
      if (!value.device || typeof value.device.createTexture !== 'function') throw new TypeError('A WebGPU device is required');
      if ((value.colorSpace ?? 'srgb') !== 'srgb') throw new TypeError('Only sRGB canvas color space is supported');
      if (!['opaque', 'premultiplied'].includes(value.alphaMode ?? 'opaque')) throw new TypeError('Unsupported canvas alpha mode');
      if ((value.toneMapping?.mode ?? 'standard') !== 'standard') throw new TypeError('Extended canvas tone mapping is not supported');
      if (!['rgba8unorm', 'bgra8unorm'].includes(value.format)) throw new TypeError('Unsupported canvas format');
      if (!device) {
        device = value.device;
        device.addEventListener('uncapturederror', onError);
        device.lost.then(info => { if (!closed) lost = info; });
      }
      reset();
      configuration = { ...value, viewFormats: [...(value.viewFormats ?? [])] };
    },
    getConfiguration() {
      ready();
      return configuration ? { ...configuration, viewFormats: [...configuration.viewFormats] } : null;
    },
    getCurrentTexture() {
      ready();
      if (!configuration) throw new Error('Canvas is not configured');
      if (width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D) throw new RangeError('Canvas dimensions exceed the device texture limit');
      texture ??= device.createTexture({
        size: [width, height],
        format: configuration.format,
        usage: (configuration.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC,
        viewFormats: configuration.viewFormats,
      });
      return texture;
    },
    unconfigure() { ready(); reset(); configuration = undefined; },
  };

  return {
    output,
    close() {
      closed = true;
      reset();
      configuration = undefined;
      if (device) {
        device.removeEventListener('uncapturederror', onError);
      }
      if (lost && lost.reason !== 'destroyed') errors.push(new Error(`Device lost: ${lost.reason}: ${lost.message}`));
      if (errors.length) throw new AggregateError(errors, 'WebGPU rendering failed');
    },
  };
}
