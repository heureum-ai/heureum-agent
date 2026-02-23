import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { createDocx } from '../src/writer.js';

describe('createDocx', () => {
  it('should produce a valid ZIP with required OOXML files', async () => {
    const markdown = '# Hello\n\nThis is a test.';
    const buffer = await createDocx(markdown);
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(buffer);
    const files = Object.keys(zip.files);

    // Required OOXML files
    expect(files).toContain('[Content_Types].xml');
    expect(files).toContain('_rels/.rels');
    expect(files).toContain('word/document.xml');
    expect(files).toContain('word/styles.xml');
    expect(files).toContain('word/settings.xml');
    expect(files).toContain('word/numbering.xml');
    expect(files).toContain('word/fontTable.xml');
    expect(files).toContain('word/_rels/document.xml.rels');
    expect(files).toContain('docProps/core.xml');
    expect(files).toContain('docProps/app.xml');
  });

  it('should include heading content in document.xml', async () => {
    const markdown = '# My Title\n\nSome body text.';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('My Title');
    expect(docXml).toContain('Some body text');
    expect(docXml).toContain('Heading1');
  });

  it('should render bold and italic text', async () => {
    const markdown = 'This is **bold** and *italic*.';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:b/>');
    expect(docXml).toContain('<w:i/>');
    expect(docXml).toContain('bold');
    expect(docXml).toContain('italic');
  });

  it('should render bullet lists', async () => {
    const markdown = '- Item one\n- Item two\n- Item three';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:numId w:val="1"/>'); // Bullet numId
    expect(docXml).toContain('Item one');
    expect(docXml).toContain('Item two');
  });

  it('should render ordered lists', async () => {
    const markdown = '1. First\n2. Second\n3. Third';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:numId w:val="2"/>'); // Ordered numId
    expect(docXml).toContain('First');
    expect(docXml).toContain('Second');
  });

  it('should render code blocks', async () => {
    const markdown = '```\nconst x = 1;\n```';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('CodeBlock');
    expect(docXml).toContain('Courier New');
    expect(docXml).toContain('const x = 1;');
  });

  it('should render tables', async () => {
    const markdown = '| A | B |\n|---|---|\n| 1 | 2 |';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:tbl>');
    expect(docXml).toContain('<w:tc>');
    expect(docXml).toContain('>A<');
    expect(docXml).toContain('>1<');
  });

  it('should render blockquotes', async () => {
    const markdown = '> This is a quote.';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('Quote');
    expect(docXml).toContain('This is a quote.');
  });

  it('should set correct page size in sectPr', async () => {
    const markdown = '# Test';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:sectPr>');
    expect(docXml).toContain('<w:pgSz');
    expect(docXml).toContain('<w:pgMar');
  });

  it('should extract title into core.xml', async () => {
    const markdown = '# My Document Title\n\nContent.';
    const buffer = await createDocx(markdown);
    const zip = await JSZip.loadAsync(buffer);
    const coreXml = await zip.file('docProps/core.xml')!.async('string');

    expect(coreXml).toContain('My Document Title');
  });

  it('should handle empty markdown', async () => {
    const buffer = await createDocx('');
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(buffer.length).toBeGreaterThan(0);
  });
});
