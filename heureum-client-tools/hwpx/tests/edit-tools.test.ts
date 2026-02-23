import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { createHwpx } from '../src/writer.js';
import {
  hwpxSetMetadata,
  hwpxFindReplace,
  hwpxInsertText,
  hwpxMergeDocuments,
} from '../src/tools.js';

const TMP_DIR = path.join(__dirname, '__tmp_edit_tools__');

function tmpPath(name: string): string {
  return path.join(TMP_DIR, name);
}

async function readZipFile(hwpxPath: string, innerPath: string): Promise<string> {
  const buf = fs.readFileSync(hwpxPath);
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file(innerPath);
  if (!file) throw new Error(`${innerPath} not found in ${hwpxPath}`);
  return file.async('string');
}

beforeAll(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── Helper: create a sample HWPX for editing tests ──────

async function createSampleHwpx(name: string, markdown: string): Promise<string> {
  const buf = await createHwpx(markdown);
  const filePath = tmpPath(name);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// ════════════════════════════════════════════════════════
// 1. hwpx_set_metadata
// ════════════════════════════════════════════════════════

describe('hwpxSetMetadata', () => {
  it('should update title', async () => {
    const src = await createSampleHwpx('meta-title.hwpx', '# Original');
    const out = tmpPath('meta-title-out.hwpx');
    const result = await hwpxSetMetadata({ path: src, title: 'New Title', output_path: out });

    expect(result.success).toBe(true);
    const hpf = await readZipFile(out, 'Contents/content.hpf');
    expect(hpf).toContain('<opf:title>New Title</opf:title>');
  });

  it('should update author (creator + lastsaveby)', async () => {
    const src = await createSampleHwpx('meta-author.hwpx', 'Hello');
    const out = tmpPath('meta-author-out.hwpx');
    const result = await hwpxSetMetadata({ path: src, author: 'Alice', output_path: out });

    expect(result.success).toBe(true);
    const hpf = await readZipFile(out, 'Contents/content.hpf');
    expect(hpf).toContain('>Alice</opf:meta>');
    // Both creator and lastsaveby should be updated
    const creatorMatch = hpf.match(/<opf:meta\s+name="creator"[^>]*>([^<]*)<\/opf:meta>/);
    expect(creatorMatch?.[1]).toBe('Alice');
    const lastSaveMatch = hpf.match(/<opf:meta\s+name="lastsaveby"[^>]*>([^<]*)<\/opf:meta>/);
    expect(lastSaveMatch?.[1]).toBe('Alice');
  });

  it('should update subject and keywords', async () => {
    const src = await createSampleHwpx('meta-subj.hwpx', 'Hello');
    const out = tmpPath('meta-subj-out.hwpx');
    const result = await hwpxSetMetadata({
      path: src,
      subject: 'My Subject',
      keywords: 'foo, bar',
      output_path: out,
    });

    expect(result.success).toBe(true);
    const hpf = await readZipFile(out, 'Contents/content.hpf');
    expect(hpf).toContain('My Subject');
    expect(hpf).toContain('foo, bar');
  });

  it('should escape XML special characters in metadata', async () => {
    const src = await createSampleHwpx('meta-escape.hwpx', 'Hello');
    const out = tmpPath('meta-escape-out.hwpx');
    const result = await hwpxSetMetadata({
      path: src,
      title: 'Tom & Jerry <"special">',
      output_path: out,
    });

    expect(result.success).toBe(true);
    const hpf = await readZipFile(out, 'Contents/content.hpf');
    expect(hpf).toContain('Tom &amp; Jerry &lt;&quot;special&quot;&gt;');
  });

  it('should update ModifiedDate automatically', async () => {
    const src = await createSampleHwpx('meta-date.hwpx', 'Hello');
    const out = tmpPath('meta-date-out.hwpx');
    await hwpxSetMetadata({ path: src, title: 'Test', output_path: out });

    const hpf = await readZipFile(out, 'Contents/content.hpf');
    // ModifiedDate should have a recent value (not the original creation date)
    const modMatch = hpf.match(/<opf:meta\s+name="ModifiedDate"[^>]*>([^<]*)<\/opf:meta>/);
    expect(modMatch).not.toBeNull();
    expect(modMatch![1].length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════
// 2. hwpx_find_replace
// ════════════════════════════════════════════════════════

describe('hwpxFindReplace', () => {
  it('should replace text and report count', async () => {
    const src = await createSampleHwpx('fr-basic.hwpx', 'Hello world and hello again');
    const out = tmpPath('fr-basic-out.hwpx');
    const result = await hwpxFindReplace({
      path: src,
      find: 'hello',
      replace: 'hi',
      output_path: out,
      case_sensitive: false,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('2 occurrence');
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).not.toContain('>Hello');
    expect(section).toContain('hi');
  });

  it('should be case-sensitive by default', async () => {
    const src = await createSampleHwpx('fr-case.hwpx', 'Hello world hello');
    const out = tmpPath('fr-case-out.hwpx');
    const result = await hwpxFindReplace({
      path: src,
      find: 'Hello',
      replace: 'Hi',
      output_path: out,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 occurrence');
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('Hi world hello');
  });

  it('should handle XML-escaped content transparently', async () => {
    const src = await createSampleHwpx('fr-xml.hwpx', 'Tom & Jerry');
    const out = tmpPath('fr-xml-out.hwpx');
    const result = await hwpxFindReplace({
      path: src,
      find: 'Tom & Jerry',
      replace: 'Cat & Mouse',
      output_path: out,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 occurrence');
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('Cat &amp; Mouse');
    expect(section).not.toContain('Tom &amp; Jerry');
  });

  it('should report 0 occurrences when no match found', async () => {
    const src = await createSampleHwpx('fr-nomatch.hwpx', 'Hello world');
    const out = tmpPath('fr-nomatch-out.hwpx');
    const result = await hwpxFindReplace({
      path: src,
      find: 'xyz_not_found',
      replace: 'abc',
      output_path: out,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('0 occurrence');
  });
});

// ════════════════════════════════════════════════════════
// 3. hwpx_insert_text
// ════════════════════════════════════════════════════════

describe('hwpxInsertText', () => {
  it('should insert a single paragraph', async () => {
    const src = await createSampleHwpx('ins-single.hwpx', 'Existing');
    const out = tmpPath('ins-single-out.hwpx');
    const result = await hwpxInsertText({
      path: src,
      text: 'Appended line',
      output_path: out,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 paragraph');
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('Appended line');
  });

  it('should insert multiple paragraphs from newline-separated text', async () => {
    const src = await createSampleHwpx('ins-multi.hwpx', 'Existing');
    const out = tmpPath('ins-multi-out.hwpx');
    const result = await hwpxInsertText({
      path: src,
      text: 'Line one\nLine two\nLine three',
      output_path: out,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('3 paragraph');
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('Line one');
    expect(section).toContain('Line two');
    expect(section).toContain('Line three');
  });

  it('should assign unique IDs to inserted paragraphs', async () => {
    const src = await createSampleHwpx('ins-ids.hwpx', 'Existing');
    const out = tmpPath('ins-ids-out.hwpx');
    await hwpxInsertText({
      path: src,
      text: 'New A\nNew B',
      output_path: out,
    });

    const section = await readZipFile(out, 'Contents/section0.xml');
    const allIds = [...section.matchAll(/<hp:p\s+id="(\d+)"/g)].map(m => m[1]);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  it('should insert before the trailing empty paragraph', async () => {
    const src = await createSampleHwpx('ins-pos.hwpx', 'Existing content');
    const out = tmpPath('ins-pos-out.hwpx');
    await hwpxInsertText({
      path: src,
      text: 'Inserted',
      output_path: out,
    });

    const section = await readZipFile(out, 'Contents/section0.xml');
    const insertedPos = section.indexOf('Inserted');
    // The trailing empty paragraph should come after
    const emptyPRe = /<hp:p[^>]*>\s*\n?\s*<hp:run\s+charPrIDRef="0"><hp:t><\/hp:t><\/hp:run>/g;
    let lastEmptyPos = -1;
    let m: RegExpExecArray | null;
    while ((m = emptyPRe.exec(section)) !== null) {
      lastEmptyPos = m.index;
    }
    expect(lastEmptyPos).toBeGreaterThan(insertedPos);
  });
});

// ════════════════════════════════════════════════════════
// 4. hwpx_merge_documents
// ════════════════════════════════════════════════════════

describe('hwpxMergeDocuments', () => {
  it('should merge two documents', async () => {
    const src1 = await createSampleHwpx('merge-a.hwpx', 'Document A content');
    const src2 = await createSampleHwpx('merge-b.hwpx', 'Document B content');
    const out = tmpPath('merged.hwpx');

    const result = await hwpxMergeDocuments({
      input_paths: [src1, src2],
      output_path: out,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('2 document');

    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('Document A content');
    expect(section).toContain('Document B content');
  });

  it('should preserve content order', async () => {
    const src1 = await createSampleHwpx('order-a.hwpx', 'FIRST');
    const src2 = await createSampleHwpx('order-b.hwpx', 'SECOND');
    const out = tmpPath('order-merged.hwpx');

    await hwpxMergeDocuments({
      input_paths: [src1, src2],
      output_path: out,
    });

    const section = await readZipFile(out, 'Contents/section0.xml');
    const posFirst = section.indexOf('FIRST');
    const posSecond = section.indexOf('SECOND');
    expect(posFirst).toBeLessThan(posSecond);
  });

  it('should have unique IDs across merged content', async () => {
    const src1 = await createSampleHwpx('uid-a.hwpx', '# Heading\n\nParagraph one');
    const src2 = await createSampleHwpx('uid-b.hwpx', '# Another\n\nParagraph two');
    const out = tmpPath('uid-merged.hwpx');

    await hwpxMergeDocuments({
      input_paths: [src1, src2],
      output_path: out,
    });

    const section = await readZipFile(out, 'Contents/section0.xml');
    const allIds = [...section.matchAll(/\bid="(\d+)"/g)].map(m => m[1]);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });

  it('should contain all required HWPX files', async () => {
    const src1 = await createSampleHwpx('req-a.hwpx', 'Hello');
    const src2 = await createSampleHwpx('req-b.hwpx', 'World');
    const out = tmpPath('req-merged.hwpx');

    await hwpxMergeDocuments({
      input_paths: [src1, src2],
      output_path: out,
    });

    const buf = fs.readFileSync(out);
    const zip = await JSZip.loadAsync(buf);

    const requiredFiles = [
      'mimetype',
      'version.xml',
      'META-INF/container.xml',
      'META-INF/manifest.xml',
      'META-INF/container.rdf',
      'settings.xml',
      'Contents/content.hpf',
      'Contents/header.xml',
      'Contents/section0.xml',
      'Preview/PrvText.txt',
    ];

    for (const f of requiredFiles) {
      expect(zip.file(f), `Missing file: ${f}`).not.toBeNull();
    }

    const mimetype = await zip.file('mimetype')!.async('string');
    expect(mimetype).toBe('application/hwp+zip');
  });
});
