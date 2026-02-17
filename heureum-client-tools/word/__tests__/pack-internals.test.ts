/**
 * Function-level unit tests for pack.ts internal functions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { _internal } from "../src/pack";

const { condenseXml } = _internal;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── condenseXml ──────────────────────────────────────────────────────

describe("condenseXml", () => {
  it("removes whitespace-only text nodes", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    const prettyXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document>
  <w:body>
    <w:p>
      <w:r>
        <w:t>Hello</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`;
    fs.writeFileSync(xmlPath, prettyXml, "utf-8");

    condenseXml(xmlPath);

    const result = fs.readFileSync(xmlPath, "utf-8");
    // Should not have newlines between elements (condensed)
    expect(result).not.toMatch(/>\s+</);
    expect(result).toContain("Hello");
  });

  it("preserves text content inside :t elements", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    fs.writeFileSync(
      xmlPath,
      '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t xml:space="preserve"> Hello World </w:t></w:r></w:p></w:body></w:document>',
      "utf-8"
    );

    condenseXml(xmlPath);

    const result = fs.readFileSync(xmlPath, "utf-8");
    expect(result).toContain(" Hello World ");
  });

  it("preserves text content in w:t", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    fs.writeFileSync(
      xmlPath,
      '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>text with  multiple   spaces</w:t></w:r></w:p></w:body></w:document>',
      "utf-8"
    );

    condenseXml(xmlPath);

    const result = fs.readFileSync(xmlPath, "utf-8");
    expect(result).toContain("text with  multiple   spaces");
  });

  it("removes XML comments", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    fs.writeFileSync(
      xmlPath,
      '<?xml version="1.0"?><root><!-- a comment --><child/></root>',
      "utf-8"
    );

    condenseXml(xmlPath);

    const result = fs.readFileSync(xmlPath, "utf-8");
    expect(result).not.toContain("comment");
    expect(result).toContain("<child");
  });

  it("produces valid XML output", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    fs.writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t>test</w:t>
      </w:r>
    </w:p>
  </w:body>
</w:document>`,
      "utf-8"
    );

    condenseXml(xmlPath);

    const result = fs.readFileSync(xmlPath, "utf-8");
    expect(result).toMatch(/^<\?xml/);
    expect(result).toContain("w:document");
    expect(result).toContain("test");
  });

  it("handles already-condensed XML", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    const condensed = '<?xml version="1.0" encoding="UTF-8"?><root><child/></root>';
    fs.writeFileSync(xmlPath, condensed, "utf-8");

    condenseXml(xmlPath);

    const result = fs.readFileSync(xmlPath, "utf-8");
    expect(result).toContain("<root>");
    expect(result).toContain("<child");
  });

  it("produces single ?xml declaration", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    fs.writeFileSync(
      xmlPath,
      '<?xml version="1.0" encoding="UTF-8"?><root><child/></root>',
      "utf-8"
    );

    condenseXml(xmlPath);

    const result = fs.readFileSync(xmlPath, "utf-8");
    expect((result.match(/<\?xml/g) || []).length).toBe(1);
  });

  it("handles .rels files", () => {
    const xmlPath = path.join(tmpDir, "test.rels");
    fs.writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://example.com" Target="a.xml"/>
</Relationships>`,
      "utf-8"
    );

    condenseXml(xmlPath);

    const result = fs.readFileSync(xmlPath, "utf-8");
    expect(result).toContain("Relationships");
    expect(result).toContain("rId1");
    // Should be condensed
    expect(result).not.toMatch(/>\n\s+</);
  });
});
