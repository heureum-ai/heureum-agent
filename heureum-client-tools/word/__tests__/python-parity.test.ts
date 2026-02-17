/**
 * Python ↔ TypeScript Parity Tests
 *
 * Runs both Python original scripts and TS ports on the same input DOCX,
 * then compares the outputs to verify 1:1 behavioral equivalence.
 *
 * Requires: Python 3 with defusedxml, lxml installed.
 * Skips gracefully if Python or dependencies are missing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as child_process from "child_process";
import { createTestDocxFile } from "./helpers/create-test-docx";
import { unpack } from "../src/unpack";
import { pack } from "../src/pack";
import { addComment } from "../src/comment";
import { mergeRuns } from "../src/helpers/merge-runs";
import { simplifyRedlines } from "../src/helpers/simplify-redlines";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPTS_DIR = path.resolve(
  __dirname,
  "../../assets/skills/skills/docx/scripts"
);
const OFFICE_DIR = path.join(SCRIPTS_DIR, "office");

// ---------------------------------------------------------------------------
// Python availability check
// ---------------------------------------------------------------------------

function hasPython(): boolean {
  try {
    const r = child_process.spawnSync("python3", ["-c", "import defusedxml"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function runPython(
  scriptPath: string,
  args: string[],
  cwd: string
): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, PYTHONPATH: cwd };
  const r = child_process.spawnSync("python3", [scriptPath, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    cwd,
    env,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize XML for comparison: collapse whitespace, sort attributes, etc. */
function normalizeXml(xml: string): string {
  return xml
    .replace(/\r\n/g, "\n")
    .replace(/^\s+$/gm, "")              // blank lines
    .replace(/\n{2,}/g, "\n")            // multiple newlines
    .replace(/>\s+</g, ">\n<")           // normalize between tags
    .trim();
}

/** Extract text content from all w:t and w:delText elements in XML. */
function extractTextContent(xml: string): string[] {
  const texts: string[] = [];
  const re = /<w:(?:t|delText)[^>]*>([^<]*)<\/w:(?:t|delText)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    texts.push(m[1]);
  }
  return texts;
}

/** Count occurrences of a tag in XML. */
function countTag(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}[\\s/>]`, "g");
  return (xml.match(re) || []).length;
}

/** Read document.xml from an unpacked directory. */
function readDocXml(dir: string): string {
  return fs.readFileSync(path.join(dir, "word", "document.xml"), "utf-8");
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const pythonAvailable = hasPython();
const describeIf = pythonAvailable ? describe : describe.skip;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. unpack parity
// ---------------------------------------------------------------------------

describeIf("parity: unpack", () => {
  it("Python and TS produce same text content after unpack", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "Hello World" },
        { text: "Second paragraph" },
      ],
    });

    // Python unpack
    const pyDir = path.join(tmpDir, "py-unpacked");
    const pyResult = runPython(
      path.join(OFFICE_DIR, "unpack.py"),
      [docxPath, pyDir, "--merge-runs", "false", "--simplify-redlines", "false"],
      OFFICE_DIR
    );
    expect(pyResult.status).toBe(0);

    // TS unpack
    const tsDir = path.join(tmpDir, "ts-unpacked");
    const [, tsMsg] = await unpack(docxPath, tsDir, {
      mergeRuns: false,
      simplifyRedlines: false,
    });
    expect(tsMsg).not.toMatch(/^Error/);

    // Compare: both should have same files
    const pyDocXml = readDocXml(pyDir);
    const tsDocXml = readDocXml(tsDir);

    const pyTexts = extractTextContent(pyDocXml);
    const tsTexts = extractTextContent(tsDocXml);
    expect(tsTexts).toEqual(pyTexts);
  });

  it("Python and TS produce same text after unpack with merge-runs", async () => {
    const docxPath = path.join(tmpDir, "fragmented.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="11111111" w14:textId="77777777">
          <w:r><w:t xml:space="preserve">Hello </w:t></w:r>
          <w:r><w:t>World</w:t></w:r>
          <w:r><w:t xml:space="preserve"> today</w:t></w:r>
        </w:p>`,
    });

    // Python with merge-runs
    const pyDir = path.join(tmpDir, "py-merged");
    runPython(
      path.join(OFFICE_DIR, "unpack.py"),
      [docxPath, pyDir, "--merge-runs", "true", "--simplify-redlines", "false"],
      OFFICE_DIR
    );

    // TS with merge-runs
    const tsDir = path.join(tmpDir, "ts-merged");
    await unpack(docxPath, tsDir, { mergeRuns: true, simplifyRedlines: false });

    const pyDocXml = readDocXml(pyDir);
    const tsDocXml = readDocXml(tsDir);

    // After merging, both should have same number of w:r elements
    const pyRunCount = countTag(pyDocXml, "w:r");
    const tsRunCount = countTag(tsDocXml, "w:r");
    expect(tsRunCount).toBe(pyRunCount);

    // Text content should be identical
    expect(extractTextContent(tsDocXml)).toEqual(extractTextContent(pyDocXml));
  });
});

// ---------------------------------------------------------------------------
// 2. merge-runs parity
// ---------------------------------------------------------------------------

describeIf("parity: merge-runs", () => {
  it("Python and TS merge same number of runs", async () => {
    const docxPath = path.join(tmpDir, "multi-run.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="11111111" w14:textId="77777777">
          <w:r><w:rPr><w:b/></w:rPr><w:t>Bold1</w:t></w:r>
          <w:r><w:rPr><w:b/></w:rPr><w:t>Bold2</w:t></w:r>
          <w:r><w:t>Normal</w:t></w:r>
        </w:p>`,
    });

    // Python: unpack without merge, then we'll compare the unpack-with-merge
    const pyDir = path.join(tmpDir, "py-unmerged");
    runPython(
      path.join(OFFICE_DIR, "unpack.py"),
      [docxPath, pyDir, "--merge-runs", "false"],
      OFFICE_DIR
    );

    const tsDir = path.join(tmpDir, "ts-unmerged");
    await unpack(docxPath, tsDir, { mergeRuns: false, simplifyRedlines: false });

    // Now run merge-runs on both
    // Python: re-unpack with merge
    const pyMergedDir = path.join(tmpDir, "py-merged");
    runPython(
      path.join(OFFICE_DIR, "unpack.py"),
      [docxPath, pyMergedDir, "--merge-runs", "true"],
      OFFICE_DIR
    );

    // TS: apply merge-runs on unmerged dir
    const tsMergedDir = path.join(tmpDir, "ts-merged");
    await unpack(docxPath, tsMergedDir, { mergeRuns: false, simplifyRedlines: false });
    mergeRuns(tsMergedDir);

    const pyXml = readDocXml(pyMergedDir);
    const tsXml = readDocXml(tsMergedDir);

    // Bold1+Bold2 should merge to 1 run, Normal stays → 2 runs total
    const pyRuns = countTag(pyXml, "w:r");
    const tsRuns = countTag(tsXml, "w:r");
    expect(tsRuns).toBe(pyRuns);

    // Text content must match
    expect(extractTextContent(tsXml)).toEqual(extractTextContent(pyXml));
  });
});

// ---------------------------------------------------------------------------
// 3. simplify-redlines parity
// ---------------------------------------------------------------------------

describeIf("parity: simplify-redlines", () => {
  it("Python and TS merge same adjacent tracked changes", async () => {
    const docxPath = path.join(tmpDir, "redlined.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="22222222" w14:textId="77777777">
          <w:ins w:id="1" w:author="Alice" w:date="2024-01-01T00:00:00Z">
            <w:r><w:t>First </w:t></w:r>
          </w:ins>
          <w:ins w:id="2" w:author="Alice" w:date="2024-01-02T00:00:00Z">
            <w:r><w:t>Second</w:t></w:r>
          </w:ins>
          <w:ins w:id="3" w:author="Bob" w:date="2024-01-03T00:00:00Z">
            <w:r><w:t>Third</w:t></w:r>
          </w:ins>
        </w:p>`,
    });

    // Python: unpack with simplify
    const pyDir = path.join(tmpDir, "py-simplified");
    runPython(
      path.join(OFFICE_DIR, "unpack.py"),
      [docxPath, pyDir, "--merge-runs", "false", "--simplify-redlines", "true"],
      OFFICE_DIR
    );

    // TS: unpack then simplify
    const tsDir = path.join(tmpDir, "ts-simplified");
    await unpack(docxPath, tsDir, { mergeRuns: false, simplifyRedlines: false });
    simplifyRedlines(tsDir);

    const pyXml = readDocXml(pyDir);
    const tsXml = readDocXml(tsDir);

    // Alice's 2 adjacent ins → 1 merged; Bob's stays → 2 total
    const pyInsCount = countTag(pyXml, "w:ins");
    const tsInsCount = countTag(tsXml, "w:ins");
    expect(tsInsCount).toBe(pyInsCount);

    // Text preserved
    expect(extractTextContent(tsXml)).toEqual(extractTextContent(pyXml));
  });

  it("Python and TS both skip merging changes from different authors", async () => {
    const docxPath = path.join(tmpDir, "diff-author.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="33333333" w14:textId="77777777">
          <w:del w:id="1" w:author="Alice" w:date="2024-01-01T00:00:00Z">
            <w:r><w:delText>Deleted by Alice</w:delText></w:r>
          </w:del>
          <w:del w:id="2" w:author="Bob" w:date="2024-01-02T00:00:00Z">
            <w:r><w:delText>Deleted by Bob</w:delText></w:r>
          </w:del>
        </w:p>`,
    });

    const pyDir = path.join(tmpDir, "py-diff");
    runPython(
      path.join(OFFICE_DIR, "unpack.py"),
      [docxPath, pyDir, "--simplify-redlines", "true"],
      OFFICE_DIR
    );

    const tsDir = path.join(tmpDir, "ts-diff");
    await unpack(docxPath, tsDir, { mergeRuns: false, simplifyRedlines: false });
    simplifyRedlines(tsDir);

    const pyXml = readDocXml(pyDir);
    const tsXml = readDocXml(tsDir);

    // Both should stay as 2 separate w:del (different authors)
    expect(countTag(tsXml, "w:del")).toBe(countTag(pyXml, "w:del"));
  });
});

// ---------------------------------------------------------------------------
// 4. comment parity
// ---------------------------------------------------------------------------

describeIf("parity: addComment", () => {
  it("Python and TS produce structurally identical comments.xml", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello World" }],
    });

    // Unpack with both
    const pyDir = path.join(tmpDir, "py-comment");
    runPython(
      path.join(OFFICE_DIR, "unpack.py"),
      [docxPath, pyDir, "--merge-runs", "false"],
      OFFICE_DIR
    );

    const tsDir = path.join(tmpDir, "ts-comment");
    await unpack(docxPath, tsDir, { mergeRuns: false, simplifyRedlines: false });

    // Add comment: Python
    const pyCommentResult = runPython(
      path.join(SCRIPTS_DIR, "comment.py"),
      [pyDir, "0", "Test comment", "--author", "TestAuthor", "--initials", "TA"],
      SCRIPTS_DIR
    );
    expect(pyCommentResult.status).toBe(0);

    // Add comment: TS
    const [, tsMsg] = addComment(tsDir, 0, "Test comment", "TestAuthor", "TA");
    expect(tsMsg).not.toMatch(/^Error/);

    // Compare: both should have comments.xml with same structure
    const pyCommentsPath = path.join(pyDir, "word", "comments.xml");
    const tsCommentsPath = path.join(tsDir, "word", "comments.xml");
    expect(fs.existsSync(pyCommentsPath)).toBe(true);
    expect(fs.existsSync(tsCommentsPath)).toBe(true);

    const pyComments = fs.readFileSync(pyCommentsPath, "utf-8");
    const tsComments = fs.readFileSync(tsCommentsPath, "utf-8");

    // Both should contain the comment text and author
    expect(pyComments).toContain("Test comment");
    expect(tsComments).toContain("Test comment");
    expect(pyComments).toContain("TestAuthor");
    expect(tsComments).toContain("TestAuthor");

    // Both should have w:comment element with id="0"
    expect(countTag(pyComments, "w:comment")).toBe(1);
    expect(countTag(tsComments, "w:comment")).toBe(1);

    // Both should create supporting files
    const supportingFiles = [
      "word/commentsExtended.xml",
      "word/commentsIds.xml",
      "word/commentsExtensible.xml",
    ];
    for (const f of supportingFiles) {
      const pyExists = fs.existsSync(path.join(pyDir, f));
      const tsExists = fs.existsSync(path.join(tsDir, f));
      expect(tsExists).toBe(pyExists);
    }
  });

  it("Python and TS both register comment relationships", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "Hello" }],
    });

    const pyDir = path.join(tmpDir, "py-rels");
    runPython(
      path.join(OFFICE_DIR, "unpack.py"),
      [docxPath, pyDir, "--merge-runs", "false"],
      OFFICE_DIR
    );

    const tsDir = path.join(tmpDir, "ts-rels");
    await unpack(docxPath, tsDir, { mergeRuns: false, simplifyRedlines: false });

    runPython(
      path.join(SCRIPTS_DIR, "comment.py"),
      [pyDir, "0", "Comment"],
      SCRIPTS_DIR
    );
    addComment(tsDir, 0, "Comment", "Claude", "C");

    // Both should have updated _rels/document.xml.rels with comments relationship
    const pyRels = fs.readFileSync(
      path.join(pyDir, "word", "_rels", "document.xml.rels"),
      "utf-8"
    );
    const tsRels = fs.readFileSync(
      path.join(tsDir, "word", "_rels", "document.xml.rels"),
      "utf-8"
    );

    expect(pyRels).toContain("comments.xml");
    expect(tsRels).toContain("comments.xml");

    // Both should have updated [Content_Types].xml
    const pyCT = fs.readFileSync(
      path.join(pyDir, "[Content_Types].xml"),
      "utf-8"
    );
    const tsCT = fs.readFileSync(
      path.join(tsDir, "[Content_Types].xml"),
      "utf-8"
    );

    expect(pyCT).toContain("comments.xml");
    expect(tsCT).toContain("comments.xml");
  });
});

// ---------------------------------------------------------------------------
// 5. pack parity
// ---------------------------------------------------------------------------

describeIf("parity: pack", () => {
  it("Python and TS pack produce valid DOCX with same content", async () => {
    const docxPath = path.join(tmpDir, "input.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [
        { text: "Paragraph one" },
        { text: "Paragraph two" },
      ],
    });

    // Unpack (TS only, since we just need a directory to pack)
    const unpackDir = path.join(tmpDir, "unpacked");
    await unpack(docxPath, unpackDir, {
      mergeRuns: false,
      simplifyRedlines: false,
    });

    // Python pack
    const pyOutput = path.join(tmpDir, "py-output.docx");
    const pyResult = runPython(
      path.join(OFFICE_DIR, "pack.py"),
      [unpackDir, pyOutput, "--validate", "false"],
      OFFICE_DIR
    );
    expect(pyResult.status).toBe(0);
    expect(fs.existsSync(pyOutput)).toBe(true);

    // TS pack (need a fresh unpack since pack may modify the dir)
    const unpackDir2 = path.join(tmpDir, "unpacked2");
    await unpack(docxPath, unpackDir2, {
      mergeRuns: false,
      simplifyRedlines: false,
    });
    const tsOutput = path.join(tmpDir, "ts-output.docx");
    const [, tsMsg] = await pack(unpackDir2, tsOutput, { validate: false });
    expect(tsMsg).not.toMatch(/^Error/);
    expect(fs.existsSync(tsOutput)).toBe(true);

    // Re-unpack both to compare content
    const pyReunpack = path.join(tmpDir, "py-reunpack");
    const tsReunpack = path.join(tmpDir, "ts-reunpack");
    await unpack(pyOutput, pyReunpack, {
      mergeRuns: false,
      simplifyRedlines: false,
    });
    await unpack(tsOutput, tsReunpack, {
      mergeRuns: false,
      simplifyRedlines: false,
    });

    const pyText = extractTextContent(readDocXml(pyReunpack));
    const tsText = extractTextContent(readDocXml(tsReunpack));
    expect(tsText).toEqual(pyText);
  });
});

// ---------------------------------------------------------------------------
// 6. accept_changes parity (soffice-dependent)
// ---------------------------------------------------------------------------

function hasSoffice(): boolean {
  try {
    const r = child_process.spawnSync("soffice", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

const describeIfSoffice =
  pythonAvailable && hasSoffice() ? describe : describe.skip;

describeIfSoffice("parity: accept_changes", () => {
  it("Python and TS both accept tracked changes", async () => {
    const docxPath = path.join(tmpDir, "tracked.docx");
    await createTestDocxFile(docxPath, {
      trackedChanges: [
        {
          type: "ins",
          text: "new text",
          author: "Alice",
          date: "2024-01-01T00:00:00Z",
        },
      ],
    });

    // Python
    const pyOutput = path.join(tmpDir, "py-accepted.docx");
    const pyResult = runPython(
      path.join(SCRIPTS_DIR, "accept_changes.py"),
      [docxPath, pyOutput],
      SCRIPTS_DIR
    );

    // TS
    const { acceptChanges } = await import("../src/accept-changes");
    const tsOutput = path.join(tmpDir, "ts-accepted.docx");
    const [, tsMsg] = acceptChanges(docxPath, tsOutput);

    // Both should succeed (or both timeout-succeed)
    expect(pyResult.stdout).toContain("Successfully");
    expect(tsMsg).toContain("Successfully");
    expect(fs.existsSync(pyOutput)).toBe(true);
    expect(fs.existsSync(tsOutput)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. validate parity
// ---------------------------------------------------------------------------

describeIf("parity: validate", () => {
  it("Python and TS both PASS on valid document", async () => {
    const docxPath = path.join(tmpDir, "valid.docx");
    await createTestDocxFile(docxPath, {
      paragraphs: [{ text: "A valid document" }],
    });

    // Python validate
    const pyResult = runPython(
      path.join(OFFICE_DIR, "validate.py"),
      [docxPath],
      OFFICE_DIR
    );

    // TS validate (via tool wrapper)
    const { docxValidate } = await import("../src/tools");
    const tsResult = await docxValidate({ path: docxPath });

    // Both should pass
    expect(pyResult.status).toBe(0);
    expect(tsResult.success).toBe(true);
  });

  it("Python and TS both FAIL on invalid paraId", async () => {
    const docxPath = path.join(tmpDir, "invalid.docx");
    await createTestDocxFile(docxPath, {
      rawBody: `
        <w:p w14:paraId="FFFFFFFF" w14:textId="77777777">
          <w:r><w:t>Bad paraId</w:t></w:r>
        </w:p>`,
    });

    // Python validate
    const pyResult = runPython(
      path.join(OFFICE_DIR, "validate.py"),
      [docxPath],
      OFFICE_DIR
    );

    // TS validate
    const { docxValidate } = await import("../src/tools");
    const tsResult = await docxValidate({
      path: docxPath,
      autoRepair: false,
    });

    // Both should fail with paraId error
    expect(pyResult.status).not.toBe(0);
    expect(tsResult.success).toBe(false);
    expect(pyResult.stdout + pyResult.stderr).toContain("paraId");
    expect(tsResult.output).toContain("paraId");
  });
});
