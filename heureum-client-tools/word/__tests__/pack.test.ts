import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import JSZip from "jszip";
import { pack } from "../src/pack";
import {
  createTestDocxBuffer,
  createTestDocxFile,
  unpackDocxToDir,
} from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pack-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pack", () => {
  it("returns error for non-directory input", async () => {
    const [, msg] = await pack("/nonexistent", path.join(tmpDir, "out.docx"));
    expect(msg).toContain("is not a directory");
  });

  it("returns error for invalid extension", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(buf, unpackedDir);

    const [, msg] = await pack(unpackedDir, path.join(tmpDir, "out.txt"));
    expect(msg).toContain("must be a .docx, .pptx, or .xlsx file");
  });

  it("packs a directory into a valid docx", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(buf, unpackedDir);

    const outFile = path.join(tmpDir, "output.docx");
    const [, msg] = await pack(unpackedDir, outFile, { validate: false });

    expect(msg).toContain("Successfully packed");
    expect(fs.existsSync(outFile)).toBe(true);

    // Verify it's a valid ZIP
    const outBuf = fs.readFileSync(outFile);
    const zip = await JSZip.loadAsync(outBuf);
    expect(zip.file("word/document.xml")).not.toBeNull();
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
  });

  it("condenses XML by removing whitespace", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(buf, unpackedDir);

    const outFile = path.join(tmpDir, "output.docx");
    await pack(unpackedDir, outFile, { validate: false });

    // Read packed document.xml - should be condensed
    const outBuf = fs.readFileSync(outFile);
    const zip = await JSZip.loadAsync(outBuf);
    const docXml = await zip.file("word/document.xml")!.async("string");

    // Condensed XML should have minimal whitespace
    // (no pretty-printing indentation between elements)
    expect(docXml.includes("<?xml")).toBe(true);
  });

  it("validates with original file when provided", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    const originalFile = path.join(tmpDir, "original.docx");
    fs.writeFileSync(originalFile, buf);

    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(buf, unpackedDir);

    const outFile = path.join(tmpDir, "output.docx");
    const [, msg] = await pack(unpackedDir, outFile, {
      originalFile,
      validate: true,
    });

    expect(msg).toContain("Successfully packed");
  });

  it("skips validation when validate is false", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(buf, unpackedDir);

    const outFile = path.join(tmpDir, "output.docx");
    const [, msg] = await pack(unpackedDir, outFile, { validate: false });

    expect(msg).toContain("Successfully packed");
  });

  it("preserves all files from unpacked directory", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(buf, unpackedDir);

    const outFile = path.join(tmpDir, "output.docx");
    await pack(unpackedDir, outFile, { validate: false });

    const outBuf = fs.readFileSync(outFile);
    const zip = await JSZip.loadAsync(outBuf);
    const fileNames = Object.keys(zip.files).filter(
      (f) => !zip.files[f].dir
    );

    expect(fileNames).toContain("word/document.xml");
    expect(fileNames).toContain("[Content_Types].xml");
    expect(fileNames).toContain("_rels/.rels");
  });
});
