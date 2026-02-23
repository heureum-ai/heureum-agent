import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { createHwpx } from '../src/writer.js';

async function unzip(data: Uint8Array) {
  return JSZip.loadAsync(data);
}

describe('createHwpx', () => {
  it('should produce a valid ZIP from empty markdown', async () => {
    const result = await createHwpx('');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);

    const zip = await unzip(result);
    const mimetype = await zip.file('mimetype')?.async('string');
    expect(mimetype).toBe('application/hwp+zip');
  });

  it('should contain all required HWPX files', async () => {
    const result = await createHwpx('Hello');
    const zip = await unzip(result);

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
  });

  it('should store mimetype without compression', async () => {
    const result = await createHwpx('');
    const zip = await unzip(result);
    const mimetypeEntry = zip.file('mimetype');
    expect(mimetypeEntry).not.toBeNull();
    // JSZip stores compression info internally; verify content is correct
    const content = await mimetypeEntry!.async('string');
    expect(content).toBe('application/hwp+zip');
  });

  it('should generate p/run/t for heading and paragraph', async () => {
    const md = '# Title\n\nParagraph text here';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    // heading with charPrIDRef="4" (H1)
    expect(section).toContain('charPrIDRef="4"');
    expect(section).toContain('<hp:t>Title</hp:t>');

    // paragraph with charPrIDRef="0" (body)
    expect(section).toContain('charPrIDRef="0"');
    expect(section).toContain('<hp:t>Paragraph text here</hp:t>');

    // Basic structure
    expect(section).toContain('<hp:p');
    expect(section).toContain('<hp:run');
    expect(section).toContain('<hp:t>');
  });

  it('should use different charPrIDRef for bold and italic', async () => {
    const md = '**bold text** *italic text*';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    // bold = charPrIDRef="1", italic = charPrIDRef="2"
    expect(section).toContain('charPrIDRef="1"');
    expect(section).toContain('<hp:t>bold text</hp:t>');
    expect(section).toContain('charPrIDRef="2"');
    expect(section).toContain('<hp:t>italic text</hp:t>');
  });

  it('should handle bold+italic combination', async () => {
    const md = '***bold and italic***';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    // bold+italic = charPrIDRef="3"
    expect(section).toContain('charPrIDRef="3"');
    expect(section).toContain('<hp:t>bold and italic</hp:t>');
  });

  it('should handle bullet lists with bullet prefix', async () => {
    const md = '- item one\n- item two\n- item three';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    expect(section).toContain('• item one');
    expect(section).toContain('• item two');
    expect(section).toContain('• item three');
  });

  it('should handle numbered lists with number prefix', async () => {
    const md = '1. first\n2. second\n3. third';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    expect(section).toContain('1. first');
    expect(section).toContain('2. second');
    expect(section).toContain('3. third');
  });

  it('should generate tbl/tr/tc structure for tables', async () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    expect(section).toContain('<hp:tbl');
    expect(section).toContain('<hp:tr>');
    expect(section).toContain('<hp:tc');
    expect(section).toContain('<hp:subList');
    expect(section).toContain('Name');
    expect(section).toContain('Alice');
    expect(section).toContain('30');
  });

  it('should use charPrIDRef=10 for code blocks', async () => {
    const md = '```\nconst x = 1;\nconst y = 2;\n```';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    expect(section).toContain('charPrIDRef="10"');
    expect(section).toContain('const x = 1;');
    expect(section).toContain('const y = 2;');
  });

  it('should use charPrIDRef=11 for blockquotes', async () => {
    const md = '> This is a quote';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    expect(section).toContain('charPrIDRef="11"');
    expect(section).toContain('▎ This is a quote');
  });

  it('should skip yaml frontmatter', async () => {
    const md = '---\ntitle: Test\nauthor: Me\n---\n\n# Hello\n\nWorld';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    // Frontmatter should not appear in content
    expect(section).not.toContain('title: Test');
    expect(section).not.toContain('author: Me');

    // But the content should be there
    expect(section).toContain('Hello');
    expect(section).toContain('World');
  });

  it('should handle heading levels H1 through H6', async () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    // H1=4, H2=5, H3=6, H4=7, H5=8, H6=9
    expect(section).toContain('charPrIDRef="4"');
    expect(section).toContain('charPrIDRef="5"');
    expect(section).toContain('charPrIDRef="6"');
    expect(section).toContain('charPrIDRef="7"');
    expect(section).toContain('charPrIDRef="8"');
    expect(section).toContain('charPrIDRef="9"');
  });

  it('should generate valid header.xml with fontfaces and charProperties', async () => {
    const result = await createHwpx('Hello');
    const zip = await unzip(result);
    const header = await zip.file('Contents/header.xml')!.async('string');

    expect(header).toContain('<hh:head');
    expect(header).toContain('<hh:fontfaces');
    expect(header).toContain('<hh:charProperties');
    expect(header).toContain('<hh:paraProperties');
    expect(header).toContain('<hh:borderFills');
    expect(header).toContain('<hh:styles');
    expect(header).toContain('함초롬돋움');
  });

  it('should generate valid content.hpf with section references', async () => {
    const result = await createHwpx('# My Title\n\nContent');
    const zip = await unzip(result);
    const hpf = await zip.file('Contents/content.hpf')!.async('string');

    expect(hpf).toContain('<opf:package');
    expect(hpf).toContain('<opf:title>My Title</opf:title>');
    expect(hpf).toContain('href="Contents/section0.xml"');
    expect(hpf).toContain('href="Contents/header.xml"');
  });

  it('should escape XML special characters', async () => {
    const md = 'Use <div> & "quotes" in text';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    expect(section).toContain('&amp;');
    expect(section).toContain('&quot;');
  });

  it('should handle mixed inline formatting in one paragraph', async () => {
    const md = 'Hello **world** and *universe*';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    // Should have multiple <hp:run> in a single <hp:p>
    expect(section).toContain('<hp:t>Hello </hp:t>');
    expect(section).toContain('<hp:t>world</hp:t>');
    expect(section).toContain('<hp:t>universe</hp:t>');
  });

  it('should handle thematic breaks', async () => {
    const md = 'Before\n\n---\n\nAfter';
    const result = await createHwpx(md);
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    expect(section).toContain('────────');
  });

  it('should generate section with secPr as first element', async () => {
    const result = await createHwpx('Test');
    const zip = await unzip(result);
    const section = await zip.file('Contents/section0.xml')!.async('string');

    expect(section).toContain('<hp:secPr');
    expect(section).toContain('width="59528"');
    expect(section).toContain('height="84186"');
    // secPr should appear before content paragraphs
    const secPrIdx = section.indexOf('<hp:secPr');
    const firstContentRun = section.indexOf('<hp:t>Test</hp:t>');
    expect(secPrIdx).toBeLessThan(firstContentRun);
  });
});
