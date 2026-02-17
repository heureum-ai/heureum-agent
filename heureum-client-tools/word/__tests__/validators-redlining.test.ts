import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { RedliningValidator } from "../src/validators/redlining";
import {
  createTestDocxBuffer,
  createTestDocxFile,
  unpackDocxToDir,
} from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "validators-redlining-test-")
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("RedliningValidator", () => {
  it("passes when no tracked changes exist", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    const originalDocx = path.join(tmpDir, "original.docx");
    const unpackedDir = path.join(tmpDir, "unpacked");

    fs.writeFileSync(originalDocx, buf);
    await unpackDocxToDir(buf, unpackedDir);

    const v = new RedliningValidator(unpackedDir, originalDocx, false, "Claude");
    expect((await v.validate()).valid).toBe(true);
  });

  it("passes when tracked changes are properly tracked", async () => {
    // Original document with just "Hello World"
    const origBuf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    const originalDocx = path.join(tmpDir, "original.docx");
    fs.writeFileSync(originalDocx, origBuf);

    // Modified document with properly tracked insertion by Claude
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:t>Hello World</w:t></w:r>
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t> added text</w:t></w:r>
      </w:ins>
    </w:p>`;

    const modBuf = await createTestDocxBuffer({ rawBody });
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(modBuf, unpackedDir);

    const v = new RedliningValidator(unpackedDir, originalDocx, false, "Claude");
    expect((await v.validate()).valid).toBe(true);
  });

  it("fails when modifications are not tracked", async () => {
    // Original document with "Hello World"
    const origBuf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    const originalDocx = path.join(tmpDir, "original.docx");
    fs.writeFileSync(originalDocx, origBuf);

    // Modified document: same author has ins but text doesn't match after removal
    // This simulates untracked modification - text is different without proper tracking
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:t>Changed Text</w:t></w:r>
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t> something</w:t></w:r>
      </w:ins>
    </w:p>`;

    const modBuf = await createTestDocxBuffer({ rawBody });
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(modBuf, unpackedDir);

    const v = new RedliningValidator(unpackedDir, originalDocx, false, "Claude");
    // After removing Claude's ins, we get "Changed Text" which != "Hello World"
    expect((await v.validate()).valid).toBe(false);
  });

  it("fails when document.xml is missing", async () => {
    const origBuf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    const originalDocx = path.join(tmpDir, "original.docx");
    fs.writeFileSync(originalDocx, origBuf);

    const unpackedDir = path.join(tmpDir, "unpacked");
    fs.mkdirSync(path.join(unpackedDir, "word"), { recursive: true });

    const v = new RedliningValidator(unpackedDir, originalDocx);
    expect((await v.validate()).valid).toBe(false);
  });

  it("properly handles deletion tracking", async () => {
    // Original document with "Hello World"
    const origBuf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    const originalDocx = path.join(tmpDir, "original.docx");
    fs.writeFileSync(originalDocx, origBuf);

    // Modified: Claude deleted "World" using proper tracking
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:t>Hello </w:t></w:r>
      <w:del w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:delText>World</w:delText></w:r>
      </w:del>
    </w:p>`;

    const modBuf = await createTestDocxBuffer({ rawBody });
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(modBuf, unpackedDir);

    const v = new RedliningValidator(unpackedDir, originalDocx, false, "Claude");
    // After removing Claude's del (promoting delText->t), text = "Hello World" which matches
    expect((await v.validate()).valid).toBe(true);
  });

  it("repair returns 0", () => {
    const v = new RedliningValidator(tmpDir, tmpDir);
    expect(v.repair()).toBe(0);
  });
});
