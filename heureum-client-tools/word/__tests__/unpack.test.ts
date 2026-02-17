import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { unpack } from "../src/unpack";
import { createTestDocxFile } from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unpack-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("unpack", () => {
  it("returns error for non-existent file", async () => {
    const [, msg] = await unpack("/nonexistent.docx", tmpDir);
    expect(msg).toContain("does not exist");
  });

  it("returns error for invalid extension", async () => {
    const txtFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(txtFile, "hello");
    const outDir = path.join(tmpDir, "out");
    const [, msg] = await unpack(txtFile, outDir);
    expect(msg).toContain("must be a .docx, .pptx, or .xlsx file");
  });

  it("unpacks a valid docx file", async () => {
    const docxPath = path.join(tmpDir, "test.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello World" }],
    });

    const outDir = path.join(tmpDir, "unpacked");
    const [, msg] = await unpack(docxPath, outDir);

    expect(msg).toContain("Unpacked");
    expect(msg).toContain("XML files");
    expect(fs.existsSync(path.join(outDir, "word", "document.xml"))).toBe(
      true
    );
    expect(fs.existsSync(path.join(outDir, "[Content_Types].xml"))).toBe(true);
  });

  it("pretty-prints XML files", async () => {
    const docxPath = path.join(tmpDir, "test.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Test" }],
    });

    const outDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, outDir);

    const docXml = fs.readFileSync(
      path.join(outDir, "word", "document.xml"),
      "utf-8"
    );
    // Pretty-printed XML should have indentation
    expect(docXml).toContain("\n");
  });

  it("runs merge-runs on DOCX files by default", async () => {
    const docxPath = path.join(tmpDir, "test.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const outDir = path.join(tmpDir, "unpacked");
    const [, msg] = await unpack(docxPath, outDir);

    expect(msg).toContain("merged");
  });

  it("runs simplify-redlines on DOCX files by default", async () => {
    const docxPath = path.join(tmpDir, "test.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const outDir = path.join(tmpDir, "unpacked");
    const [, msg] = await unpack(docxPath, outDir);

    expect(msg).toContain("simplified");
  });

  it("can skip merge-runs with option", async () => {
    const docxPath = path.join(tmpDir, "test.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const outDir = path.join(tmpDir, "unpacked");
    const [, msg] = await unpack(docxPath, outDir, { mergeRuns: false });

    expect(msg).not.toContain("merged");
  });

  it("escapes smart quotes", async () => {
    const docxPath = path.join(tmpDir, "test.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello \u201cWorld\u201d" }],
    });

    const outDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, outDir);

    const docXml = fs.readFileSync(
      path.join(outDir, "word", "document.xml"),
      "utf-8"
    );
    expect(docXml).not.toContain("\u201c");
    expect(docXml).not.toContain("\u201d");
  });
});
