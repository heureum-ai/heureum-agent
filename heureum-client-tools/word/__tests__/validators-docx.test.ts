import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DOCXSchemaValidator } from "../src/validators/docx";
import {
  createTestDocxBuffer,
  unpackDocxToDir,
} from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validators-docx-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("DOCXSchemaValidator", () => {
  it("validateWhitespacePreservation passes when all ok", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:t>No leading or trailing spaces</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.validateWhitespacePreservation().valid).toBe(true);
  });

  it("validateWhitespacePreservation fails for missing xml:space", async () => {
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

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.validateWhitespacePreservation().valid).toBe(false);
  });

  it("validateDeletions passes when no w:t in w:del", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:del w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:delText>Deleted text</w:delText></w:r>
      </w:del>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.validateDeletions().valid).toBe(true);
  });

  it("validateDeletions fails when w:t is inside w:del", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:del w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>This should not be here</w:t></w:r>
      </w:del>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.validateDeletions().valid).toBe(false);
  });

  it("validateInsertions passes when no w:delText in w:ins", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>Inserted text</w:t></w:r>
      </w:ins>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.validateInsertions().valid).toBe(true);
  });

  it("validateIdConstraints passes for valid IDs", async () => {
    const rawBody = `<w:p w14:paraId="0000ABCD" w14:textId="77777777">
      <w:r><w:t>Hello</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.validateIdConstraints().valid).toBe(true);
  });

  it("validateIdConstraints fails for paraId >= 0x80000000", async () => {
    const rawBody = `<w:p w14:paraId="FFFFFFFF" w14:textId="77777777">
      <w:r><w:t>Hello</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.validateIdConstraints().valid).toBe(false);
  });

  it("validateCommentMarkers passes when no comments", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.validateCommentMarkers().valid).toBe(true);
  });

  it("countParagraphsInUnpacked counts paragraphs correctly", async () => {
    const rawBody = `
      <w:p w14:paraId="00000001" w14:textId="77777777"><w:r><w:t>One</w:t></w:r></w:p>
      <w:p w14:paraId="00000002" w14:textId="77777777"><w:r><w:t>Two</w:t></w:r></w:p>
      <w:p w14:paraId="00000003" w14:textId="77777777"><w:r><w:t>Three</w:t></w:r></w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    expect(v.countParagraphsInUnpacked()).toBe(3);
  });

  it("repairDurableId fixes out-of-range values", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777" w16cid:durableId="FFFFFFFF">
      <w:r><w:t>Hello</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const v = new DOCXSchemaValidator(tmpDir);
    const repairs = v.repairDurableId();
    expect(repairs).toBeGreaterThanOrEqual(1);
  });
});
