import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { createDocument } from '../src/create-document.js';

describe('createDocument', () => {
  it('should create a DOCX with paragraphs', async () => {
    const buffer = await createDocument({
      output_path: '/tmp/test.docx',
      content: [
        { paragraph: { text: 'Hello World', heading: 1 } },
        { paragraph: { text: 'Body text', bold: true } },
      ],
    });

    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('Hello World');
    expect(docXml).toContain('Body text');
    expect(docXml).toContain('Heading1');
    expect(docXml).toContain('<w:b/>');
  });

  it('should create a DOCX with runs', async () => {
    const buffer = await createDocument({
      output_path: '/tmp/test.docx',
      content: [
        {
          paragraph: {
            runs: [
              { text: 'Normal ' },
              { text: 'Bold', bold: true },
              { text: ' and ', },
              { text: 'Italic', italic: true },
            ],
          },
        },
      ],
    });

    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('Normal ');
    expect(docXml).toContain('Bold');
    expect(docXml).toContain('Italic');
    expect(docXml).toContain('<w:b/>');
    expect(docXml).toContain('<w:i/>');
  });

  it('should create a DOCX with tables', async () => {
    const buffer = await createDocument({
      output_path: '/tmp/test.docx',
      content: [
        {
          table: {
            rows: [
              ['Name', 'Value'],
              ['A', '1'],
              ['B', '2'],
            ],
            headerRow: true,
          },
        },
      ],
    });

    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:tbl>');
    expect(docXml).toContain('Name');
    expect(docXml).toContain('<w:tblHeader/>');
  });

  it('should create a DOCX with bullet lists', async () => {
    const buffer = await createDocument({
      output_path: '/tmp/test.docx',
      content: [
        { paragraph: { text: 'Item 1', bullet: true } },
        { paragraph: { text: 'Item 2', bullet: true } },
      ],
    });

    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:numId w:val="1"/>');
    expect(docXml).toContain('Item 1');
  });

  it('should create a DOCX with page breaks', async () => {
    const buffer = await createDocument({
      output_path: '/tmp/test.docx',
      content: [
        { paragraph: { text: 'Page 1' } },
        { pageBreak: true },
        { paragraph: { text: 'Page 2' } },
      ],
    });

    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('w:type="page"');
    expect(docXml).toContain('Page 1');
    expect(docXml).toContain('Page 2');
  });

  it('should set custom page size', async () => {
    const buffer = await createDocument({
      output_path: '/tmp/test.docx',
      content: [{ paragraph: { text: 'test' } }],
      page_size: 'letter',
    });

    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    // Letter width ≈ 12240 twips (8.5 inches * 1440)
    expect(docXml).toContain('w:w="12240"');
  });

  it('should add header and footer', async () => {
    const buffer = await createDocument({
      output_path: '/tmp/test.docx',
      content: [{ paragraph: { text: 'test' } }],
      header: 'My Header',
      footer: 'My Footer',
    });

    const zip = await JSZip.loadAsync(buffer);
    const files = Object.keys(zip.files);

    expect(files).toContain('word/header1.xml');
    expect(files).toContain('word/footer1.xml');

    const headerXml = await zip.file('word/header1.xml')!.async('string');
    expect(headerXml).toContain('My Header');

    const footerXml = await zip.file('word/footer1.xml')!.async('string');
    expect(footerXml).toContain('My Footer');

    // Check document.xml has references
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('w:headerReference');
    expect(docXml).toContain('w:footerReference');
  });

  it('should set alignment', async () => {
    const buffer = await createDocument({
      output_path: '/tmp/test.docx',
      content: [
        { paragraph: { text: 'Centered', alignment: 'CENTER' } },
      ],
    });

    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:jc w:val="center"/>');
  });
});
