import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as child_process from "child_process";
import { acceptChanges } from "../src/accept-changes";
import { createTestDocxFile } from "./helpers/create-test-docx";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "accept-changes-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Check if soffice is available
function hasSoffice(): boolean {
  try {
    const result = child_process.spawnSync("which", ["soffice"], {
      encoding: "utf-8",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

describe("acceptChanges", () => {
  it("returns error for non-existent input file", () => {
    const [, msg] = acceptChanges(
      "/nonexistent.docx",
      path.join(tmpDir, "out.docx")
    );
    expect(msg).toContain("Input file not found");
  });

  it("returns error for non-docx input file", () => {
    const txtFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(txtFile, "hello");
    const [, msg] = acceptChanges(txtFile, path.join(tmpDir, "out.docx"));
    expect(msg).toContain("not a DOCX file");
  });

  it("copies input file to output location", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const outPath = path.join(tmpDir, "output.docx");

    // This may fail due to soffice not being available, but the copy should work
    acceptChanges(docxPath, outPath);

    // The output file should exist (copied from input before soffice runs)
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it.skipIf(!hasSoffice())(
    "accepts tracked changes with soffice",
    async () => {
      const docxPath = path.join(tmpDir, "input.docx");
      await createTestDocxFile(docxPath, {
        trackedChanges: [
          { type: "ins", text: "Added text", author: "Claude" },
        ],
      });

      const outPath = path.join(tmpDir, "output.docx");
      const [, msg] = acceptChanges(docxPath, outPath);

      // If soffice is available, it should succeed
      expect(msg).toContain("Successfully accepted");
    }
  );
});
