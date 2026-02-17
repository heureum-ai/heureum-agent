import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { BaseSchemaValidator } from "../src/validators/base";
import {
  createTestDocxBuffer,
  unpackDocxToDir,
} from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validators-base-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("BaseSchemaValidator", () => {
  it("finds XML files in unpacked directory", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const validator = new BaseSchemaValidator(tmpDir);
    expect(validator.xmlFiles.length).toBeGreaterThan(0);
  });

  it("validateXml passes for well-formed XML", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const validator = new BaseSchemaValidator(tmpDir);
    expect(validator.validateXml().valid).toBe(true);
  });

  it("validateXml fails for malformed XML", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    // Corrupt a file
    const docXml = path.join(tmpDir, "word", "document.xml");
    fs.writeFileSync(docXml, "<broken><xml", "utf-8");

    const validator = new BaseSchemaValidator(tmpDir);
    expect(validator.validateXml().valid).toBe(false);
  });

  it("validateNamespaces passes for valid namespaces", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const validator = new BaseSchemaValidator(tmpDir);
    expect(validator.validateNamespaces().valid).toBe(true);
  });

  it("repairWhitespacePreservation adds xml:space to t elements", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:t> leading space</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    // Remove xml:space="preserve" if present
    const docXml = path.join(tmpDir, "word", "document.xml");
    let content = fs.readFileSync(docXml, "utf-8");
    content = content.replace(/xml:space="preserve"/g, "");
    fs.writeFileSync(docXml, content, "utf-8");

    const validator = new BaseSchemaValidator(tmpDir);
    const repairs = validator.repairWhitespacePreservation();
    expect(repairs).toBeGreaterThanOrEqual(1);

    const repairedContent = fs.readFileSync(docXml, "utf-8");
    expect(repairedContent).toContain("preserve");
  });

  it("validateContentTypes passes for valid content types", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const validator = new BaseSchemaValidator(tmpDir);
    expect(validator.validateContentTypes().valid).toBe(true);
  });
});
