import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  simplifyRedlines,
  getTrackedChangeAuthors,
  inferAuthor,
} from "../src/helpers/simplify-redlines";
import {
  createTestDocxBuffer,
  createTestDocxFile,
  unpackDocxToDir,
} from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "simplify-redlines-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("simplifyRedlines", () => {
  it("returns error when document.xml not found", () => {
    const [count, msg] = simplifyRedlines(tmpDir);
    expect(count).toBe(0);
    expect(msg).toContain("not found");
  });

  it("returns 0 when no tracked changes", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const [count, msg] = simplifyRedlines(tmpDir);
    expect(count).toBe(0);
    expect(msg).toBe("Simplified 0 tracked changes");
  });

  it("merges adjacent insertions from same author", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>Hello </w:t></w:r>
      </w:ins>
      <w:ins w:id="2" w:author="Claude" w:date="2024-01-01T00:00:01Z">
        <w:r><w:t>World</w:t></w:r>
      </w:ins>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = simplifyRedlines(tmpDir);
    expect(count).toBe(1);
  });

  it("merges adjacent deletions from same author", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:del w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:delText>Hello </w:delText></w:r>
      </w:del>
      <w:del w:id="2" w:author="Claude" w:date="2024-01-01T00:00:01Z">
        <w:r><w:delText>World</w:delText></w:r>
      </w:del>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = simplifyRedlines(tmpDir);
    expect(count).toBe(1);
  });

  it("does not merge changes from different authors", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>Hello </w:t></w:r>
      </w:ins>
      <w:ins w:id="2" w:author="Bob" w:date="2024-01-01T00:00:01Z">
        <w:r><w:t>World</w:t></w:r>
      </w:ins>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = simplifyRedlines(tmpDir);
    expect(count).toBe(0);
  });

  it("does not merge ins with del", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>Hello </w:t></w:r>
      </w:ins>
      <w:del w:id="2" w:author="Claude" w:date="2024-01-01T00:00:01Z">
        <w:r><w:delText>World</w:delText></w:r>
      </w:del>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = simplifyRedlines(tmpDir);
    expect(count).toBe(0);
  });

  it("does not merge non-adjacent changes (element between)", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>Hello </w:t></w:r>
      </w:ins>
      <w:r><w:t>separator</w:t></w:r>
      <w:ins w:id="2" w:author="Claude" w:date="2024-01-01T00:00:01Z">
        <w:r><w:t>World</w:t></w:r>
      </w:ins>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = simplifyRedlines(tmpDir);
    expect(count).toBe(0);
  });

  it("merges multiple adjacent changes in sequence", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>A</w:t></w:r>
      </w:ins>
      <w:ins w:id="2" w:author="Claude" w:date="2024-01-01T00:00:01Z">
        <w:r><w:t>B</w:t></w:r>
      </w:ins>
      <w:ins w:id="3" w:author="Claude" w:date="2024-01-01T00:00:02Z">
        <w:r><w:t>C</w:t></w:r>
      </w:ins>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const [count] = simplifyRedlines(tmpDir);
    expect(count).toBe(2);
  });
});

describe("getTrackedChangeAuthors", () => {
  it("returns empty for non-existent file", () => {
    const authors = getTrackedChangeAuthors("/nonexistent/file.xml");
    expect(authors).toEqual({});
  });

  it("counts authors from tracked changes", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Claude" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>A</w:t></w:r>
      </w:ins>
      <w:del w:id="2" w:author="Claude" w:date="2024-01-01T00:00:01Z">
        <w:r><w:delText>B</w:delText></w:r>
      </w:del>
      <w:ins w:id="3" w:author="Bob" w:date="2024-01-01T00:00:02Z">
        <w:r><w:t>C</w:t></w:r>
      </w:ins>
    </w:p>`;

    const buf = await createTestDocxBuffer({ rawBody });
    await unpackDocxToDir(buf, tmpDir);

    const authors = getTrackedChangeAuthors(
      path.join(tmpDir, "word", "document.xml")
    );
    expect(authors["Claude"]).toBe(2);
    expect(authors["Bob"]).toBe(1);
  });
});

describe("inferAuthor", () => {
  it("returns default when no tracked changes", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    const docxPath = path.join(tmpDir, "original.docx");
    const unpackedDir = path.join(tmpDir, "unpacked");
    await unpackDocxToDir(buf, unpackedDir);
    fs.writeFileSync(docxPath, await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    }));

    const author = await inferAuthor(unpackedDir, docxPath);
    expect(author).toBe("Claude");
  });

  it("infers author with new changes", async () => {
    const rawBody = `<w:p w14:paraId="00000001" w14:textId="77777777">
      <w:ins w:id="1" w:author="Alice" w:date="2024-01-01T00:00:00Z">
        <w:r><w:t>New text</w:t></w:r>
      </w:ins>
    </w:p>`;

    const origBuf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    const modifiedBuf = await createTestDocxBuffer({ rawBody });
    const docxPath = path.join(tmpDir, "original.docx");
    const unpackedDir = path.join(tmpDir, "unpacked");

    fs.writeFileSync(docxPath, origBuf);
    await unpackDocxToDir(modifiedBuf, unpackedDir);

    const author = await inferAuthor(unpackedDir, docxPath);
    expect(author).toBe("Alice");
  });
});
