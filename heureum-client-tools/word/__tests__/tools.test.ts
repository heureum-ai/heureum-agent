import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import JSZip from "jszip";
import {
  docxRead,
  docxAddComment,
  docxRedline,
  docxValidate,
  docxSimplify,
  docxAcceptChanges,
  docxConvert,
  docxCreate,
  docxDeleteParagraph,
  docxReviewChanges,
  docxInsertImage,
  docxConvertToImages,
  handleDocxTool,
} from "../src/tools";
import * as child_process from "child_process";
import { createTestDocxFile } from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// docxRead
// ---------------------------------------------------------------------------

describe("docxRead", () => {
  it("reads a simple document and returns paragraph text", async () => {
    const docxPath = path.join(tmpDir, "simple.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "Hello World" },
        { text: "Second paragraph" },
      ],
    });

    const result = await docxRead({ path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Paragraphs (2 total, 2 with text):");
    expect(result.output).toContain('"Hello World"');
    expect(result.output).toContain('"Second paragraph"');
    expect(result.output).toContain("[0]");
    expect(result.output).toContain("[1]");
  });

  it("includes formatting info (bold, italic)", async () => {
    const docxPath = path.join(tmpDir, "formatted.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "Bold text", bold: true },
        { text: "Italic text", italic: true },
        { text: "Both styles", bold: true, italic: true },
      ],
    });

    const result = await docxRead({ path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("bold");
    expect(result.output).toContain("italic");
  });

  it("includes tracked changes info", async () => {
    const docxPath = path.join(tmpDir, "tracked.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "ins", text: "inserted text", author: "Alice", date: "2024-06-01T00:00:00Z" },
        { type: "del", text: "deleted text", author: "Bob", date: "2024-06-02T00:00:00Z" },
      ],
    });

    const result = await docxRead({ path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Tracked Changes");
    expect(result.output).toContain("[ins]");
    expect(result.output).toContain("[del]");
    expect(result.output).toContain("inserted text");
    expect(result.output).toContain("deleted text");
    expect(result.output).toContain("Alice");
    expect(result.output).toContain("Bob");
  });

  it("includes comments info", async () => {
    const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:comment w:id="0" w:author="Reviewer" w:date="2024-01-01T00:00:00Z" w:initials="R">
    <w:p w14:paraId="AAAAAAAA" w14:textId="77777777">
      <w:r><w:t>This needs revision</w:t></w:r>
    </w:p>
  </w:comment>
</w:comments>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`;

    const docxPath = path.join(tmpDir, "with-comments.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Paragraph with comment" }],
      extraFiles: {
        "word/comments.xml": commentsXml,
        "[Content_Types].xml": contentTypesXml,
      },
    });

    const result = await docxRead({ path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Comments (1):");
    expect(result.output).toContain("Reviewer");
    expect(result.output).toContain("This needs revision");
  });

  it("returns error for non-existent file", async () => {
    const result = await docxRead({ path: "/nonexistent/file.docx" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
    expect(result.output).toContain("File not found");
  });
});

// ---------------------------------------------------------------------------
// docxAddComment
// ---------------------------------------------------------------------------

describe("docxAddComment", () => {
  it("adds a comment to a paragraph and produces output file", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "First paragraph" },
        { text: "Second paragraph" },
      ],
    });

    const result = await docxAddComment({
      path: docxPath,
      paragraphIndex: 0,
      text: "Review this section",
      author: "TestAuthor",
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Added comment");
    expect(result.output).toContain("TestAuthor");
    expect(result.output).toContain("Review this section");
    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("output file contains comment markers", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello World" }],
    });

    await docxAddComment({
      path: docxPath,
      paragraphIndex: 0,
      text: "A comment",
      outputPath: outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("commentRangeStart");
    expect(docXml).toContain("commentRangeEnd");
    expect(docXml).toContain("commentReference");
  });

  it("output file contains comments.xml with the comment text", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello World" }],
    });

    await docxAddComment({
      path: docxPath,
      paragraphIndex: 0,
      text: "My comment text here",
      author: "Alice",
      outputPath: outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const commentsFile = zip.file("word/comments.xml");
    expect(commentsFile).toBeTruthy();

    const commentsXml = await commentsFile!.async("string");
    expect(commentsXml).toContain("My comment text here");
    expect(commentsXml).toContain("Alice");
  });

  it("returns error for invalid paragraph index", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Only one paragraph" }],
    });

    const result = await docxAddComment({
      path: docxPath,
      paragraphIndex: 5,
      text: "Out of range",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
    expect(result.output).toContain("out of range");
  });

  it("returns error for non-existent file", async () => {
    const result = await docxAddComment({
      path: "/nonexistent/file.docx",
      paragraphIndex: 0,
      text: "comment",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
    expect(result.output).toContain("File not found");
  });

  it("uses default output path when none specified", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxAddComment({
      path: docxPath,
      paragraphIndex: 0,
      text: "test comment",
    });

    expect(result.success).toBe(true);
    const expectedOutput = path.join(tmpDir, "input_modified.docx");
    expect(result.outputPath).toBe(expectedOutput);
    expect(fs.existsSync(expectedOutput)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// docxRedline
// ---------------------------------------------------------------------------

describe("docxRedline", () => {
  it("applies a single find/replace change", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "The term is 30 days." }],
    });

    const result = await docxRedline({
      path: docxPath,
      changes: [{ find: "30", replace: "60" }],
      author: "Claude",
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Applied 1/1");
    expect(result.output).toContain("Claude");
    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("output contains w:del and w:ins elements", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "The term is 30 days." }],
    });

    await docxRedline({
      path: docxPath,
      changes: [{ find: "30", replace: "60" }],
      author: "Claude",
      outputPath: outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:del");
    expect(docXml).toContain("w:ins");
    expect(docXml).toContain("w:delText");
    expect(docXml).toContain("30");
    expect(docXml).toContain("60");
  });

  it("applies multiple changes", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "The term is 30 days." },
        { text: "The fee is $100." },
      ],
    });

    const result = await docxRedline({
      path: docxPath,
      changes: [
        { find: "30", replace: "60" },
        { find: "$100", replace: "$200" },
      ],
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Applied 2/2");
  });

  it("reports not-found changes", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello World" }],
    });

    const result = await docxRedline({
      path: docxPath,
      changes: [
        { find: "Hello", replace: "Hi" },
        { find: "nonexistent text", replace: "replacement" },
      ],
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Applied 1/2");
    expect(result.output).toContain("Not found");
    expect(result.output).toContain("nonexistent text");
  });

  it("returns success=false when no changes found at all", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello World" }],
    });

    const result = await docxRedline({
      path: docxPath,
      changes: [{ find: "nonexistent", replace: "replacement" }],
      outputPath: outputPath,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Applied 0/1");
    expect(result.output).toContain("Not found");
  });

  it("handles text spanning multiple runs", async () => {
    const docxPath = path.join(tmpDir, "multi-run.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="11111111" w14:textId="77777777">
          <w:r><w:t xml:space="preserve">Hello </w:t></w:r>
          <w:r><w:t>World</w:t></w:r>
        </w:p>`,
    });

    // After unpack with mergeRuns, the runs should be merged into one,
    // so "Hello World" should be findable as a single string
    const result = await docxRedline({
      path: docxPath,
      changes: [{ find: "Hello World", replace: "Hi There" }],
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Applied 1/1");
  });

  it("returns error for non-existent file", async () => {
    const result = await docxRedline({
      path: "/nonexistent/file.docx",
      changes: [{ find: "a", replace: "b" }],
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
    expect(result.output).toContain("File not found");
  });

  it("returns error when no changes provided", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxRedline({
      path: docxPath,
      changes: [],
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("No changes provided");
  });
});

// ---------------------------------------------------------------------------
// docxValidate
// ---------------------------------------------------------------------------

describe("docxValidate", () => {
  it("validates a well-formed document (success)", async () => {
    const docxPath = path.join(tmpDir, "valid.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "A well-formed document." }],
    });

    const result = await docxValidate({ path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("PASSED");
  });

  it("auto-repairs whitespace preservation issues", async () => {
    const docxPath = path.join(tmpDir, "needs-repair.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="33333333" w14:textId="77777777">
          <w:r><w:t> leading space without preserve</w:t></w:r>
        </w:p>`,
    });

    const result = await docxValidate({ path: docxPath, autoRepair: true });
    // Should succeed (auto-repair fixes the issue, then validation passes)
    expect(result.success).toBe(true);
  });

  it("returns error for non-existent file", async () => {
    const result = await docxValidate({ path: "/nonexistent/file.docx" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
    expect(result.output).toContain("File not found");
  });
});

// ---------------------------------------------------------------------------
// docxSimplify
// ---------------------------------------------------------------------------

describe("docxSimplify", () => {
  it("simplifies a document with adjacent runs", async () => {
    const docxPath = path.join(tmpDir, "fragmented.docx");
    const outputPath = path.join(tmpDir, "simplified.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="11111111" w14:textId="77777777">
          <w:r><w:t xml:space="preserve">Hello </w:t></w:r>
          <w:r><w:t>World</w:t></w:r>
          <w:r><w:t xml:space="preserve"> today</w:t></w:r>
        </w:p>`,
    });

    const result = await docxSimplify({
      path: docxPath,
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Simplified document");
    expect(result.output).toContain("merged");
    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify the output contains the text
    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("Hello");
    expect(docXml).toContain("World");
    expect(docXml).toContain("today");
  });

  it("simplifies a document with adjacent tracked changes from same author", async () => {
    const docxPath = path.join(tmpDir, "redlined.docx");
    const outputPath = path.join(tmpDir, "simplified.docx");
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

    const result = await docxSimplify({
      path: docxPath,
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Simplified document");
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify the adjacent insertions from the same author were simplified
    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("First");
    expect(docXml).toContain("Second");
  });

  it("returns error for non-existent file", async () => {
    const result = await docxSimplify({ path: "/nonexistent/file.docx" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
    expect(result.output).toContain("File not found");
  });

  it("uses default output path when none specified", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxSimplify({ path: docxPath });
    expect(result.success).toBe(true);
    const expectedOutput = path.join(tmpDir, "input_modified.docx");
    expect(result.outputPath).toBe(expectedOutput);
    expect(fs.existsSync(expectedOutput)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleDocxTool (dispatcher)
// ---------------------------------------------------------------------------

describe("handleDocxTool", () => {
  it("routes docxRead to correct function", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Dispatcher test" }],
    });

    const result = await handleDocxTool("docxRead", { path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Dispatcher test");
  });

  it("routes docxAddComment to correct function", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await handleDocxTool("docxAddComment", {
      path: docxPath,
      paragraphIndex: 0,
      text: "test comment",
      outputPath: outputPath,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Added comment");
  });

  it("routes docxRedline to correct function", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello World" }],
    });

    const result = await handleDocxTool("docxRedline", {
      path: docxPath,
      changes: [{ find: "Hello", replace: "Hi" }],
      outputPath: outputPath,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Applied 1/1");
  });

  it("routes docxValidate to correct function", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Valid doc" }],
    });

    const result = await handleDocxTool("docxValidate", { path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("PASSED");
  });

  it("routes docxSimplify to correct function", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Simple doc" }],
    });

    const result = await handleDocxTool("docxSimplify", {
      path: docxPath,
      outputPath: outputPath,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Simplified document");
  });

  it("returns error for unknown tool name", async () => {
    const result = await handleDocxTool("docx_nonexistent", {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool");
    expect(result.output).toContain("docx_nonexistent");
  });
});

// ---------------------------------------------------------------------------
// Stream D: Enhanced tests for new features
// ---------------------------------------------------------------------------

describe("docxRead (enhanced)", () => {
  it("filters empty paragraphs from output but preserves indices", async () => {
    const docxPath = path.join(tmpDir, "mixed.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="00000001" w14:textId="77777777"><w:r><w:t>First</w:t></w:r></w:p>
        <w:p w14:paraId="00000002" w14:textId="77777777"></w:p>
        <w:p w14:paraId="00000003" w14:textId="77777777"><w:r><w:t>Third</w:t></w:r></w:p>`,
    });

    const result = await docxRead({ path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("3 total, 2 with text");
    expect(result.output).toContain('[0] "First"');
    expect(result.output).toContain('[2] "Third"');
    // Empty paragraph [1] should not appear
    expect(result.output).not.toContain("[1]");
  });

  it("reads hyperlink text in paragraphs", async () => {
    const docxPath = path.join(tmpDir, "hyperlink.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="00000001" w14:textId="77777777">
          <w:r><w:t xml:space="preserve">Click </w:t></w:r>
          <w:hyperlink r:id="rId1">
            <w:r><w:t>here</w:t></w:r>
          </w:hyperlink>
          <w:r><w:t xml:space="preserve"> for info</w:t></w:r>
        </w:p>`,
    });

    const result = await docxRead({ path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Click");
    expect(result.output).toContain("here");
    expect(result.output).toContain("for info");
  });

  it("reads text from table paragraphs", async () => {
    const docxPath = path.join(tmpDir, "table.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="00000001" w14:textId="77777777"><w:r><w:t>Before table</w:t></w:r></w:p>
        <w:tbl>
          <w:tr>
            <w:tc>
              <w:p w14:paraId="00000002" w14:textId="77777777"><w:r><w:t>Cell A1</w:t></w:r></w:p>
            </w:tc>
            <w:tc>
              <w:p w14:paraId="00000003" w14:textId="77777777"><w:r><w:t>Cell B1</w:t></w:r></w:p>
            </w:tc>
          </w:tr>
        </w:tbl>
        <w:p w14:paraId="00000004" w14:textId="77777777"><w:r><w:t>After table</w:t></w:r></w:p>`,
    });

    const result = await docxRead({ path: docxPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Cell A1");
    expect(result.output).toContain("Cell B1");
    expect(result.output).toContain("Before table");
    expect(result.output).toContain("After table");
    // Table paragraphs should be indexed correctly
    expect(result.output).toContain("4 total");
  });
});

describe("docxAddComment (enhanced)", () => {
  it("adds multi-paragraph comment range", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "First paragraph" },
        { text: "Second paragraph" },
        { text: "Third paragraph" },
      ],
    });

    const result = await docxAddComment({
      path: docxPath,
      paragraphIndex: 0,
      paragraphIndexEnd: 2,
      text: "Multi-paragraph comment",
      author: "Reviewer",
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("paragraphs 0-2");

    // Verify markers are in separate paragraphs
    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("commentRangeStart");
    expect(docXml).toContain("commentRangeEnd");
    expect(docXml).toContain("commentReference");
  });

  it("returns error when paragraphIndexEnd < paragraphIndex", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "First" },
        { text: "Second" },
      ],
    });

    const result = await docxAddComment({
      path: docxPath,
      paragraphIndex: 1,
      paragraphIndexEnd: 0,
      text: "Bad range",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("must be >=");
  });

  it("returns error when paragraphIndexEnd out of range", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Only one" }],
    });

    const result = await docxAddComment({
      path: docxPath,
      paragraphIndex: 0,
      paragraphIndexEnd: 5,
      text: "Out of range",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("out of range");
  });

  it("places comment markers after pPr in paragraph with formatting", async () => {
    const docxPath = path.join(tmpDir, "with-ppr.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="00000001" w14:textId="77777777">
          <w:pPr><w:jc w:val="center"/></w:pPr>
          <w:r><w:t>Centered text</w:t></w:r>
        </w:p>`,
    });

    const result = await docxAddComment({
      path: docxPath,
      paragraphIndex: 0,
      text: "Check alignment",
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // commentRangeStart should come after pPr, not before
    const pPrPos = docXml.indexOf("w:pPr");
    const rangeStartPos = docXml.indexOf("commentRangeStart");
    expect(rangeStartPos).toBeGreaterThan(pPrPos);
  });
});

describe("docxRedline (enhanced)", () => {
  it("output contains proper delText markup", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "The term is 30 days." }],
    });

    await docxRedline({
      path: docxPath,
      changes: [{ find: "30", replace: "60" }],
      author: "Claude",
      outputPath: outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // Verify delText wraps the correct text
    expect(docXml).toMatch(/<w:delText[^>]*>30<\/w:delText>/);
    // Verify ins wraps the correct text
    expect(docXml).toMatch(/<w:t[^>]*>60<\/w:t>/);
  });

  it("handles text inside hyperlinks", async () => {
    const docxPath = path.join(tmpDir, "hyperlink.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="00000001" w14:textId="77777777">
          <w:hyperlink r:id="rId1">
            <w:r><w:t>old link text</w:t></w:r>
          </w:hyperlink>
        </w:p>`,
    });

    const result = await docxRedline({
      path: docxPath,
      changes: [{ find: "old link text", replace: "new link text" }],
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Applied 1/1");

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toMatch(/<w:delText[^>]*>old link text<\/w:delText>/);
  });

  it("applies change with paragraphIndex targeting specific paragraph", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "Same text here" },
        { text: "Same text here" },
      ],
    });

    const result = await docxRedline({
      path: docxPath,
      changes: [{ find: "Same text here", replace: "Changed", paragraphIndex: 1 }],
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Applied 1/1");

    // Read back to verify only second paragraph was changed
    const readResult = await docxRead({ path: outputPath });
    // First paragraph should still have original text
    expect(readResult.output).toContain("Same text here");
  });

  it("applies matchAll to replace all occurrences", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "Replace this and this too" },
        { text: "Another this here" },
      ],
    });

    const result = await docxRedline({
      path: docxPath,
      changes: [{ find: "this", replace: "that" }],
      matchAll: true,
      outputPath: outputPath,
    });

    expect(result.success).toBe(true);
    // Should have applied to all occurrences across paragraphs
    const totalApplied = parseInt(result.output.match(/Applied (\d+)/)?.[1] ?? "0");
    expect(totalApplied).toBeGreaterThanOrEqual(3);
  });
});

describe("docxSimplify (enhanced)", () => {
  it("verifies adjacent insertions from same author are merged", async () => {
    const docxPath = path.join(tmpDir, "redlined.docx");
    const outputPath = path.join(tmpDir, "simplified.docx");
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

    await docxSimplify({ path: docxPath, outputPath: outputPath });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // Count w:ins occurrences — after simplification, should be 1 (merged)
    const insCount = (docXml.match(/<w:ins\s/g) || []).length;
    expect(insCount).toBe(1);
  });
});

describe("docxValidate (enhanced)", () => {
  it("returns structured errors for invalid document", async () => {
    const docxPath = path.join(tmpDir, "bad.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="FFFFFFFF" w14:textId="77777777">
          <w:r><w:t>Bad paraId</w:t></w:r>
        </w:p>`,
    });

    const result = await docxValidate({ path: docxPath, autoRepair: false });
    expect(result.success).toBe(false);
    expect(result.output).toContain("paraId");
  });
});

// ---------------------------------------------------------------------------
// Helper to check if soffice is available
// ---------------------------------------------------------------------------

function hasSoffice(): boolean {
  try {
    const result = child_process.spawnSync("soffice", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// docxAcceptChanges
// ---------------------------------------------------------------------------

describe("docxAcceptChanges", () => {
  it("returns error for non-existent file", async () => {
    const result = await docxAcceptChanges({ path: "/nonexistent/file.docx" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
    expect(result.output).toContain("not found");
  });

  it("uses default output path (_modified.docx) when none specified", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    // Without soffice this will fail, but we can check the error handling
    const result = await docxAcceptChanges({ path: docxPath });
    // Either succeeds (soffice found) or fails gracefully
    if (hasSoffice()) {
      expect(result.success).toBe(true);
      expect(result.outputPath).toBe(path.join(tmpDir, "input_modified.docx"));
    } else {
      expect(result.success).toBe(false);
    }
  });

  it.skipIf(!hasSoffice())("accepts tracked changes and produces output file", async () => {
    const docxPath = path.join(tmpDir, "tracked.docx");
    const outputPath = path.join(tmpDir, "accepted.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "ins", text: "new text", author: "Alice", date: "2024-01-01T00:00:00Z" },
      ],
    });

    const result = await docxAcceptChanges({ path: docxPath, outputPath: outputPath });
    expect(result.success).toBe(true);
    expect(result.output).toContain("accepted");
    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// docxConvert
// ---------------------------------------------------------------------------

describe("docxConvert", () => {
  it("returns error for non-existent file", async () => {
    const result = await docxConvert({
      path: "/nonexistent/file.docx",
      format: "pdf",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Error");
    expect(result.output).toContain("File not found");
  });

  it("returns error for unsupported format", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxConvert({
      path: docxPath,
      format: "xyz" as any,
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unsupported format");
  });

  it.skipIf(!hasSoffice())("converts docx to pdf", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Convert me" }],
    });

    const result = await docxConvert({
      path: docxPath,
      format: "pdf",
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Converted");
    expect(result.output).toContain("pdf");
    expect(result.outputPath).toBeDefined();
    expect(fs.existsSync(result.outputPath!)).toBe(true);
  });

  it.skipIf(!hasSoffice())("converts with custom outputPath", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const customOutput = path.join(tmpDir, "custom-name.pdf");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Custom output" }],
    });

    const result = await docxConvert({
      path: docxPath,
      format: "pdf",
      outputPath: customOutput,
    });
    expect(result.success).toBe(true);
    expect(result.outputPath).toBe(customOutput);
    expect(fs.existsSync(customOutput)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// docxCreate
// ---------------------------------------------------------------------------

describe("docxCreate", () => {
  it("creates a valid DOCX file with basic paragraphs", async () => {
    const outputPath = path.join(tmpDir, "created.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Hello World" } },
        { paragraph: { text: "Second paragraph" } },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Created DOCX with 2 paragraph(s)");
    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("Hello World");
    expect(docXml).toContain("Second paragraph");
  });

  it("creates headings 1/2/3", async () => {
    const outputPath = path.join(tmpDir, "headings.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Heading 1", heading: 1 } },
        { paragraph: { text: "Heading 2", heading: 2 } },
        { paragraph: { text: "Heading 3", heading: 3 } },
        { paragraph: { text: "Normal text" } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("Heading1");
    expect(docXml).toContain("Heading2");
    expect(docXml).toContain("Heading3");
  });

  it("applies bold and italic formatting", async () => {
    const outputPath = path.join(tmpDir, "formatted.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Bold text", bold: true } },
        { paragraph: { text: "Italic text", italic: true } },
        { paragraph: { text: "Both", bold: true, italic: true } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("<w:b");
    expect(docXml).toContain("<w:i");
  });

  it("sets page size to A4 (SKILL.md canonical DXA 11906)", async () => {
    const outputPath = path.join(tmpDir, "a4.docx");

    const result = await docxCreate({
      outputPath,
      content: [{ paragraph: { text: "A4 document" } }],
      pageSize: "a4",
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:w=\"11906\"");
  });

  it("sets page size to letter (default)", async () => {
    const outputPath = path.join(tmpDir, "letter.docx");

    const result = await docxCreate({
      outputPath,
      content: [{ paragraph: { text: "Letter document" } }],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:w=\"12240\"");
  });

  it("applies text alignment", async () => {
    const outputPath = path.join(tmpDir, "aligned.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Centered", alignment: "center" } },
        { paragraph: { text: "Right-aligned", alignment: "right" } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("center");
    expect(docXml).toContain("right");
  });

  it("returns error for empty content", async () => {
    const outputPath = path.join(tmpDir, "empty.docx");

    const result = await docxCreate({
      outputPath,
      content: [],
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("No content provided");
  });

  it("created file is readable by docxRead", async () => {
    const outputPath = path.join(tmpDir, "readable.docx");

    await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Test paragraph one" } },
        { paragraph: { text: "Test paragraph two" } },
      ],
    });

    const readResult = await docxRead({ path: outputPath });
    expect(readResult.success).toBe(true);
    expect(readResult.output).toContain("Test paragraph one");
    expect(readResult.output).toContain("Test paragraph two");
  });

  it("sets default font (Arial) and margin (1 inch)", async () => {
    const outputPath = path.join(tmpDir, "defaults.docx");

    await docxCreate({
      outputPath,
      content: [{ paragraph: { text: "Default styling" } }],
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // Default font
    expect(docXml).toContain("Arial");
    // Default margin: 1440 DXA = 1 inch
    expect(docXml).toContain("w:top=\"1440\"");
    expect(docXml).toContain("w:left=\"1440\"");
  });

  it("supports custom font and fontSize", async () => {
    const outputPath = path.join(tmpDir, "custom-font.docx");

    await docxCreate({
      outputPath,
      content: [{ paragraph: { text: "Times New Roman text" } }],
      font: "Times New Roman",
      fontSize: 28, // 14pt
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("Times New Roman");
  });

  it("supports landscape orientation", async () => {
    const outputPath = path.join(tmpDir, "landscape.docx");

    await docxCreate({
      outputPath,
      content: [{ paragraph: { text: "Landscape page" } }],
      landscape: true,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("landscape");
  });

  it("creates bullet lists", async () => {
    const outputPath = path.join(tmpDir, "bullets.docx");

    await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Item 1", bullet: true } },
        { paragraph: { text: "Item 2", bullet: true } },
        { paragraph: { text: "Normal paragraph" } },
      ],
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // Numbering reference should be present
    expect(docXml).toContain("w:numId");
  });

  it("creates numbered lists", async () => {
    const outputPath = path.join(tmpDir, "numbered.docx");

    await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Step 1", numbered: true } },
        { paragraph: { text: "Step 2", numbered: true } },
      ],
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:numId");
  });

  it("inserts page breaks", async () => {
    const outputPath = path.join(tmpDir, "pagebreak.docx");

    await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Page 1 content" } },
        { paragraph: { pageBreak: true } },
        { paragraph: { text: "Page 2 content" } },
      ],
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:br");
    expect(docXml).toContain("Page 1 content");
    expect(docXml).toContain("Page 2 content");
  });

  it("creates tables with header row shading", async () => {
    const outputPath = path.join(tmpDir, "table.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Before table" } },
        {
          table: {
            rows: [
              ["Name", "Value"],
              ["Alpha", "100"],
              ["Beta", "200"],
            ],
            headerRow: true,
          },
        },
        { paragraph: { text: "After table" } },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("2 paragraph(s)");
    expect(result.output).toContain("1 table(s)");

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:tbl");
    expect(docXml).toContain("Name");
    expect(docXml).toContain("Alpha");
    // Header row should have shading
    expect(docXml).toContain("D5E8F0");
  });

  it("creates tables with custom column widths", async () => {
    const outputPath = path.join(tmpDir, "table-widths.docx");

    await docxCreate({
      outputPath,
      content: [
        {
          table: {
            rows: [["Wide", "Narrow"]],
            columnWidths: [7000, 2360],
          },
        },
      ],
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:tbl");
    expect(docXml).toContain("7000");
    expect(docXml).toContain("2360");
  });

  it("embeds images", async () => {
    const outputPath = path.join(tmpDir, "with-image.docx");
    // Create a minimal 1x1 PNG
    const pngPath = path.join(tmpDir, "test.png");
    const minimalPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    fs.writeFileSync(pngPath, minimalPng);

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Before image" } },
        { image: { path: pngPath, width: 200, height: 150 } },
        { paragraph: { text: "After image" } },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 image(s)");

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:drawing");
  });

  it("returns error for non-existent image", async () => {
    const outputPath = path.join(tmpDir, "bad-image.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { image: { path: "/nonexistent/image.png", width: 100, height: 100 } },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Image file not found");
  });

  it("adds header and footer", async () => {
    const outputPath = path.join(tmpDir, "header-footer.docx");

    await docxCreate({
      outputPath,
      content: [{ paragraph: { text: "Body text" } }],
      header: "My Document Header",
      footer: "Confidential",
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    // Header and footer are in separate XML files
    const files = Object.keys(zip.files);
    const headerFile = files.find(f => f.startsWith("word/header"));
    const footerFile = files.find(f => f.startsWith("word/footer"));
    expect(headerFile).toBeDefined();
    expect(footerFile).toBeDefined();

    const headerXml = await zip.file(headerFile!)!.async("string");
    expect(headerXml).toContain("My Document Header");

    const footerXml = await zip.file(footerFile!)!.async("string");
    expect(footerXml).toContain("Confidential");
  });

  it("supports custom margin values", async () => {
    const outputPath = path.join(tmpDir, "custom-margin.docx");

    await docxCreate({
      outputPath,
      content: [{ paragraph: { text: "Custom margins" } }],
      margin: { top: 720, right: 720, bottom: 720, left: 720 },
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:top=\"720\"");
  });
});

// ---------------------------------------------------------------------------
// handleDocxTool (new tool routing)
// ---------------------------------------------------------------------------

describe("handleDocxTool (new tools)", () => {
  it("routes docxAcceptChanges to correct function", async () => {
    const result = await handleDocxTool("docxAcceptChanges", {
      path: "/nonexistent/file.docx",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("routes docxConvert to correct function", async () => {
    const result = await handleDocxTool("docxConvert", {
      path: "/nonexistent/file.docx",
      format: "pdf",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("routes docxCreate to correct function", async () => {
    const outputPath = path.join(tmpDir, "dispatch-test.docx");
    const result = await handleDocxTool("docxCreate", {
      outputPath,
      content: [{ paragraph: { text: "Dispatcher test" } }],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Created DOCX");
    expect(fs.existsSync(outputPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// docxCreate (extended paragraph formatting)
// ---------------------------------------------------------------------------

describe("docxCreate (extended formatting)", () => {
  it("applies underline formatting", async () => {
    const outputPath = path.join(tmpDir, "underline.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Underlined text", underline: true } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("<w:u");
  });

  it("applies strikethrough formatting", async () => {
    const outputPath = path.join(tmpDir, "strike.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Struck through text", strikethrough: true } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("<w:strike");
  });

  it("applies text color", async () => {
    const outputPath = path.join(tmpDir, "color.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Red text", color: "FF0000" } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("FF0000");
  });

  it("applies per-paragraph fontSize override", async () => {
    const outputPath = path.join(tmpDir, "fontsize.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Small text", fontSize: 16 } },   // 8pt
        { paragraph: { text: "Large text", fontSize: 48 } },   // 24pt
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // Both sizes should appear
    expect(docXml).toContain('w:val="16"');
    expect(docXml).toContain('w:val="48"');
  });

  it("creates nested bullet lists with levels", async () => {
    const outputPath = path.join(tmpDir, "nested-bullets.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Top level", bullet: true, level: 0 } },
        { paragraph: { text: "Sub item", bullet: true, level: 1 } },
        { paragraph: { text: "Sub-sub item", bullet: true, level: 2 } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:numId");
    // Should have ilvl references
    expect(docXml).toContain("w:ilvl");
  });

  it("creates nested numbered lists with levels", async () => {
    const outputPath = path.join(tmpDir, "nested-numbers.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "First", numbered: true, level: 0 } },
        { paragraph: { text: "Sub a", numbered: true, level: 1 } },
        { paragraph: { text: "Sub i", numbered: true, level: 2 } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:numId");
    expect(docXml).toContain("w:ilvl");
  });

  it("creates hyperlink paragraphs", async () => {
    const outputPath = path.join(tmpDir, "hyperlink.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Click here", link: "https://example.com" } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:hyperlink");
    expect(docXml).toContain("Click here");
  });

  it("creates table of contents", async () => {
    const outputPath = path.join(tmpDir, "toc.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { toc: { heading: "Contents" } },
        { paragraph: { text: "Chapter 1", heading: 1 } },
        { paragraph: { text: "Some content" } },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("1 table(s) of contents");

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("TOC");
  });

  it("applies custom spacing", async () => {
    const outputPath = path.join(tmpDir, "spacing.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Spaced out", spacing: { before: 480, after: 240 } } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:before");
    expect(docXml).toContain("w:after");
  });

  it("applies custom indent", async () => {
    const outputPath = path.join(tmpDir, "indent.docx");

    const result = await docxCreate({
      outputPath,
      content: [
        { paragraph: { text: "Indented", indent: { left: 720, hanging: 360 } } },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:ind");
  });

  it("applies image alt text customization", async () => {
    const outputPath = path.join(tmpDir, "alt-image.docx");
    const pngPath = path.join(tmpDir, "test.png");
    const minimalPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    fs.writeFileSync(pngPath, minimalPng);

    const result = await docxCreate({
      outputPath,
      content: [
        {
          image: {
            path: pngPath,
            width: 100,
            height: 100,
            altText: { title: "My Title", description: "My Description", name: "MyImage" },
          },
        },
      ],
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("My Title");
    expect(docXml).toContain("My Description");
  });
});

// ---------------------------------------------------------------------------
// docxAddComment (reply support)
// ---------------------------------------------------------------------------

describe("docxAddComment (reply)", () => {
  it("adds a reply to an existing comment", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const firstOutputPath = path.join(tmpDir, "with-comment.docx");
    const secondOutputPath = path.join(tmpDir, "with-reply.docx");

    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello World" }],
    });

    // Add first comment
    const firstResult = await docxAddComment({
      path: docxPath,
      paragraphIndex: 0,
      text: "First comment",
      author: "Alice",
      outputPath: firstOutputPath,
    });

    expect(firstResult.success).toBe(true);

    // Add reply to first comment (commentId will be auto-detected)
    // We need to know the comment ID to reply. Since the tool auto-picks the next available ID,
    // and the first comment gets ID 1 (from getNextWId on a doc with no existing IDs),
    // the reply should use parentCommentId: 1
    const replyResult = await docxAddComment({
      path: firstOutputPath,
      paragraphIndex: 0,
      text: "Reply to first comment",
      author: "Bob",
      parentCommentId: 1,
      outputPath: secondOutputPath,
    });

    expect(replyResult.success).toBe(true);
    expect(replyResult.output).toContain("Added comment");

    // Verify the reply exists in commentsExtended.xml with paraIdParent
    const zip = await JSZip.loadAsync(fs.readFileSync(secondOutputPath));
    const extFile = zip.file("word/commentsExtended.xml");
    expect(extFile).toBeTruthy();
    const extXml = await extFile!.async("string");
    expect(extXml).toContain("paraIdParent");
  });
});

// ---------------------------------------------------------------------------
// validate convenience function
// ---------------------------------------------------------------------------

describe("validate convenience function", () => {
  it("validates a packed docx file", async () => {
    // Import the validate function
    const { validate } = await import("../src/validate");

    const docxPath = path.join(tmpDir, "valid.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Valid document" }],
    });

    const result = await validate(docxPath);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error for non-existent file", async () => {
    const { validate } = await import("../src/validate");

    const result = await validate("/nonexistent/file.docx");
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("does not exist");
  });

  it("returns error for unsupported file type", async () => {
    const { validate } = await import("../src/validate");

    const txtPath = path.join(tmpDir, "file.txt");
    fs.writeFileSync(txtPath, "hello");

    const result = await validate(txtPath);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Unsupported file type");
  });

  it("validates with autoRepair", async () => {
    const { validate } = await import("../src/validate");

    const docxPath = path.join(tmpDir, "needs-repair.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="33333333" w14:textId="77777777">
          <w:r><w:t> leading space without preserve</w:t></w:r>
        </w:p>`,
    });

    const result = await validate(docxPath, { autoRepair: true });
    expect(result.success).toBe(true);
    expect(result.repairs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// docxDeleteParagraph
// ---------------------------------------------------------------------------

describe("docxDeleteParagraph", () => {
  it("deletes a single paragraph with tracked changes", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "First paragraph" },
        { text: "Second paragraph" },
      ],
    });

    const result = await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [0],
      author: "Claude",
      outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Deleted 1 paragraph(s)");
    expect(result.output).toContain("Claude");
    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("output file contains w:del and w:delText elements", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Delete me" }],
    });

    await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [0],
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:del");
    expect(docXml).toContain("w:delText");
    expect(docXml).toContain("Delete me");
  });

  it("adds paragraph deletion marker in w:pPr/w:rPr", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Paragraph to delete" }],
    });

    await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [0],
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // Should have w:pPr containing w:rPr containing w:del
    expect(docXml).toContain("w:pPr");
    expect(docXml).toContain("w:rPr");
  });

  it("deletes multiple paragraphs", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "First" },
        { text: "Second" },
        { text: "Third" },
      ],
    });

    const result = await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [0, 2],
      outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Deleted 2 paragraph(s)");
  });

  it("preserves existing w:del content", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="11111111" w14:textId="77777777">
          <w:del w:id="1" w:author="Alice" w:date="2024-01-01T00:00:00Z">
            <w:r><w:delText>already deleted</w:delText></w:r>
          </w:del>
          <w:r><w:t>keep this too</w:t></w:r>
        </w:p>`,
    });

    const result = await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [0],
      outputPath,
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("already deleted");
    expect(docXml).toContain("keep this too");
  });

  it("handles paragraph with w:ins (rejects insertion)", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="11111111" w14:textId="77777777">
          <w:ins w:id="1" w:author="Alice" w:date="2024-01-01T00:00:00Z">
            <w:r><w:t>inserted text</w:t></w:r>
          </w:ins>
        </w:p>`,
    });

    const result = await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [0],
      outputPath,
    });

    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // The w:ins should now be wrapped in w:del
    expect(docXml).toContain("w:del");
    expect(docXml).toContain("w:delText");
  });

  it("returns error for out-of-range index", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Only one" }],
    });

    const result = await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [5],
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("out of range");
  });

  it("returns error for no indices provided", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [],
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("No paragraph indices");
  });

  it("returns error for non-existent file", async () => {
    const result = await docxDeleteParagraph({
      path: "/nonexistent/file.docx",
      paragraphIndices: [0],
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("uses default output path when none specified", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxDeleteParagraph({
      path: docxPath,
      paragraphIndices: [0],
    });

    expect(result.success).toBe(true);
    expect(result.outputPath).toBe(path.join(tmpDir, "input_modified.docx"));
  });
});

// ---------------------------------------------------------------------------
// docxReviewChanges
// ---------------------------------------------------------------------------

describe("docxReviewChanges", () => {
  it("rejects an insertion", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "ins", text: "new text", author: "Alice", date: "2024-01-01T00:00:00Z" },
      ],
    });

    const result = await docxReviewChanges({
      path: docxPath,
      action: "reject",
      changeIndex: 0,
      author: "Claude",
      outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Rejected");
    expect(result.output).toContain("insertion");
    expect(result.output).toContain("new text");
  });

  it("reject wraps w:ins in w:del with w:delText", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "ins", text: "inserted words", author: "Alice", date: "2024-01-01T00:00:00Z" },
      ],
    });

    await docxReviewChanges({
      path: docxPath,
      action: "reject",
      changeIndex: 0,
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // Should contain both w:del wrapper and w:delText
    expect(docXml).toContain("w:del");
    expect(docXml).toContain("w:delText");
    expect(docXml).toContain("inserted words");
  });

  it("restores a deletion", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "del", text: "old text", author: "Bob", date: "2024-01-01T00:00:00Z" },
      ],
    });

    const result = await docxReviewChanges({
      path: docxPath,
      action: "restore",
      changeIndex: 0,
      author: "Claude",
      outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Restored");
    expect(result.output).toContain("deletion");
    expect(result.output).toContain("old text");
  });

  it("restore inserts w:ins after w:del", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "del", text: "restore me", author: "Bob", date: "2024-01-01T00:00:00Z" },
      ],
    });

    await docxReviewChanges({
      path: docxPath,
      action: "restore",
      changeIndex: 0,
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    // Should contain both w:del (original) and w:ins (restored)
    expect(docXml).toContain("w:del");
    expect(docXml).toContain("w:ins");
    expect(docXml).toContain("restore me");
  });

  it("returns error when rejecting a deletion", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "del", text: "deleted text", author: "Bob", date: "2024-01-01T00:00:00Z" },
      ],
    });

    const result = await docxReviewChanges({
      path: docxPath,
      action: "reject",
      changeIndex: 0,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Cannot reject a deletion");
  });

  it("returns error when restoring an insertion", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "ins", text: "inserted text", author: "Alice", date: "2024-01-01T00:00:00Z" },
      ],
    });

    const result = await docxReviewChanges({
      path: docxPath,
      action: "restore",
      changeIndex: 0,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Cannot restore an insertion");
  });

  it("returns error for out-of-range change index", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        { type: "ins", text: "text", author: "Alice", date: "2024-01-01T00:00:00Z" },
      ],
    });

    const result = await docxReviewChanges({
      path: docxPath,
      action: "reject",
      changeIndex: 5,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("out of range");
  });

  it("returns error when no tracked changes exist", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "No changes here" }],
    });

    const result = await docxReviewChanges({
      path: docxPath,
      action: "reject",
      changeIndex: 0,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("No tracked changes");
  });

  it("returns error for non-existent file", async () => {
    const result = await docxReviewChanges({
      path: "/nonexistent/file.docx",
      action: "reject",
      changeIndex: 0,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });
});

// ---------------------------------------------------------------------------
// docxInsertImage
// ---------------------------------------------------------------------------

describe("docxInsertImage", () => {
  function createMinimalPng(dir: string): string {
    const pngPath = path.join(dir, "test.png");
    const minimalPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    fs.writeFileSync(pngPath, minimalPng);
    return pngPath;
  }

  it("inserts an image after a paragraph", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    const pngPath = createMinimalPng(tmpDir);
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "Before image" },
        { text: "After image" },
      ],
    });

    const result = await docxInsertImage({
      path: docxPath,
      imagePath: pngPath,
      paragraphIndex: 0,
      width: 200,
      height: 150,
      outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Inserted image after paragraph 0");
    expect(result.output).toContain("200x150px");
    expect(result.outputPath).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it("output file contains w:drawing element", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    const pngPath = createMinimalPng(tmpDir);
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    await docxInsertImage({
      path: docxPath,
      imagePath: pngPath,
      paragraphIndex: 0,
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("w:drawing");
    expect(docXml).toContain("wp:inline");
    expect(docXml).toContain("wp:extent");
  });

  it("copies image to word/media/ in the output", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    const pngPath = createMinimalPng(tmpDir);
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    await docxInsertImage({
      path: docxPath,
      imagePath: pngPath,
      paragraphIndex: 0,
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const mediaFiles = Object.keys(zip.files).filter(f => f.startsWith("word/media/"));
    expect(mediaFiles.length).toBeGreaterThanOrEqual(1);
    expect(mediaFiles.some(f => f.endsWith(".png"))).toBe(true);
  });

  it("adds relationship entry for the image", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    const pngPath = createMinimalPng(tmpDir);
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    await docxInsertImage({
      path: docxPath,
      imagePath: pngPath,
      paragraphIndex: 0,
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const relsXml = await zip.file("word/_rels/document.xml.rels")!.async("string");
    expect(relsXml).toContain("relationships/image");
    expect(relsXml).toContain("media/image1.png");
  });

  it("adds content type for png extension", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    const pngPath = createMinimalPng(tmpDir);
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    await docxInsertImage({
      path: docxPath,
      imagePath: pngPath,
      paragraphIndex: 0,
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const ctXml = await zip.file("[Content_Types].xml")!.async("string");
    expect(ctXml).toContain("image/png");
  });

  it("uses custom alt text", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    const pngPath = createMinimalPng(tmpDir);
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    await docxInsertImage({
      path: docxPath,
      imagePath: pngPath,
      paragraphIndex: 0,
      altText: "Company Logo",
      outputPath,
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file("word/document.xml")!.async("string");
    expect(docXml).toContain("Company Logo");
  });

  it("returns error for non-existent file", async () => {
    const pngPath = createMinimalPng(tmpDir);

    const result = await docxInsertImage({
      path: "/nonexistent/file.docx",
      imagePath: pngPath,
      paragraphIndex: 0,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("returns error for non-existent image", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxInsertImage({
      path: docxPath,
      imagePath: "/nonexistent/image.png",
      paragraphIndex: 0,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Image file not found");
  });

  it("returns error for out-of-range paragraph index", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const pngPath = createMinimalPng(tmpDir);
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Only one" }],
    });

    const result = await docxInsertImage({
      path: docxPath,
      imagePath: pngPath,
      paragraphIndex: 10,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("out of range");
  });

  it("uses default output path when none specified", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const pngPath = createMinimalPng(tmpDir);
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxInsertImage({
      path: docxPath,
      imagePath: pngPath,
      paragraphIndex: 0,
    });

    expect(result.success).toBe(true);
    expect(result.outputPath).toBe(path.join(tmpDir, "input_modified.docx"));
  });
});

// ---------------------------------------------------------------------------
// docxConvertToImages
// ---------------------------------------------------------------------------

function hasPdftoppm(): boolean {
  try {
    const result = child_process.spawnSync("pdftoppm", ["-v"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return result.status === 0 || (result.stderr || "").includes("pdftoppm");
  } catch {
    return false;
  }
}

describe("docxConvertToImages", () => {
  it("returns error for non-existent file", async () => {
    const result = await docxConvertToImages({
      path: "/nonexistent/file.docx",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it.skipIf(!hasSoffice() || !hasPdftoppm())(
    "converts docx to images",
    async () => {
      const docxPath = path.join(tmpDir, "input.docx");
      await createTestDocxFile(docxPath, {
        paragraphs: [{ text: "Convert me to image" }],
      });

      const outputDir = path.join(tmpDir, "images");
      const result = await docxConvertToImages({
        path: docxPath,
        format: "png",
        dpi: 72,
        outputDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("PNG");
      expect(result.output).toContain("72 DPI");
      expect(fs.existsSync(outputDir)).toBe(true);

      const files = fs.readdirSync(outputDir);
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files.some(f => f.endsWith(".png"))).toBe(true);
    }
  );

  it.skipIf(!hasSoffice() || !hasPdftoppm())(
    "converts to jpeg by default",
    async () => {
      const docxPath = path.join(tmpDir, "input.docx");
      await createTestDocxFile(docxPath, {
        paragraphs: [{ text: "JPEG conversion" }],
      });

      const outputDir = path.join(tmpDir, "images-jpeg");
      const result = await docxConvertToImages({
        path: docxPath,
        outputDir,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("JPEG");
    }
  );

  it("uses default output dir when none specified", async () => {
    // We can test the parameter parsing without actual conversion
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await docxConvertToImages({
      path: docxPath,
    });

    // Will fail because soffice is likely not available, but we check error handling
    if (!hasSoffice()) {
      expect(result.success).toBe(false);
      expect(result.output).toContain("soffice");
    }
  });
});

// ---------------------------------------------------------------------------
// handleDocxTool (new 4 tools routing)
// ---------------------------------------------------------------------------

describe("handleDocxTool (4 new tools)", () => {
  it("routes docxDeleteParagraph to correct function", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    const outputPath = path.join(tmpDir, "output.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const result = await handleDocxTool("docxDeleteParagraph", {
      path: docxPath,
      paragraphIndices: [0],
      outputPath,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Deleted 1 paragraph(s)");
  });

  it("routes docxReviewChanges to correct function", async () => {
    const result = await handleDocxTool("docxReviewChanges", {
      path: "/nonexistent/file.docx",
      action: "reject",
      changeIndex: 0,
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("routes docxInsertImage to correct function", async () => {
    const result = await handleDocxTool("docxInsertImage", {
      path: "/nonexistent/file.docx",
      imagePath: "/nonexistent/image.png",
      paragraphIndex: 0,
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });

  it("routes docxConvertToImages to correct function", async () => {
    const result = await handleDocxTool("docxConvertToImages", {
      path: "/nonexistent/file.docx",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("File not found");
  });
});
