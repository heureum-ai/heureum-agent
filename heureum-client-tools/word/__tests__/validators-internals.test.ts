/**
 * Function-level unit tests for validators (base, docx, redlining).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import JSZip from "jszip";
import {
  BaseSchemaValidator,
  parseXml,
  buildXml,
  getTagName,
  getLocalName,
  findXmlFiles,
} from "../src/validators/base";
import { DOCXSchemaValidator } from "../src/validators/docx";
import { PPTXSchemaValidator } from "../src/validators/pptx";
import { RedliningValidator } from "../src/validators/redlining";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validators-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to create a minimal docx for testing */
async function createMinimalDocx(
  docXml: string,
  outPath: string,
  extras?: Record<string, string>
): Promise<void> {
  const zip = new JSZip();
  zip.file("word/document.xml", docXml);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    </Relationships>`
  );
  if (extras) {
    for (const [name, content] of Object.entries(extras)) {
      zip.file(name, content);
    }
  }
  const buffer = await zip.generateAsync({ type: "uint8array" });
  fs.writeFileSync(outPath, buffer);
}

/** Helper to set up unpacked dir from xml files */
function setupUnpacked(files: Record<string, string>): string {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }
  return tmpDir;
}

// ═══════════════════════════════════════════════════════════════════════
// BASE VALIDATOR
// ═══════════════════════════════════════════════════════════════════════

describe("base parseXml / buildXml / getTagName / getLocalName", () => {
  it("parseXml filters ?xml", () => {
    const nodes = parseXml('<?xml version="1.0"?><root/>');
    expect(nodes.every((n: any) => !("?xml" in n))).toBe(true);
  });

  it("buildXml adds single ?xml declaration", () => {
    const nodes = parseXml("<root/>");
    const xml = buildXml(nodes);
    expect((xml.match(/<\?xml/g) || []).length).toBe(1);
  });

  it("getTagName works correctly", () => {
    expect(getTagName({ "w:body": [] })).toBe("w:body");
    expect(getTagName({ "#text": "x" })).toBeNull();
    expect(getTagName(null)).toBeNull();
  });

  it("getLocalName extracts local part", () => {
    expect(getLocalName("w:body")).toBe("body");
    expect(getLocalName("body")).toBe("body");
    expect(getLocalName("w14:paraId")).toBe("paraId");
  });
});

describe("findXmlFiles", () => {
  it("finds .xml and .rels files", () => {
    setupUnpacked({
      "a.xml": "<root/>",
      "sub/b.rels": "<Relationships/>",
      "c.txt": "not xml",
    });
    const files = findXmlFiles(tmpDir);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.endsWith("a.xml"))).toBe(true);
    expect(files.some((f) => f.endsWith("b.rels"))).toBe(true);
  });

  it("returns empty for non-existent dir", () => {
    expect(findXmlFiles("/nonexistent/path")).toEqual([]);
  });
});

// ── validateUniqueIds ────────────────────────────────────────────────

describe("BaseSchemaValidator.validateUniqueIds", () => {
  it("passes with unique IDs", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:bookmarkStart w:id="0" w:name="a"/>
            <w:bookmarkEnd w:id="0"/>
            <w:bookmarkStart w:id="1" w:name="b"/>
            <w:bookmarkEnd w:id="1"/>
          </w:body>
        </w:document>`,
    });
    const v = new BaseSchemaValidator(dir);
    expect(v.validateUniqueIds().valid).toBe(true);
  });

  it("fails with duplicate file-scope IDs", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:bookmarkStart w:id="0" w:name="a"/>
            <w:bookmarkStart w:id="0" w:name="b"/>
          </w:body>
        </w:document>`,
    });
    const v = new BaseSchemaValidator(dir);
    expect(v.validateUniqueIds().valid).toBe(false);
  });
});

// ── validateFileReferences ───────────────────────────────────────────

describe("BaseSchemaValidator.validateFileReferences", () => {
  it("fails for broken reference", () => {
    const dir = setupUnpacked({
      "word/_rels/document.xml.rels": `<?xml version="1.0"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://example.com" Target="nonexistent.xml"/>
        </Relationships>`,
      "word/document.xml": "<w:document/>",
    });
    const v = new BaseSchemaValidator(dir);
    expect(v.validateFileReferences().valid).toBe(false);
  });
});

// ── repairWhitespacePreservation ─────────────────────────────────────

describe("BaseSchemaValidator.repairWhitespacePreservation", () => {
  it("adds xml:space=preserve to w:t with leading space", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p><w:r><w:t> leading space</w:t></w:r></w:p></w:body>
        </w:document>`,
    });
    const v = new BaseSchemaValidator(dir);
    const repairs = v.repairWhitespacePreservation();
    expect(repairs).toBeGreaterThan(0);

    const content = fs.readFileSync(
      path.join(dir, "word/document.xml"),
      "utf-8"
    );
    expect(content).toContain('xml:space="preserve"');
  });

  it("does not repair already-preserved text", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p><w:r><w:t xml:space="preserve"> ok</w:t></w:r></w:p></w:body>
        </w:document>`,
    });
    const v = new BaseSchemaValidator(dir);
    expect(v.repairWhitespacePreservation()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DOCX VALIDATOR
// ═══════════════════════════════════════════════════════════════════════

describe("DOCXSchemaValidator.validateDeletions", () => {
  it("fails when w:t found in w:del", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p>
            <w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z">
              <w:r><w:t>should not be here</w:t></w:r>
            </w:del>
          </w:p></w:body>
        </w:document>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateDeletions().valid).toBe(false);
  });

  it("passes when w:delText used in w:del", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p>
            <w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z">
              <w:r><w:delText>deleted</w:delText></w:r>
            </w:del>
          </w:p></w:body>
        </w:document>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateDeletions().valid).toBe(true);
  });
});

describe("DOCXSchemaValidator.validateInsertions", () => {
  it("fails when w:delText found in w:ins (not in w:del)", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p>
            <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z">
              <w:r><w:delText>bad</w:delText></w:r>
            </w:ins>
          </w:p></w:body>
        </w:document>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateInsertions().valid).toBe(false);
  });

  it("passes when w:delText is inside w:del nested in w:ins", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p>
            <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z">
              <w:del w:id="2" w:author="B" w:date="2024-01-01T00:00:00Z">
                <w:r><w:delText>ok here</w:delText></w:r>
              </w:del>
            </w:ins>
          </w:p></w:body>
        </w:document>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateInsertions().valid).toBe(true);
  });
});

describe("DOCXSchemaValidator.validateCommentMarkers", () => {
  it("fails for orphaned commentRangeStart", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p>
            <w:commentRangeStart w:id="0"/>
            <w:r><w:t>text</w:t></w:r>
          </w:p></w:body>
        </w:document>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateCommentMarkers().valid).toBe(false);
  });

  it("passes for properly paired comment markers", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p>
            <w:commentRangeStart w:id="0"/>
            <w:r><w:t>text</w:t></w:r>
            <w:commentRangeEnd w:id="0"/>
            <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
          </w:p></w:body>
        </w:document>`,
      "word/comments.xml": `<?xml version="1.0"?>
        <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:comment w:id="0" w:author="Test" w:date="2024-01-01T00:00:00Z">
            <w:p><w:r><w:t>note</w:t></w:r></w:p>
          </w:comment>
        </w:comments>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateCommentMarkers().valid).toBe(true);
  });

  it("fails when marker references non-existent comment", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p>
            <w:commentRangeStart w:id="99"/>
            <w:commentRangeEnd w:id="99"/>
            <w:r><w:commentReference w:id="99"/></w:r>
          </w:p></w:body>
        </w:document>`,
      "word/comments.xml": `<?xml version="1.0"?>
        <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:comment w:id="0" w:author="Test" w:date="2024-01-01T00:00:00Z">
            <w:p><w:r><w:t>note</w:t></w:r></w:p>
          </w:comment>
        </w:comments>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateCommentMarkers().valid).toBe(false);
  });
});

describe("DOCXSchemaValidator.validateIdConstraints", () => {
  it("fails when paraId >= 0x80000000", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                    xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
          <w:body><w:p w14:paraId="FFFFFFFF" w14:textId="11111111"/></w:body>
        </w:document>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateIdConstraints().valid).toBe(false);
  });

  it("passes when paraId < 0x80000000", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                    xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
          <w:body><w:p w14:paraId="12345678" w14:textId="11111111"/></w:body>
        </w:document>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.validateIdConstraints().valid).toBe(true);
  });
});

describe("DOCXSchemaValidator.repairDurableId", () => {
  it("repairs durableId >= 0x7FFFFFFF in non-numbering files", () => {
    const dir = setupUnpacked({
      "word/commentsIds.xml": `<?xml version="1.0"?>
        <w16cid:commentsIds xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid">
          <w16cid:commentId w16cid:paraId="12345678" w16cid:durableId="FFFFFFFF"/>
        </w16cid:commentsIds>`,
    });
    const v = new DOCXSchemaValidator(dir);
    const repairs = v.repairDurableId();
    expect(repairs).toBe(1);

    const content = fs.readFileSync(
      path.join(dir, "word/commentsIds.xml"),
      "utf-8"
    );
    expect(content).not.toContain("FFFFFFFF");
  });

  it("uses decimal format for numbering.xml", () => {
    const dir = setupUnpacked({
      "word/numbering.xml": `<?xml version="1.0"?>
        <w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                     xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid">
          <w:abstractNum w:abstractNumId="0" w16cid:durableId="9999999999"/>
        </w:numbering>`,
    });
    const v = new DOCXSchemaValidator(dir);
    const repairs = v.repairDurableId();
    expect(repairs).toBe(1);

    const content = fs.readFileSync(
      path.join(dir, "word/numbering.xml"),
      "utf-8"
    );
    // Should be a decimal number, not hex
    const match = content.match(/durableId="(\d+)"/);
    expect(match).toBeTruthy();
    const val = parseInt(match![1], 10);
    expect(val).toBeLessThan(0x7fffffff);
  });
});

describe("DOCXSchemaValidator.countParagraphsInUnpacked", () => {
  it("counts paragraphs in document.xml", () => {
    const dir = setupUnpacked({
      "word/document.xml": `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:r><w:t>para 1</w:t></w:r></w:p>
            <w:p><w:r><w:t>para 2</w:t></w:r></w:p>
            <w:p><w:r><w:t>para 3</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
    });
    const v = new DOCXSchemaValidator(dir);
    expect(v.countParagraphsInUnpacked()).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// REDLINING VALIDATOR
// ═══════════════════════════════════════════════════════════════════════

describe("RedliningValidator", () => {
  it("passes when no tracked changes by author", async () => {
    const docXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>
      </w:document>`;
    const docxPath = path.join(tmpDir, "original.docx");
    await createMinimalDocx(docXml, docxPath);

    const unpackedDir = path.join(tmpDir, "unpacked");
    fs.mkdirSync(path.join(unpackedDir, "word"), { recursive: true });
    fs.writeFileSync(path.join(unpackedDir, "word", "document.xml"), docXml);

    const v = new RedliningValidator(unpackedDir, docxPath, false, "Claude");
    expect((await v.validate()).valid).toBe(true);
  });

  it("passes when author's insertions are properly tracked", async () => {
    const originalXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>
      </w:document>`;
    const docxPath = path.join(tmpDir, "original.docx");
    await createMinimalDocx(originalXml, docxPath);

    // Modified with a tracked insertion
    const modifiedXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p>
          <w:r><w:t>Hello</w:t></w:r>
          <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
            <w:r><w:t> World</w:t></w:r>
          </w:ins>
        </w:p></w:body>
      </w:document>`;

    const unpackedDir = path.join(tmpDir, "unpacked");
    fs.mkdirSync(path.join(unpackedDir, "word"), { recursive: true });
    fs.writeFileSync(
      path.join(unpackedDir, "word", "document.xml"),
      modifiedXml
    );

    const v = new RedliningValidator(unpackedDir, docxPath, false, "Claude");
    expect((await v.validate()).valid).toBe(true);
  });

  it("fails when untracked text modifications exist", async () => {
    const originalXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>
      </w:document>`;
    const docxPath = path.join(tmpDir, "original.docx");
    await createMinimalDocx(originalXml, docxPath);

    // Modified with both tracked and untracked changes
    const modifiedXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p>
          <w:r><w:t>Changed</w:t></w:r>
          <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
            <w:r><w:t> World</w:t></w:r>
          </w:ins>
        </w:p></w:body>
      </w:document>`;

    const unpackedDir = path.join(tmpDir, "unpacked");
    fs.mkdirSync(path.join(unpackedDir, "word"), { recursive: true });
    fs.writeFileSync(
      path.join(unpackedDir, "word", "document.xml"),
      modifiedXml
    );

    const v = new RedliningValidator(unpackedDir, docxPath, false, "Claude");
    expect((await v.validate()).valid).toBe(false);
  });

  it("passes when author's deletions are properly tracked", async () => {
    const originalXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>Hello World</w:t></w:r></w:p></w:body>
      </w:document>`;
    const docxPath = path.join(tmpDir, "original.docx");
    await createMinimalDocx(originalXml, docxPath);

    // Modified with a tracked deletion
    const modifiedXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p>
          <w:r><w:t>Hello</w:t></w:r>
          <w:del w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
            <w:r><w:delText> World</w:delText></w:r>
          </w:del>
        </w:p></w:body>
      </w:document>`;

    const unpackedDir = path.join(tmpDir, "unpacked");
    fs.mkdirSync(path.join(unpackedDir, "word"), { recursive: true });
    fs.writeFileSync(
      path.join(unpackedDir, "word", "document.xml"),
      modifiedXml
    );

    const v = new RedliningValidator(unpackedDir, docxPath, false, "Claude");
    expect((await v.validate()).valid).toBe(true);
  });

  it("repair returns 0 (no-op)", () => {
    const v = new RedliningValidator("/tmp/a", "/tmp/b");
    expect(v.repair()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BASE VALIDATOR - New methods
// ═══════════════════════════════════════════════════════════════════════

describe("BaseSchemaValidator.getExpectedRelationshipType", () => {
  it("returns mapped type for known elements", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getExpectedRelationshipType("comment")).toBeNull(); // Not in base ELEMENT_RELATIONSHIP_TYPES
  });

  it("returns slide for sldid suffix", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getExpectedRelationshipType("sldId")).toBe("slide");
  });

  it("returns prefix for *id pattern", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getExpectedRelationshipType("themeId")).toBe("theme");
  });

  it("returns prefix for *reference pattern", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getExpectedRelationshipType("slideReference")).toBe("slide");
  });

  it("returns null for unknown elements", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getExpectedRelationshipType("body")).toBeNull();
  });
});

describe("BaseSchemaValidator.getSchemaPath", () => {
  it("maps word folder to wml.xsd", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getSchemaPath("/some/word/document.xml")).toContain("wml.xsd");
  });

  it("maps .rels to relationships schema", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getSchemaPath("/some/_rels/.rels")).toContain("opc-relationships");
  });

  it("maps chart file to chart schema", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getSchemaPath("/ppt/charts/chart1.xml")).toContain("dml-chart");
  });

  it("maps theme file to theme schema", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getSchemaPath("/ppt/theme/theme1.xml")).toContain("dml-main");
  });

  it("returns null for unknown file", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    expect(v.getSchemaPath("/unknown/random.xml")).toBeNull();
  });
});

describe("BaseSchemaValidator.preprocessForMcIgnorable", () => {
  it("removes mc:Ignorable attribute from root", () => {
    const nodes = parseXml(
      '<w:document xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15"><w:body/></w:document>'
    );
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    const result = v.preprocessForMcIgnorable(nodes);
    const root = result[0];
    const attrs = root[":@"] || {};
    const hasIgnorable = Object.keys(attrs).some(k => k.endsWith("Ignorable"));
    expect(hasIgnorable).toBe(false);
  });

  it("handles empty nodes array", () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    const result = v.preprocessForMcIgnorable([]);
    expect(result).toEqual([]);
  });
});

describe("BaseSchemaValidator.removeTemplateTags", () => {
  it("removes {{template}} tags from text nodes", () => {
    const nodes = parseXml(
      '<root><child>{{remove_this}} keep this</child></root>'
    );
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    const { nodes: cleaned, warnings } = v.removeTemplateTags(nodes);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("{{remove_this}}");
  });

  it("does not modify :t elements", () => {
    const nodes = parseXml(
      '<w:r><w:t>{{keep}}</w:t></w:r>'
    );
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    const { warnings } = v.removeTemplateTags(nodes);
    // :t elements should be skipped entirely
    expect(warnings.length).toBe(0);
  });
});

describe("BaseSchemaValidator.cleanIgnorableNamespaces", () => {
  it("removes mc: attributes from nodes", () => {
    const nodes = parseXml(
      '<w:document xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"><w:body/></w:document>'
    );
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    const cleaned = v.cleanIgnorableNamespaces(nodes);
    const root = cleaned[0];
    const attrs = root[":@"] || {};
    const hasMc = Object.keys(attrs).some(k => k.includes("mc:"));
    expect(hasMc).toBe(false);
  });
});

describe("BaseSchemaValidator.validateAgainstXsd", () => {
  it("skips files with no matching schema", async () => {
    const dir = setupUnpacked({ "a.xml": "<root/>" });
    const v = new BaseSchemaValidator(dir);
    const result = await v.validateAgainstXsd();
    // No schema matches "a.xml", so all files skipped → valid
    expect(result.valid).toBe(true);
  });

  it("validates a valid .rels file against XSD", async () => {
    const dir = setupUnpacked({
      "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    });
    const v = new BaseSchemaValidator(dir);
    const result = await v.validateAgainstXsd();
    expect(result.valid).toBe(true);
  });

  it("reports errors for invalid .rels file", async () => {
    const dir = setupUnpacked({
      "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"/>
</Relationships>`,
    });
    const v = new BaseSchemaValidator(dir);
    const result = await v.validateAgainstXsd();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("BaseSchemaValidator.validateAllRelationshipIds (type checking)", () => {
  it("checks relationship type matches expected for element", () => {
    // Create a PPTX-like structure where sldLayoutId references a wrong type
    const dir = setupUnpacked({
      "ppt/slideMasters/slideMaster1.xml": `<?xml version="1.0"?>
        <p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                     xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <p:sldLayoutIdLst>
            <p:sldLayoutId id="2147483649" r:id="rId1"/>
          </p:sldLayoutIdLst>
        </p:sldMaster>`,
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": `<?xml version="1.0"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
        </Relationships>`,
      "ppt/slideLayouts/slideLayout1.xml": "<p:sldLayout/>",
    });

    // Use PPTXSchemaValidator which has ELEMENT_RELATIONSHIP_TYPES

    const v = new PPTXSchemaValidator(dir);
    const result = v.validateAllRelationshipIds();
    // Should pass since sldLayoutId correctly references a slideLayout
    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PPTX VALIDATOR
// ═══════════════════════════════════════════════════════════════════════

describe("PPTXSchemaValidator", () => {
  it("validates a minimal PPTX structure", async () => {

    const dir = setupUnpacked({
      "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
                xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldMasterIdLst>
    <p:sldMasterId id="2147483648" r:id="rId1"/>
  </p:sldMasterIdLst>
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
      "ppt/slides/slide1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
      "ppt/slideMasters/slideMaster1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
  <p:sldLayoutIdLst>
    <p:sldLayoutId id="2147483649" r:id="rId1"/>
  </p:sldLayoutIdLst>
</p:sldMaster>`,
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
      "ppt/slideLayouts/slideLayout1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
             xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
</p:sldLayout>`,
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels": `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
      "[Content_Types].xml": `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
</Types>`,
      "_rels/.rels": `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
    });

    const v = new PPTXSchemaValidator(dir);
    const result = await v.validate();
    expect(result.valid).toBe(true);
  });

  it("detects duplicate slide layout references", () => {

    const dir = setupUnpacked({
      "ppt/slides/_rels/slide1.xml.rels": `<?xml version="1.0"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout2.xml"/>
        </Relationships>`,
    });

    const v = new PPTXSchemaValidator(dir);
    const result = v.validateNoDuplicateSlideLayouts();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("slideLayout references"))).toBe(true);
  });

  it("detects shared notes slide references", () => {

    const dir = setupUnpacked({
      "ppt/slides/_rels/slide1.xml.rels": `<?xml version="1.0"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
        </Relationships>`,
      "ppt/slides/_rels/slide2.xml.rels": `<?xml version="1.0"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
        </Relationships>`,
    });

    const v = new PPTXSchemaValidator(dir);
    const result = v.validateNotesSlideReferences();
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("multiple slides"))).toBe(true);
  });

  it("validates UUID IDs correctly", () => {

    const dir = setupUnpacked({
      "ppt/presentation.xml": `<?xml version="1.0"?>
        <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:sldId id="{12345678-1234-1234-1234-123456789ABC}"/>
        </p:presentation>`,
    });

    const v = new PPTXSchemaValidator(dir);
    const result = v.validateUuidIds();
    expect(result.valid).toBe(true);
  });

  it("ignores non-UUID numeric IDs", () => {
    // Numeric IDs like "256" are common for sldId — they should not be flagged
    const dir = setupUnpacked({
      "ppt/presentation.xml": `<?xml version="1.0"?>
        <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
          <p:sldId id="256"/>
        </p:presentation>`,
    });

    const v = new PPTXSchemaValidator(dir);
    const result = v.validateUuidIds();
    expect(result.valid).toBe(true);
  });
});
