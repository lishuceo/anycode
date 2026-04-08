import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

vi.mock('../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { compressImage, compressImageForHistory } from '../image-compress.js';

/**
 * Create a noisy raw pixel buffer and encode to JPEG.
 * Random pixels create incompressible data, resulting in large files.
 */
async function createNoisyJpeg(width: number, height: number, quality = 95): Promise<Buffer> {
  const raw = randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
}


describe('compressImage', () => {
  it('should pass through small images unchanged', async () => {
    const small = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 128, g: 64, b: 32 } },
    }).jpeg({ quality: 80 }).toBuffer();
    expect(small.length).toBeLessThan(100 * 1024);

    const result = await compressImage(small, 'image/jpeg');
    expect(result.data).toBe(small); // same reference = unchanged
    expect(result.mediaType).toBe('image/jpeg');
  });

  it('should compress large JPEG images', async () => {
    const large = await createNoisyJpeg(3000, 2000);
    expect(large.length).toBeGreaterThan(100 * 1024);

    const result = await compressImage(large, 'image/jpeg');
    expect(result.data.length).toBeLessThan(large.length);
    expect(result.mediaType).toBe('image/jpeg');

    // Verify dimensions were reduced
    const meta = await sharp(result.data).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1536);
  });

  it('should keep PNG as PNG when result fits target', async () => {
    // Solid-color PNG compresses very well — should stay PNG
    const png = await sharp({
      create: { width: 2000, height: 2000, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 255 } },
    }).png().toBuffer();

    const result = await compressImage(png, 'image/png');
    expect(result.mediaType).toBe('image/png');
    expect(result.data.length).toBeLessThan(750 * 1024);
  });

  it('should handle WebP as photo (output JPEG)', async () => {
    const raw = randomBytes(2000 * 1500 * 3);
    const webp = await sharp(raw, { raw: { width: 2000, height: 1500, channels: 3 } })
      .webp({ quality: 95 })
      .toBuffer();
    expect(webp.length).toBeGreaterThan(100 * 1024);

    const result = await compressImage(webp, 'image/webp');
    expect(result.mediaType).toBe('image/jpeg');
  });

  it('should extract first frame from GIF (output JPEG)', { timeout: 15000 }, async () => {
    const raw = randomBytes(800 * 800 * 4);
    const gif = await sharp(raw, { raw: { width: 800, height: 800, channels: 4 } })
      .gif()
      .toBuffer();
    expect(gif.length).toBeGreaterThan(100 * 1024);

    const result = await compressImage(gif, 'image/gif');
    expect(result.mediaType).toBe('image/jpeg');
  });

  it('should gracefully fallback on corrupted buffer', async () => {
    const garbage = Buffer.from('not-a-real-image-at-all-just-garbage-data'.repeat(3000));

    const result = await compressImage(garbage, 'image/jpeg');
    expect(result.data).toBe(garbage);
    expect(result.mediaType).toBe('image/jpeg');
  });

  it('should strip EXIF metadata', async () => {
    const noisy = await createNoisyJpeg(2000, 1500);
    // Add EXIF metadata
    const withMeta = await sharp(noisy)
      .withMetadata({ exif: { IFD0: { Copyright: 'Test' } } })
      .jpeg({ quality: 95 })
      .toBuffer();
    expect(withMeta.length).toBeGreaterThan(100 * 1024);

    const beforeMeta = await sharp(withMeta).metadata();
    expect(beforeMeta.exif).toBeDefined();

    const result = await compressImage(withMeta, 'image/jpeg');
    const outputMeta = await sharp(result.data).metadata();
    expect(outputMeta.exif).toBeUndefined();
  });

  it('should preserve aspect ratio', async () => {
    const wide = await createNoisyJpeg(4000, 1000); // 4:1 ratio

    const result = await compressImage(wide, 'image/jpeg');
    const meta = await sharp(result.data).metadata();

    const ratio = meta.width! / meta.height!;
    expect(ratio).toBeCloseTo(4.0, 0);
  });

  it('should keep output under target size for large photos', async () => {
    const large = await createNoisyJpeg(4000, 3000);
    expect(large.length).toBeGreaterThan(100 * 1024);

    const result = await compressImage(large, 'image/jpeg');
    expect(result.data.length).toBeLessThan(750 * 1024);
    expect(result.mediaType).toBe('image/jpeg');
  });
});

describe('compressImageForHistory', () => {
  it('should compress to smaller dimensions than standard compression', async () => {
    const large = await createNoisyJpeg(3000, 2000);
    expect(large.length).toBeGreaterThan(100 * 1024);

    const result = await compressImageForHistory(large, 'image/jpeg');
    expect(result.mediaType).toBe('image/jpeg');

    const meta = await sharp(result.data).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(768);
  });

  it('should produce smaller output than standard compression', async () => {
    const large = await createNoisyJpeg(3000, 2000);

    const [standard, history] = await Promise.all([
      compressImage(large, 'image/jpeg'),
      compressImageForHistory(large, 'image/jpeg'),
    ]);

    expect(history.data.length).toBeLessThan(standard.data.length);
  });

  it('should handle PNG input', async () => {
    const png = await sharp({
      create: { width: 2000, height: 2000, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 255 } },
    }).png().toBuffer();

    const result = await compressImageForHistory(png, 'image/png');
    expect(result.mediaType).toBe('image/jpeg'); // always converts to JPEG
    const meta = await sharp(result.data).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(768);
  });

  it('should gracefully fallback on corrupted buffer', async () => {
    const garbage = Buffer.from('not-a-real-image'.repeat(3000));

    // Should not throw, falls back to standard compression (which returns original)
    const result = await compressImageForHistory(garbage, 'image/jpeg');
    expect(result.data).toBe(garbage);
  });
});
