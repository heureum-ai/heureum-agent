import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { mergeRuns } from "../src/helpers/merge-runs";
import {
  createTestDocxBuffer,
  unpackDocxToDir,
} from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-runs-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mergeRuns", () => {
  it("returns error when document.xml not found", () => {
    const [count, msg] = mergeRuns(tmpDir);
    expect(count).toBe(0);
    expect(msg).toContain("not found");
  });

  it("returns 0 merges for a single run paragraph", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const [count, msg] = mergeRuns(tmpDir);
    expect(count).toBe(0);
    expect(msg).toBe("Merged 0 runs");
  });

  it("merges adjacent runs with identical formatting", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:t>Hello </w:t></w:r>
      <w:r><w:t>World</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count, msg] = mergeRuns(tmpDir);
    expect(count).toBe(1);
    expect(msg).toBe("Merged 1 runs");

    // Verify the output has merged text
    const docXml = fs.readFileSync(
      path.join(tmpDir, "word", "document.xml"),
      "utf-8"
    );
    // Should contain the merged text
    expect(docXml).toContain("Hello ");
    expect(docXml).toContain("World");
  });

  it("does not merge runs with different formatting", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r>
      <w:r><w:t>Normal</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = mergeRuns(tmpDir);
    expect(count).toBe(0);
  });

  it("merges runs with matching bold formatting", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:rPr><w:b/></w:rPr><w:t>Hello </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>World</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = mergeRuns(tmpDir);
    expect(count).toBe(1);
  });

  it("removes proofErr elements", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:t>Hello</w:t></w:r>
      <w:proofErr w:type="spellStart"/>
      <w:r><w:t> World</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    mergeRuns(tmpDir);

    const docXml = fs.readFileSync(
      path.join(tmpDir, "word", "document.xml"),
      "utf-8"
    );
    expect(docXml).not.toContain("proofErr");
  });

  it("strips rsid attributes from runs", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r w:rsidR="00A12345"><w:t>Hello</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    mergeRuns(tmpDir);

    const docXml = fs.readFileSync(
      path.join(tmpDir, "word", "document.xml"),
      "utf-8"
    );
    expect(docXml).not.toContain("rsid");
  });

  it("merges multiple adjacent runs", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:r><w:t>A</w:t></w:r>
      <w:r><w:t>B</w:t></w:r>
      <w:r><w:t>C</w:t></w:r>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = mergeRuns(tmpDir);
    expect(count).toBe(2);
  });

  it("handles runs inside tracked changes", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Author" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>Hello </w:t></w:r>
        <w:r><w:t>World</w:t></w:r>
      </w:ins>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = mergeRuns(tmpDir);
    expect(count).toBe(1);
  });
});
