// Node image decoding for the platform boundary. Three's loaders remain untouched.
import { globals } from './globals.js';

let sharpPromise;

/**
 * Let copyExternalImageToTexture take ImageData and 2D canvases, which Node has only through canvas libraries: their
 * pixels upload through a temporary native ImageBitmap, so copies behave as the ImageBitmap copies browsers match.
 */
export function installCopySources(native) {
  const { prototype } = native.globals.GPUQueue;
  const copy = prototype.copyExternalImageToTexture;
  prototype.copyExternalImageToTexture = function (source, destination, size) {
    const pixels = imageData(source?.source);
    // Anything else reaches the native method, which reports what it does not support.
    if (!pixels) return copy.call(this, source, destination, size);
    const bytes = new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength);
    const bitmap = native.createImageBitmapFromRGBA(pixels.width, pixels.height, bytes);
    try {
      return copy.call(this, { ...source, source: bitmap }, destination, size);
    } finally {
      bitmap.close();
    }
  };
}

/** The straight-alpha sRGB pixels of ImageData, or of a canvas with a 2D context. */
function imageData(image) {
  if (typeof image !== 'object' || image === null) return;
  const pixels = typeof image.getContext === 'function'
    ? image.getContext('2d')?.getImageData(0, 0, image.width, image.height)
    : image;
  if (!(pixels?.data instanceof Uint8ClampedArray)) return;
  if ((pixels.colorSpace ?? 'srgb') !== 'srgb') throw new TypeError(`Only sRGB image data uploads, not ${pixels.colorSpace}`);
  return pixels;
}

/** The straight-alpha RGBA pixels of an ImageBitmap from createImageBitmap, as ImageData's fields. */
export function readImageBitmap(native, bitmap) {
  const { data, premultipliedAlpha } = native.readImageBitmapRGBA(bitmap);
  if (premultipliedAlpha) for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha) for (let channel = i; channel < i + 3; channel++) data[channel] = Math.round(data[channel] * 255 / alpha);
  }
  return { width: bitmap.width, height: bitmap.height, data: new Uint8ClampedArray(data.buffer), colorSpace: 'srgb' };
}

export function installImages(native) {
  if (typeof native.createImageBitmapFromRGBA !== 'function') throw new Error('Native ImageBitmap bridge is unavailable');
  const installed = globals();
  let decoder, previousCache, closed = false;
  const ImageBitmap = native.ImageBitmap ?? native.globals?.ImageBitmap;
  if (!ImageBitmap) throw new Error('Native ImageBitmap constructor is unavailable');
  async function createImageBitmap(source, options = {}) {
    if (closed) throw new Error('Image decoder is disposed');
    if (!(source instanceof Blob)) throw new TypeError('This Node image platform currently supports Blob input only');
    if (arguments.length > 2) throw new TypeError('ImageBitmap cropping is not implemented');
    const supported = new Set(['imageOrientation', 'premultiplyAlpha', 'colorSpaceConversion']);
    for (const key of Object.keys(options)) if (!supported.has(key)) throw new TypeError(`Unsupported ImageBitmap option: ${key}`);
    const orientation = options.imageOrientation ?? 'from-image';
    const premultiply = options.premultiplyAlpha ?? 'default';
    const conversion = options.colorSpaceConversion ?? 'default';
    if (!['from-image', 'flipY', 'none'].includes(orientation)) throw new TypeError('Invalid imageOrientation');
    if (!['none', 'premultiply', 'default'].includes(premultiply)) throw new TypeError('Invalid premultiplyAlpha');
    if (!['none', 'default'].includes(conversion)) throw new TypeError('Invalid colorSpaceConversion');
    sharpPromise ??= import('sharp').then(module => module.default);
    const sharp = await sharpPromise;
    if (closed) throw new Error('Image decoder is disposed');
    if (!decoder) {
      decoder = sharp;
      const cache = sharp.cache();
      previousCache = { memory: cache.memory.max, files: cache.files.max, items: cache.items.max };
      sharp.cache(false);
    }
    let image = sharp(Buffer.from(await source.arrayBuffer()), { ignoreIcc: conversion === 'none' });
    if (orientation !== 'none') image = image.autoOrient();
    if (orientation === 'flipY') image = image.flip();
    if (conversion === 'default') image = image.toColourspace('srgb');
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (closed) throw new Error('Image decoder is disposed');
    const premultipliedAlpha = premultiply === 'premultiply';
    if (premultipliedAlpha) for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.round(data[i] * data[i + 3] / 255);
      data[i + 1] = Math.round(data[i + 1] * data[i + 3] / 255);
      data[i + 2] = Math.round(data[i + 2] * data[i + 3] / 255);
    }
    // The native object owns a copy; its lifetime is independent of Sharp/JS buffers.
    return native.createImageBitmapFromRGBA(info.width, info.height, data, { premultipliedAlpha, colorSpace: 'srgb' });
  }
  try {
    installed.set('createImageBitmap', createImageBitmap);
    installed.set('ImageBitmap', ImageBitmap);
  } catch (error) {
    installed.restore();
    throw error;
  }
  return () => {
    closed = true;
    installed.restore();
    if (decoder) decoder.cache(previousCache);
  };
}
