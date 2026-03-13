import sharp from 'sharp';
import { logger } from './logger.js';
import type { ImageAttachment } from '../claude/types.js';

type ImageMediaType = ImageAttachment['mediaType'];

/** Target max raw bytes before base64 encoding (~1MB base64) */
const TARGET_RAW_BYTES = 750 * 1024;

/** Skip compression for images under this size */
const COMPRESS_THRESHOLD_BYTES = 100 * 1024;

/** Max dimension on longest side (first pass) */
const MAX_DIMENSION = 1536;

/** Fallback dimension if first pass still too large */
const FALLBACK_DIMENSION = 1024;

/** JPEG quality for photos */
const JPEG_QUALITY = 80;

/** More aggressive JPEG quality for second pass */
const JPEG_QUALITY_AGGRESSIVE = 70;

/** JPEG quality for last-resort PNG→JPEG conversion */
const JPEG_QUALITY_FALLBACK = 85;

export interface CompressedImage {
  data: Buffer;
  mediaType: ImageMediaType;
}

/**
 * Compress an image to keep base64 output under ~1MB.
 * - JPEG/WebP/GIF → resize + JPEG output
 * - PNG → resize + PNG output, falls back to JPEG if still too large
 * - GIF → extract first frame
 * - Graceful fallback: returns original on any error
 */
export async function compressImage(
  buf: Buffer,
  originalMediaType: ImageMediaType,
): Promise<CompressedImage> {
  if (buf.length <= COMPRESS_THRESHOLD_BYTES) {
    return { data: buf, mediaType: originalMediaType };
  }

  try {
    return await doCompress(buf, originalMediaType);
  } catch (err) {
    logger.warn(
      { err, originalSize: buf.length, mediaType: originalMediaType },
      'Image compression failed, using original',
    );
    return { data: buf, mediaType: originalMediaType };
  }
}

async function doCompress(
  buf: Buffer,
  mediaType: ImageMediaType,
): Promise<CompressedImage> {
  const meta = await sharp(buf).metadata();
  const longestSide = Math.max(meta.width ?? 0, meta.height ?? 0);

  const isPhoto = mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif';

  if (isPhoto) {
    return compressAsJpeg(buf, mediaType, longestSide);
  }

  // PNG: try to keep as PNG
  return compressAsPng(buf, longestSide);
}

async function compressAsJpeg(
  buf: Buffer,
  mediaType: ImageMediaType,
  longestSide: number,
): Promise<CompressedImage> {
  // GIF: extract first frame only
  const input = mediaType === 'image/gif'
    ? sharp(buf, { pages: 1 })
    : sharp(buf);

  // Auto-rotate from EXIF then strip metadata
  const pipeline = input.rotate();

  const resized = longestSide > MAX_DIMENSION
    ? pipeline.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside' })
    : pipeline;

  const result = await resized.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();

  if (result.length <= TARGET_RAW_BYTES) {
    return { data: result, mediaType: 'image/jpeg' };
  }

  // Still too large → more aggressive (preserve GIF first-frame extraction)
  const aggressiveInput = mediaType === 'image/gif' ? sharp(buf, { pages: 1 }) : sharp(buf);
  const smaller = await aggressiveInput
    .rotate()
    .resize({ width: FALLBACK_DIMENSION, height: FALLBACK_DIMENSION, fit: 'inside' })
    .jpeg({ quality: JPEG_QUALITY_AGGRESSIVE, mozjpeg: true })
    .toBuffer();

  if (smaller.length > TARGET_RAW_BYTES) {
    logger.warn(
      { size: smaller.length, target: TARGET_RAW_BYTES },
      'Image still exceeds target after aggressive compression',
    );
  }

  return { data: smaller, mediaType: 'image/jpeg' };
}

async function compressAsPng(
  buf: Buffer,
  longestSide: number,
): Promise<CompressedImage> {
  // First pass: resize to MAX_DIMENSION
  const resized = longestSide > MAX_DIMENSION
    ? sharp(buf).rotate().resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside' })
    : sharp(buf).rotate();

  const pngResult = await resized.png({ compressionLevel: 9 }).toBuffer();

  if (pngResult.length <= TARGET_RAW_BYTES) {
    return { data: pngResult, mediaType: 'image/png' };
  }

  // Second pass: resize to FALLBACK_DIMENSION
  const smallerPng = await sharp(buf)
    .rotate()
    .resize({ width: FALLBACK_DIMENSION, height: FALLBACK_DIMENSION, fit: 'inside' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  if (smallerPng.length <= TARGET_RAW_BYTES) {
    return { data: smallerPng, mediaType: 'image/png' };
  }

  // Last resort: convert to JPEG
  const jpegFallback = await sharp(buf)
    .rotate()
    .resize({ width: FALLBACK_DIMENSION, height: FALLBACK_DIMENSION, fit: 'inside' })
    .jpeg({ quality: JPEG_QUALITY_FALLBACK, mozjpeg: true })
    .toBuffer();

  return { data: jpegFallback, mediaType: 'image/jpeg' };
}
