import { describe, it, expect } from 'vitest';
import { parseDocumentXml, parseCoreXml } from '../src/reader.js';

describe('parseDocumentXml', () => {
  it('should parse headings', () => {
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Title</w:t></w:r></w:p>
  <w:p><w:r><w:t>Body text</w:t></w:r></w:p>
  <w:p><w:pPr><w:sectPr/></w:pPr></w:p>
</w:body>
</w:document>`;

    const nodes = parseDocumentXml(xml);
    expect(nodes[0].type).toBe('heading');
    expect(nodes[0].depth).toBe(1);
    expect(nodes[1].type).toBe('paragraph');
  });

  it('should parse bold and italic', () => {
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r></w:p>
</w:body>
</w:document>`;

    const nodes = parseDocumentXml(xml);
    expect(nodes[0].type).toBe('paragraph');
    const children = nodes[0].children;
    expect(children[0].type).toBe('strong');
    expect(children[1].type).toBe('emphasis');
  });

  it('should parse lists', () => {
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Bullet</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Ordered</w:t></w:r></w:p>
</w:body>
</w:document>`;

    const nodes = parseDocumentXml(xml);
    expect(nodes[0].type).toBe('list');
    expect(nodes[0].ordered).toBe(false);
    expect(nodes[1].type).toBe('list');
    expect(nodes[1].ordered).toBe(true);
  });

  it('should parse tables', () => {
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
</w:body>
</w:document>`;

    const nodes = parseDocumentXml(xml);
    expect(nodes[0].type).toBe('table');
    expect(nodes[0].children).toHaveLength(2);
    const firstCell = nodes[0].children[0].children[0];
    expect(firstCell.type).toBe('tableCell');
    expect(firstCell.children[0].value).toBe('A');
  });

  it('should parse code blocks', () => {
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t>line1</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:t>line2</w:t></w:r></w:p>
</w:body>
</w:document>`;

    const nodes = parseDocumentXml(xml);
    expect(nodes[0].type).toBe('code');
    expect(nodes[0].value).toBe('line1\nline2');
  });

  it('should parse blockquotes', () => {
    const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Quoted text</w:t></w:r></w:p>
</w:body>
</w:document>`;

    const nodes = parseDocumentXml(xml);
    expect(nodes[0].type).toBe('blockquote');
    expect(nodes[0].children[0].children[0].value).toBe('Quoted text');
  });
});

describe('parseCoreXml', () => {
  it('should extract metadata', () => {
    const xml = `<?xml version="1.0"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>My Title</dc:title>
  <dc:creator>Author</dc:creator>
  <cp:lastModifiedBy>Editor</cp:lastModifiedBy>
</cp:coreProperties>`;

    const meta = parseCoreXml(xml);
    expect(meta.title).toBe('My Title');
    expect(meta.creator).toBe('Author');
    expect(meta.lastModifiedBy).toBe('Editor');
  });
});
