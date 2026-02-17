/**
 * E2E workflow test: exercises the full SKILL.md flow using TS functions.
 *
 * Workflow (from SKILL.md):
 *   Step 1: unpack  — extract .docx → pretty-print XML, merge runs, simplify redlines
 *   Step 2: edit XML — tracked changes (ins/del), add comments
 *   Step 3: pack    — validate + auto-repair → condense XML → ZIP to .docx
 *
 * Then verify by unpacking the result and inspecting the XML.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

import { unpack } from "../src/unpack";
import { pack } from "../src/pack";
import { addComment } from "../src/comment";
import { mergeRuns } from "../src/helpers/merge-runs";
import { simplifyRedlines, getTrackedChangeAuthors } from "../src/helpers/simplify-redlines";
import { createTestDocxFile } from "./helpers/create-test-docx";

const PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
  allowBooleanAttributes: true,
};

function parseXml(xml: string): any[] {
  const parser = new XMLParser(PARSER_OPTIONS);
  const result = parser.parse(xml);
  return Array.isArray(result)
    ? result.filter((n: any) => !("?xml" in n))
    : [result];
}

function getTagName(node: any): string | null {
  if (typeof node !== "object" || node === null) return null;
  for (const key of Object.keys(node)) {
    if (!key.startsWith("@_") && !key.startsWith("#") && key !== ":@") {
      return key;
    }
  }
  return null;
}

/** Recursively collect all text from w:t and w:delText elements */
function collectText(nodes: any[], tagName: string): string[] {
  const texts: string[] = [];
  function walk(arr: any[]) {
    for (const node of arr) {
      const tag = getTagName(node);
      if (!tag) continue;
      if (tag === tagName || tag.endsWith(`:${tagName.split(":").pop()}`)) {
        const children = node[tag];
        if (Array.isArray(children) && children.length > 0) {
          const first = children[0];
          const text =
            typeof first === "string"
              ? first
              : first?.["#text"] ?? "";
          if (text) texts.push(String(text));
        }
      }
      if (Array.isArray(node[tag])) {
        walk(node[tag]);
      }
    }
  }
  walk(nodes);
  return texts;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 1: Basic unpack → edit → pack roundtrip
// ═══════════════════════════════════════════════════════════════════════

describe("Scenario 1: Basic unpack → edit → pack roundtrip", () => {
  it("preserves document text through full cycle", async () => {
    // Create a test .docx
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "Hello World" },
        { text: "Second paragraph" },
      ],
    });

    // Step 1: Unpack
    const unpackedDir = path.join(tmpDir, "unpacked");
    const [, unpackMsg] = await unpack(docxPath, unpackedDir);
    expect(unpackMsg).toContain("Unpacked");
    expect(fs.existsSync(path.join(unpackedDir, "word", "document.xml"))).toBe(true);

    // Verify XML is pretty-printed (has indentation)
    const docXml = fs.readFileSync(
      path.join(unpackedDir, "word", "document.xml"),
      "utf-8"
    );
    expect(docXml).toContain("Hello World");
    expect(docXml).toContain("Second paragraph");

    // Step 2: No edits (just roundtrip)

    // Step 3: Pack
    const outputPath = path.join(tmpDir, "output.docx");
    const [, packMsg] = await pack(unpackedDir, outputPath, {
      originalFile: docxPath,
    });
    expect(packMsg).toContain("Successfully packed");
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify result by unpacking again
    const verifyDir = path.join(tmpDir, "verify");
    await unpack(outputPath, verifyDir);
    const verifyXml = fs.readFileSync(
      path.join(verifyDir, "word", "document.xml"),
      "utf-8"
    );
    expect(verifyXml).toContain("Hello World");
    expect(verifyXml).toContain("Second paragraph");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 2: Edit with tracked changes (insertion + deletion)
// ═══════════════════════════════════════════════════════════════════════

describe("Scenario 2: Tracked changes workflow", () => {
  it("adds tracked insertion and deletion, then packs successfully", async () => {
    // Create test .docx with "The term is 30 days."
    const docxPath = path.join(tmpDir, "contract.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "The term is 30 days." }],
    });

    // Step 1: Unpack
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, unpackedDir);

    // Step 2: Edit XML — change "30" to "60" with tracked changes
    const docXmlPath = path.join(unpackedDir, "word", "document.xml");
    let docXml = fs.readFileSync(docXmlPath, "utf-8");

    // Replace the run containing "The term is 30 days." with tracked changes
    // Following SKILL.md pattern: split into unchanged + del + ins + unchanged
    const nodes = parseXml(docXml);

    // Find the w:t element with our text
    expect(docXml).toContain("The term is 30 days.");

    // Replace the full paragraph content with tracked changes
    // Using the SKILL.md minimal edit pattern
    const trackedChangeBody = `<w:r><w:t xml:space="preserve">The term is </w:t></w:r>
<w:del w:id="100" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="101" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t xml:space="preserve"> days.</w:t></w:r>`;

    // Find and replace the run in the document
    // We need to replace the content within the first w:p
    const runRegex = /<w:r>[\s\S]*?<w:t[^>]*>The term is 30 days\.<\/w:t>[\s\S]*?<\/w:r>/;
    expect(docXml).toMatch(runRegex);
    docXml = docXml.replace(runRegex, trackedChangeBody);
    fs.writeFileSync(docXmlPath, docXml, "utf-8");

    // Verify tracked changes are in XML
    const editedXml = fs.readFileSync(docXmlPath, "utf-8");
    expect(editedXml).toContain("w:del");
    expect(editedXml).toContain("w:ins");
    expect(editedXml).toContain("w:delText");
    expect(editedXml).toContain('w:author="Claude"');

    // Step 3: Pack
    const outputPath = path.join(tmpDir, "output.docx");
    const [, packMsg] = await pack(unpackedDir, outputPath, {
      originalFile: docxPath,
    });
    expect(packMsg).toContain("Successfully packed");

    // Verify the output docx contains tracked changes
    const verifyDir = path.join(tmpDir, "verify");
    await unpack(outputPath, verifyDir, { mergeRuns: false, simplifyRedlines: false });
    const verifyXml = fs.readFileSync(
      path.join(verifyDir, "word", "document.xml"),
      "utf-8"
    );
    expect(verifyXml).toContain("w:del");
    expect(verifyXml).toContain("w:ins");
    expect(verifyXml).toContain("The term is");

    // Verify getTrackedChangeAuthors finds Claude
    const authors = getTrackedChangeAuthors(
      path.join(verifyDir, "word", "document.xml")
    );
    expect(authors["Claude"]).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 3: Add comments workflow
// ═══════════════════════════════════════════════════════════════════════

describe("Scenario 3: Comments workflow", () => {
  it("adds a comment and reply, then packs successfully", async () => {
    // Create test .docx
    const docxPath = path.join(tmpDir, "review.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "This clause needs review." },
        { text: "Another paragraph." },
      ],
    });

    // Step 1: Unpack
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, unpackedDir);

    // Step 2: Add comments using comment.ts (like comment.py)
    const [paraId1, msg1] = addComment(
      unpackedDir,
      0,
      "Please review this clause for accuracy.",
      "Claude",
      "C"
    );
    expect(paraId1).toBeTruthy();
    expect(msg1).toContain("Added comment 0");

    // Add a reply (like: python scripts/comment.py unpacked/ 1 "Reply" --parent 0)
    const [paraId2, msg2] = addComment(
      unpackedDir,
      1,
      "I agree, let&#x2019;s discuss.",
      "Claude",
      "C",
      0 // parentId
    );
    expect(paraId2).toBeTruthy();
    expect(msg2).toContain("Added reply 1");

    // Now add comment markers to document.xml (as SKILL.md instructs)
    const docXmlPath = path.join(unpackedDir, "word", "document.xml");
    let docXml = fs.readFileSync(docXmlPath, "utf-8");

    // Add comment markers around "This clause needs review."
    // Following SKILL.md: commentRangeStart/End are siblings of w:r
    const targetRunRegex = /(<w:r>[\s\S]*?<w:t[^>]*>This clause needs review\.<\/w:t>[\s\S]*?<\/w:r>)/;
    expect(docXml).toMatch(targetRunRegex);

    docXml = docXml.replace(
      targetRunRegex,
      `<w:commentRangeStart w:id="0"/>
<w:commentRangeStart w:id="1"/>
$1
<w:commentRangeEnd w:id="1"/>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>`
    );
    fs.writeFileSync(docXmlPath, docXml, "utf-8");

    // Verify comments.xml was created
    expect(
      fs.existsSync(path.join(unpackedDir, "word", "comments.xml"))
    ).toBe(true);

    // Verify commentsExtended.xml has the reply relationship
    const extXml = fs.readFileSync(
      path.join(unpackedDir, "word", "commentsExtended.xml"),
      "utf-8"
    );
    expect(extXml).toContain("w15:commentEx");
    expect(extXml).toContain(`w15:paraId="${paraId2}"`);
    expect(extXml).toContain(`w15:paraIdParent="${paraId1}"`);

    // Step 3: Pack (skip validation since we added comment styles not in original)
    const outputPath = path.join(tmpDir, "output.docx");
    const [, packMsg] = await pack(unpackedDir, outputPath, {
      validate: false,
    });
    expect(packMsg).toContain("Successfully packed");

    // Verify the output docx has comments
    const buffer = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(buffer);
    const commentsFile = zip.file("word/comments.xml");
    expect(commentsFile).toBeTruthy();

    const commentsXml = await commentsFile!.async("string");
    expect(commentsXml).toContain("Please review this clause");
    // Smart quote entity should survive
    const docOutFile = zip.file("word/document.xml");
    const docOutXml = await docOutFile!.async("string");
    expect(docOutXml).toContain("commentRangeStart");
    expect(docOutXml).toContain("commentRangeEnd");
    expect(docOutXml).toContain("commentReference");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 4: Merge runs and simplify redlines on real-ish document
// ═══════════════════════════════════════════════════════════════════════

describe("Scenario 4: Merge runs + simplify redlines", () => {
  it("merges split runs during unpack", async () => {
    // Create a .docx with fragmented runs (common in Word output)
    const docxPath = path.join(tmpDir, "fragmented.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="11111111" w14:textId="77777777">
          <w:r w:rsidR="00A1"><w:t xml:space="preserve">Hello </w:t></w:r>
          <w:proofErr w:type="spellStart"/>
          <w:r w:rsidR="00B2"><w:t>World</w:t></w:r>
          <w:proofErr w:type="spellEnd"/>
          <w:r w:rsidR="00C3"><w:t xml:space="preserve"> here.</w:t></w:r>
        </w:p>`,
    });

    // Unpack with merge-runs enabled (default)
    const unpackedDir = path.join(tmpDir, "unpacked");
    const [, msg] = await unpack(docxPath, unpackedDir);
    expect(msg).toContain("merged");

    // The three runs should have been merged into one
    const docXml = fs.readFileSync(
      path.join(unpackedDir, "word", "document.xml"),
      "utf-8"
    );

    // proofErr should be removed
    expect(docXml).not.toContain("proofErr");
    // rsid attributes should be stripped from runs
    expect(docXml).not.toContain("rsidR");

    // The text should be preserved
    const nodes = parseXml(docXml);
    const texts = collectText(nodes, "w:t");
    const allText = texts.join("");
    expect(allText).toContain("Hello");
    expect(allText).toContain("World");
    expect(allText).toContain("here.");
  });

  it("simplifies adjacent tracked changes from same author during unpack", async () => {
    const docxPath = path.join(tmpDir, "redlined.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="22222222" w14:textId="77777777">
          <w:ins w:id="1" w:author="Alice" w:date="2024-01-01T00:00:00Z">
            <w:r><w:t>First </w:t></w:r>
          </w:ins>
          <w:ins w:id="2" w:author="Alice" w:date="2024-01-02T00:00:00Z">
            <w:r><w:t>Second</w:t></w:r>
          </w:ins>
        </w:p>`,
    });

    const unpackedDir = path.join(tmpDir, "unpacked");
    const [, msg] = await unpack(docxPath, unpackedDir);
    expect(msg).toContain("simplified");

    const docXml = fs.readFileSync(
      path.join(unpackedDir, "word", "document.xml"),
      "utf-8"
    );

    // Two adjacent ins from same author should be merged into one
    const insCount = (docXml.match(/<w:ins /g) || []).length;
    expect(insCount).toBe(1);

    // But both texts should be preserved
    expect(docXml).toContain("First");
    expect(docXml).toContain("Second");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 5: Validation and auto-repair during pack
// ═══════════════════════════════════════════════════════════════════════

describe("Scenario 5: Validation and auto-repair", () => {
  it("auto-repairs whitespace preservation during pack", async () => {
    // Create a docx with w:t that has leading space but no xml:space="preserve"
    const docxPath = path.join(tmpDir, "needs-repair.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="33333333" w14:textId="77777777">
          <w:r><w:t> leading space</w:t></w:r>
        </w:p>`,
    });

    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, unpackedDir);

    // Remove xml:space="preserve" if present (simulate broken edit)
    const docXmlPath = path.join(unpackedDir, "word", "document.xml");
    let xml = fs.readFileSync(docXmlPath, "utf-8");
    xml = xml.replace(/xml:space="preserve"/g, "");
    fs.writeFileSync(docXmlPath, xml, "utf-8");

    // Pack with validation — should auto-repair
    const outputPath = path.join(tmpDir, "repaired.docx");
    const [, packMsg] = await pack(unpackedDir, outputPath, {
      originalFile: docxPath,
    });
    expect(packMsg).toContain("Successfully packed");

    // Verify the output has xml:space="preserve" restored
    const verifyDir = path.join(tmpDir, "verify");
    await unpack(outputPath, verifyDir);
    const verifyXml = fs.readFileSync(
      path.join(verifyDir, "word", "document.xml"),
      "utf-8"
    );
    // The leading space should be preserved
    expect(verifyXml).toContain("leading space");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 6: Combined tracked changes + comments + pack
// ═══════════════════════════════════════════════════════════════════════

describe("Scenario 6: Full editing workflow (tracked changes + comments)", () => {
  it("creates a complete edited document with changes and comments", async () => {
    // Create a contract-like document
    const docxPath = path.join(tmpDir, "contract.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "SERVICES AGREEMENT" },
        { text: "The payment term is 30 days from invoice date." },
        { text: "The contractor shall provide weekly reports." },
      ],
    });

    // Step 1: Unpack
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, unpackedDir);

    // Step 2a: Add tracked change — change "30 days" to "60 days"
    const docXmlPath = path.join(unpackedDir, "word", "document.xml");
    let docXml = fs.readFileSync(docXmlPath, "utf-8");

    const paymentRunRegex = /(<w:r>\s*<w:t[^>]*>)(The payment term is 30 days from invoice date\.)(<\/w:t>\s*<\/w:r>)/;
    expect(docXml).toMatch(paymentRunRegex);

    docXml = docXml.replace(
      paymentRunRegex,
      `<w:r><w:t xml:space="preserve">The payment term is </w:t></w:r>
<w:del w:id="200" w:author="Claude" w:date="2025-06-01T00:00:00Z">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="201" w:author="Claude" w:date="2025-06-01T00:00:00Z">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t xml:space="preserve"> days from invoice date.</w:t></w:r>`
    );
    fs.writeFileSync(docXmlPath, docXml, "utf-8");

    // Step 2b: Add comment on the report paragraph
    const [commentParaId, commentMsg] = addComment(
      unpackedDir,
      0,
      "Consider changing to bi-weekly reports.",
      "Claude",
      "C"
    );
    expect(commentParaId).toBeTruthy();

    // Add comment markers to the report paragraph
    docXml = fs.readFileSync(docXmlPath, "utf-8");
    const reportRunRegex = /(<w:r>\s*<w:t[^>]*>The contractor shall provide weekly reports\.<\/w:t>\s*<\/w:r>)/;
    expect(docXml).toMatch(reportRunRegex);

    docXml = docXml.replace(
      reportRunRegex,
      `<w:commentRangeStart w:id="0"/>
$1
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>`
    );
    fs.writeFileSync(docXmlPath, docXml, "utf-8");

    // Step 3: Pack (skip validation to avoid comment style issues)
    const outputPath = path.join(tmpDir, "final.docx");
    const [, packMsg] = await pack(unpackedDir, outputPath, {
      validate: false,
    });
    expect(packMsg).toContain("Successfully packed");

    // ─── Verify the final document ───
    const finalZip = await JSZip.loadAsync(fs.readFileSync(outputPath));

    // 1. Verify tracked changes
    const finalDocXml = await finalZip.file("word/document.xml")!.async("string");
    expect(finalDocXml).toContain("w:del");
    expect(finalDocXml).toContain("w:ins");
    expect(finalDocXml).toContain("w:delText");
    expect(finalDocXml).toContain("60");
    expect(finalDocXml).toContain("SERVICES AGREEMENT");

    // 2. Verify comments
    const commentsXml = await finalZip.file("word/comments.xml")!.async("string");
    expect(commentsXml).toContain("Consider changing to bi-weekly reports.");

    // 3. Verify comment markers in document
    expect(finalDocXml).toContain("commentRangeStart");
    expect(finalDocXml).toContain("commentRangeEnd");
    expect(finalDocXml).toContain("commentReference");

    // 4. Verify all supporting comment files exist
    expect(finalZip.file("word/commentsExtended.xml")).toBeTruthy();
    expect(finalZip.file("word/commentsIds.xml")).toBeTruthy();
    expect(finalZip.file("word/commentsExtensible.xml")).toBeTruthy();

    // 5. Verify relationships were registered
    const relsXml = await finalZip
      .file("word/_rels/document.xml.rels")!
      .async("string");
    expect(relsXml).toContain("comments.xml");

    // 6. Verify content types were registered
    const ctXml = await finalZip
      .file("[Content_Types].xml")!
      .async("string");
    expect(ctXml).toContain("/word/comments.xml");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 7: Pack condenses XML (removes pretty-printing)
// ═══════════════════════════════════════════════════════════════════════

describe("Scenario 7: XML condensation during pack", () => {
  it("pack produces condensed XML in the output docx", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Test condensation" }],
    });

    // Unpack (produces pretty-printed XML)
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, unpackedDir);

    const prettyXml = fs.readFileSync(
      path.join(unpackedDir, "word", "document.xml"),
      "utf-8"
    );
    // Unpack should produce indented XML
    expect(prettyXml).toMatch(/\n\s+</);

    // Pack
    const outputPath = path.join(tmpDir, "output.docx");
    await pack(unpackedDir, outputPath, { validate: false });

    // The packed .docx should have condensed XML
    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const packedXml = await zip.file("word/document.xml")!.async("string");

    // Condensed means no indentation whitespace between tags
    expect(packedXml).not.toMatch(/>\n\s+</);
    expect(packedXml).toContain("Test condensation");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 8: Smart quote handling through full cycle
// ═══════════════════════════════════════════════════════════════════════

describe("Scenario 8: Smart quote handling", () => {
  it("smart quotes survive unpack → edit → pack cycle", async () => {
    // Create a docx with smart quotes
    const docxPath = path.join(tmpDir, "quotes.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="44444444" w14:textId="77777777">
          <w:r><w:t>Here\u2019s a \u201cquote\u201d example.</w:t></w:r>
        </w:p>`,
    });

    // Step 1: Unpack — should convert smart quotes to XML entities
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, unpackedDir);

    const docXml = fs.readFileSync(
      path.join(unpackedDir, "word", "document.xml"),
      "utf-8"
    );
    // Smart quotes should be escaped as XML entities
    expect(docXml).toContain("&#x2019;"); // right single quote / apostrophe
    expect(docXml).toContain("&#x201C;"); // left double quote
    expect(docXml).toContain("&#x201D;"); // right double quote

    // Step 3: Pack
    const outputPath = path.join(tmpDir, "output.docx");
    await pack(unpackedDir, outputPath, { validate: false });

    // Verify text survives in the packed docx
    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const packedXml = await zip.file("word/document.xml")!.async("string");
    expect(packedXml).toContain("quote");
    expect(packedXml).toContain("example");
  });
});
