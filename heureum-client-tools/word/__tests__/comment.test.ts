import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { addComment } from "../src/comment";
import {
  createTestDocxBuffer,
  unpackDocxToDir,
} from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comment-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("addComment", () => {
  it("returns error when word directory not found", () => {
    const [paraId, msg] = addComment(tmpDir, 0, "Test comment");
    expect(paraId).toBe("");
    expect(msg).toContain("not found");
  });

  it("adds a comment to an unpacked docx", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const [paraId, msg] = addComment(tmpDir, 0, "Test comment");
    expect(paraId).toHaveLength(8);
    expect(msg).toContain("Added comment 0");
    expect(msg).toContain("para_id=");
  });

  it("creates comments.xml from template on first comment", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello World" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const commentsPath = path.join(tmpDir, "word", "comments.xml");
    expect(fs.existsSync(commentsPath)).toBe(false);

    addComment(tmpDir, 0, "First comment");

    expect(fs.existsSync(commentsPath)).toBe(true);
    const content = fs.readFileSync(commentsPath, "utf-8");
    expect(content).toContain("w:comment");
    expect(content).toContain("First comment");
  });

  it("creates supporting comment files", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    addComment(tmpDir, 0, "Test");

    expect(
      fs.existsSync(path.join(tmpDir, "word", "commentsExtended.xml"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "word", "commentsIds.xml"))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "word", "commentsExtensible.xml"))
    ).toBe(true);
  });

  it("registers comment relationships in document.xml.rels", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    addComment(tmpDir, 0, "Test");

    const relsPath = path.join(
      tmpDir,
      "word",
      "_rels",
      "document.xml.rels"
    );
    const relsContent = fs.readFileSync(relsPath, "utf-8");
    expect(relsContent).toContain("comments.xml");
    expect(relsContent).toContain("commentsExtended.xml");
  });

  it("registers comment content types", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    addComment(tmpDir, 0, "Test");

    const ctPath = path.join(tmpDir, "[Content_Types].xml");
    const ctContent = fs.readFileSync(ctPath, "utf-8");
    expect(ctContent).toContain("/word/comments.xml");
  });

  it("adds multiple comments", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    const [paraId1, msg1] = addComment(tmpDir, 0, "First comment");
    const [paraId2, msg2] = addComment(tmpDir, 1, "Second comment");

    expect(paraId1).toHaveLength(8);
    expect(paraId2).toHaveLength(8);
    expect(paraId1).not.toBe(paraId2);
    expect(msg1).toContain("Added comment 0");
    expect(msg2).toContain("Added comment 1");

    const commentsContent = fs.readFileSync(
      path.join(tmpDir, "word", "comments.xml"),
      "utf-8"
    );
    expect(commentsContent).toContain("First comment");
    expect(commentsContent).toContain("Second comment");
  });

  it("supports custom author", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    addComment(tmpDir, 0, "Test", "Alice", "A");

    const commentsContent = fs.readFileSync(
      path.join(tmpDir, "word", "comments.xml"),
      "utf-8"
    );
    expect(commentsContent).toContain("Alice");
  });

  it("adds a reply to an existing comment", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    addComment(tmpDir, 0, "Parent comment");
    const [replyParaId, msg] = addComment(
      tmpDir,
      1,
      "Reply text",
      "Claude",
      "C",
      0
    );

    expect(replyParaId).toHaveLength(8);
    expect(msg).toContain("Added reply 1");

    const extContent = fs.readFileSync(
      path.join(tmpDir, "word", "commentsExtended.xml"),
      "utf-8"
    );
    expect(extContent).toContain("paraIdParent");
  });

  it("returns error for reply to non-existent parent", async () => {
    const buf = await createTestDocxBuffer({
      paragraphs: [{ text: "Hello" }],
    });
    await unpackDocxToDir(buf, tmpDir);

    addComment(tmpDir, 0, "Test");
    const [paraId, msg] = addComment(
      tmpDir,
      1,
      "Reply",
      "Claude",
      "C",
      999
    );
    expect(paraId).toBe("");
    expect(msg).toContain("Parent comment 999 not found");
  });
});
