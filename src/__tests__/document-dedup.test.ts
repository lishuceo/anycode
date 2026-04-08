/**
 * Document Deduplication Tests
 *
 * Tests for deduplicateDocuments() which prevents duplicate PDF documents
 * from exceeding the Anthropic API 30MB message size limit.
 *
 * Bug: In a thread where multiple messages quote/reply-to the same PDF file,
 * each message independently downloads that PDF. Without dedup, the same 4.4MB
 * PDF could be included 8+ times, pushing the payload to 36MB and triggering
 * "message size exceeds 30.000MB limit" error.
 */
import { describe, it, expect } from 'vitest';
import { deduplicateDocuments } from '../feishu/event-handler.js';
import type { DocumentAttachment } from '../claude/types.js';

// ============================================================
// Helpers
// ============================================================

function makePdf(fileName: string, sizeBytes: number): DocumentAttachment {
  // base64 encoded size is ~4/3 of raw, but we use string length as proxy
  return {
    data: 'A'.repeat(sizeBytes),
    mediaType: 'application/pdf',
    fileName,
  };
}

// ============================================================
// Tests
// ============================================================

describe('deduplicateDocuments', () => {
  it('removes duplicate documents by fileName', () => {
    const pdf1 = makePdf('resume.pdf', 1000);
    const pdf2 = makePdf('resume.pdf', 1000); // same name
    const pdf3 = makePdf('report.pdf', 2000);

    const result = deduplicateDocuments([pdf1, pdf2, pdf3]);

    expect(result).toHaveLength(2);
    expect(result[0].fileName).toBe('resume.pdf');
    expect(result[1].fileName).toBe('report.pdf');
  });

  it('preserves order — first occurrence wins', () => {
    const current = makePdf('吴亮.pdf', 5000);
    const history = makePdf('吴亮.pdf', 5000);

    // Current message doc comes first (higher priority)
    const result = deduplicateDocuments([current, history]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(current); // same reference
  });

  it('enforces total size limit', () => {
    const big1 = makePdf('big1.pdf', 12 * 1024 * 1024); // 12MB
    const big2 = makePdf('big2.pdf', 12 * 1024 * 1024); // 12MB — would exceed 20MB total
    const small = makePdf('small.pdf', 100);

    const result = deduplicateDocuments([big1, big2, small]);

    expect(result).toHaveLength(2);
    expect(result[0].fileName).toBe('big1.pdf');
    expect(result[1].fileName).toBe('small.pdf'); // big2 skipped, small fits
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateDocuments([])).toEqual([]);
  });

  it('returns single doc unchanged', () => {
    const pdf = makePdf('only.pdf', 500);
    const result = deduplicateDocuments([pdf]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(pdf);
  });

  it('handles the exact bug scenario: same PDF from quoted parent + history', () => {
    // This is the exact scenario that caused the 36MB error:
    // Same "吴亮.pdf" (4.4MB) downloaded from both quoted parent and history
    const fromQuotedParent = makePdf('吴亮 .pdf', 4_425_740);
    const fromHistory = makePdf('吴亮 .pdf', 4_425_740);

    const result = deduplicateDocuments([fromQuotedParent, fromHistory]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(fromQuotedParent);
  });
});
