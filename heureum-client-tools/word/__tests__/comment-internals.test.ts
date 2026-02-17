/**
 * Function-level unit tests for comment.ts internal functions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { _internal } from "../src/comment";

const {
  generateHexId,
  encodeSmartQuotes,
  parseXml,
  buildXmlString,
  getTagName,
  appendXml,
  findParaId,
  getNextRid,
  hasRelationship,
  hasContentType,
  ensureCommentRelationships,
  ensureCommentContentTypes,
  ensureTemplate,
} = _internal;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comment-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── generateHexId ────────────────────────────────────────────────────

describe("generateHexId", () => {
  it("returns 8-character uppercase hex string", () => {
    const id = generateHexId();
    expect(id).toMatch(/^[0-9A-F]{8}$/);
  });

  it("returns different IDs on successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateHexId());
    }
    // Highly unlikely to get duplicates in 100 calls
    expect(ids.size).toBeGreaterThan(90);
  });
});

// ── encodeSmartQuotes ────────────────────────────────────────────────

describe("encodeSmartQuotes", () => {
  it("encodes left double quote", () => {
    expect(encodeSmartQuotes("\u201c")).toBe("&#x201C;");
  });

  it("encodes right double quote", () => {
    expect(encodeSmartQuotes("\u201d")).toBe("&#x201D;");
  });

  it("encodes left single quote", () => {
    expect(encodeSmartQuotes("\u2018")).toBe("&#x2018;");
  });

  it("encodes right single quote", () => {
    expect(encodeSmartQuotes("\u2019")).toBe("&#x2019;");
  });

  it("does not modify regular text", () => {
    expect(encodeSmartQuotes("hello world")).toBe("hello world");
  });

  it("encodes multiple smart quotes in one string", () => {
    const result = encodeSmartQuotes("\u201cHello\u201d");
    expect(result).toBe("&#x201C;Hello&#x201D;");
  });
});

// ── parseXml / buildXmlString ────────────────────────────────────────

describe("comment parseXml", () => {
  it("filters ?xml declaration", () => {
    const nodes = parseXml('<?xml version="1.0"?><root/>');
    expect(nodes.every((n: any) => !("?xml" in n))).toBe(true);
  });
});

describe("comment buildXmlString", () => {
  it("adds ?xml declaration", () => {
    const nodes = parseXml("<root/>");
    const xml = buildXmlString(nodes);
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(xml).toContain("<root");
  });

  it("does not double ?xml declaration", () => {
    const nodes = parseXml('<?xml version="1.0"?><root/>');
    const xml = buildXmlString(nodes);
    expect((xml.match(/<\?xml/g) || []).length).toBe(1);
  });
});

// ── getTagName ───────────────────────────────────────────────────────

describe("comment getTagName", () => {
  it("returns element tag", () => {
    expect(getTagName({ "w:comments": [] })).toBe("w:comments");
  });

  it("returns null for #text", () => {
    expect(getTagName({ "#text": "x" })).toBeNull();
  });
});

// ── appendXml ────────────────────────────────────────────────────────

describe("appendXml", () => {
  it("appends child element to root", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    fs.writeFileSync(
      xmlPath,
      '<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:comments>',
      "utf-8"
    );

    appendXml(xmlPath, "w:comments", '<w:comment w:id="0" w:author="Test" w:date="2024-01-01T00:00:00Z"><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:comment>');

    const content = fs.readFileSync(xmlPath, "utf-8");
    expect(content).toContain("w:comment");
    expect(content).toContain('w:id="0"');
  });

  it("does nothing when root tag not found", () => {
    const xmlPath = path.join(tmpDir, "test.xml");
    const original = '<?xml version="1.0"?><other/>';
    fs.writeFileSync(xmlPath, original, "utf-8");
    appendXml(xmlPath, "w:comments", "<child/>");
    // File should be unchanged since root tag wasn't found
    const content = fs.readFileSync(xmlPath, "utf-8");
    expect(content).toBe(original);
  });
});

// ── findParaId ───────────────────────────────────────────────────────

describe("findParaId", () => {
  it("finds paraId for a given comment id", () => {
    const commentsPath = path.join(tmpDir, "comments.xml");
    fs.writeFileSync(
      commentsPath,
      `<?xml version="1.0" encoding="UTF-8"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
        <w:comment w:id="0" w:author="Test" w:date="2024-01-01T00:00:00Z">
          <w:p w14:paraId="ABCD1234" w14:textId="77777777">
            <w:r><w:t>comment text</w:t></w:r>
          </w:p>
        </w:comment>
      </w:comments>`,
      "utf-8"
    );

    expect(findParaId(commentsPath, 0)).toBe("ABCD1234");
  });

  it("returns null for non-existent comment id", () => {
    const commentsPath = path.join(tmpDir, "comments.xml");
    fs.writeFileSync(
      commentsPath,
      `<?xml version="1.0" encoding="UTF-8"?>
      <w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
        <w:comment w:id="0" w:author="Test" w:date="2024-01-01T00:00:00Z">
          <w:p w14:paraId="ABCD1234" w14:textId="77777777">
            <w:r><w:t>comment text</w:t></w:r>
          </w:p>
        </w:comment>
      </w:comments>`,
      "utf-8"
    );

    expect(findParaId(commentsPath, 99)).toBeNull();
  });
});

// ── getNextRid ───────────────────────────────────────────────────────

describe("getNextRid", () => {
  it("returns next rid number after max", () => {
    const relsPath = path.join(tmpDir, "test.rels");
    fs.writeFileSync(
      relsPath,
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://example.com" Target="a.xml"/>
        <Relationship Id="rId3" Type="http://example.com" Target="b.xml"/>
      </Relationships>`,
      "utf-8"
    );

    expect(getNextRid(relsPath)).toBe(4);
  });

  it("returns 1 when no relationships", () => {
    const relsPath = path.join(tmpDir, "test.rels");
    fs.writeFileSync(
      relsPath,
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      </Relationships>`,
      "utf-8"
    );

    expect(getNextRid(relsPath)).toBe(1);
  });
});

// ── hasRelationship ──────────────────────────────────────────────────

describe("hasRelationship", () => {
  let relsPath: string;

  beforeEach(() => {
    relsPath = path.join(tmpDir, "test.rels");
    fs.writeFileSync(
      relsPath,
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://example.com" Target="comments.xml"/>
      </Relationships>`,
      "utf-8"
    );
  });

  it("returns true when target exists", () => {
    expect(hasRelationship(relsPath, "comments.xml")).toBe(true);
  });

  it("returns false when target does not exist", () => {
    expect(hasRelationship(relsPath, "other.xml")).toBe(false);
  });
});

// ── hasContentType ───────────────────────────────────────────────────

describe("hasContentType", () => {
  let ctPath: string;

  beforeEach(() => {
    ctPath = path.join(tmpDir, "[Content_Types].xml");
    fs.writeFileSync(
      ctPath,
      `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
      </Types>`,
      "utf-8"
    );
  });

  it("returns true when part exists", () => {
    expect(hasContentType(ctPath, "/word/comments.xml")).toBe(true);
  });

  it("returns false when part does not exist", () => {
    expect(hasContentType(ctPath, "/word/other.xml")).toBe(false);
  });
});

// ── ensureCommentRelationships ───────────────────────────────────────

describe("ensureCommentRelationships", () => {
  it("adds comment relationships when not present", () => {
    // Create unpacked dir structure
    const wordDir = path.join(tmpDir, "word", "_rels");
    fs.mkdirSync(wordDir, { recursive: true });
    const relsPath = path.join(wordDir, "document.xml.rels");
    fs.writeFileSync(
      relsPath,
      `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
      </Relationships>`,
      "utf-8"
    );

    ensureCommentRelationships(tmpDir);

    const content = fs.readFileSync(relsPath, "utf-8");
    expect(content).toContain("comments.xml");
    expect(content).toContain("commentsExtended.xml");
    expect(content).toContain("commentsIds.xml");
    expect(content).toContain("commentsExtensible.xml");
  });

  it("skips when comments.xml relationship already exists", () => {
    const wordDir = path.join(tmpDir, "word", "_rels");
    fs.mkdirSync(wordDir, { recursive: true });
    const relsPath = path.join(wordDir, "document.xml.rels");
    const original = `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
      </Relationships>`;
    fs.writeFileSync(relsPath, original, "utf-8");

    ensureCommentRelationships(tmpDir);

    const content = fs.readFileSync(relsPath, "utf-8");
    // Should not add commentsExtended since it skips when comments.xml already present
    expect(content).not.toContain("commentsExtended.xml");
  });
});

// ── ensureCommentContentTypes ────────────────────────────────────────

describe("ensureCommentContentTypes", () => {
  it("adds content type overrides when not present", () => {
    const ctPath = path.join(tmpDir, "[Content_Types].xml");
    fs.writeFileSync(
      ctPath,
      `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      </Types>`,
      "utf-8"
    );

    ensureCommentContentTypes(tmpDir);

    const content = fs.readFileSync(ctPath, "utf-8");
    expect(content).toContain("/word/comments.xml");
    expect(content).toContain("/word/commentsExtended.xml");
    expect(content).toContain("/word/commentsIds.xml");
    expect(content).toContain("/word/commentsExtensible.xml");
  });

  it("skips when /word/comments.xml already declared", () => {
    const ctPath = path.join(tmpDir, "[Content_Types].xml");
    const original = `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
      </Types>`;
    fs.writeFileSync(ctPath, original, "utf-8");

    ensureCommentContentTypes(tmpDir);

    const content = fs.readFileSync(ctPath, "utf-8");
    expect(content).not.toContain("/word/commentsExtended.xml");
  });
});

// ── ensureTemplate ───────────────────────────────────────────────────

describe("ensureTemplate", () => {
  it("copies template when destination does not exist", () => {
    const templateDir = path.join(__dirname, "..", "src", "templates");
    if (!fs.existsSync(path.join(templateDir, "comments.xml"))) return;

    const destPath = path.join(tmpDir, "comments.xml");
    ensureTemplate("comments.xml", destPath);
    expect(fs.existsSync(destPath)).toBe(true);
  });

  it("does not overwrite existing file", () => {
    const destPath = path.join(tmpDir, "existing.xml");
    fs.writeFileSync(destPath, "original content", "utf-8");
    ensureTemplate("comments.xml", destPath);
    expect(fs.readFileSync(destPath, "utf-8")).toBe("original content");
  });
});
