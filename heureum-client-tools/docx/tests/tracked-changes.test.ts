import { describe, it, expect } from 'vitest';
import { acceptChangesInXml } from '../src/tracked-changes.js';

describe('acceptChangesInXml', () => {
  it('should remove w:del elements', () => {
    const xml = '<w:body><w:p><w:del w:id="1"><w:r><w:t>deleted</w:t></w:r></w:del></w:p></w:body>';
    const result = acceptChangesInXml(xml);
    expect(result).not.toContain('deleted');
    expect(result).not.toContain('w:del');
  });

  it('should unwrap w:ins elements', () => {
    const xml = '<w:body><w:p><w:ins w:id="1"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p></w:body>';
    const result = acceptChangesInXml(xml);
    expect(result).toContain('inserted');
    expect(result).not.toContain('w:ins');
  });

  it('should remove rPrChange', () => {
    const xml = '<w:rPr><w:b/><w:rPrChange w:id="1"><w:rPr><w:i/></w:rPr></w:rPrChange></w:rPr>';
    const result = acceptChangesInXml(xml);
    expect(result).toContain('<w:b/>');
    expect(result).not.toContain('rPrChange');
  });

  it('should remove pPrChange', () => {
    const xml = '<w:pPr><w:jc w:val="center"/><w:pPrChange w:id="1"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange></w:pPr>';
    const result = acceptChangesInXml(xml);
    expect(result).toContain('center');
    expect(result).not.toContain('pPrChange');
  });

  it('should handle combined insertions and deletions', () => {
    const xml = `<w:body>
  <w:p>
    <w:r><w:t>keep</w:t></w:r>
    <w:del w:id="1"><w:r><w:t>remove</w:t></w:r></w:del>
    <w:ins w:id="2"><w:r><w:t>add</w:t></w:r></w:ins>
  </w:p>
</w:body>`;
    const result = acceptChangesInXml(xml);
    expect(result).toContain('keep');
    expect(result).toContain('add');
    expect(result).not.toContain('remove');
    expect(result).not.toContain('w:del');
    expect(result).not.toContain('w:ins');
  });
});
