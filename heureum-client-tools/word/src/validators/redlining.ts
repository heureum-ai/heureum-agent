/**
 * Validator for tracked changes in Word documents.
 * Ported from validators/redlining.py
 */
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import * as os from "os";
import JSZip from "jszip";
import { parseXml, getTagName, getLocalName, ValidationResult } from "./base";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export class RedliningValidator {
  unpackedDir: string;
  originalDocx: string;
  verbose: boolean;
  author: string;

  constructor(
    unpackedDir: string,
    originalDocx: string,
    verbose: boolean = false,
    author: string = "Claude"
  ) {
    this.unpackedDir = path.resolve(unpackedDir);
    this.originalDocx = path.resolve(originalDocx);
    this.verbose = verbose;
    this.author = author;
  }

  repair(): number {
    return 0;
  }

  async validate(): Promise<ValidationResult> {
    const modifiedFile = path.join(
      this.unpackedDir,
      "word",
      "document.xml"
    );
    if (!fs.existsSync(modifiedFile)) {
      return { valid: false, errors: [`Modified document.xml not found at ${modifiedFile}`] };
    }

    // Quick check: are there any tracked changes by this author?
    try {
      const modContent = fs.readFileSync(modifiedFile, "utf-8");
      const modNodes = parseXml(modContent);

      const hasAuthorChanges = this._hasAuthorChanges(modNodes);
      if (!hasAuthorChanges) {
        if (this.verbose) {
          console.log(`PASSED - No tracked changes by ${this.author} found.`);
        }
        return { valid: true, errors: [] };
      }
    } catch {
      // Continue with full validation
    }

    // Extract original document
    let originalContent: string;
    try {
      const buffer = fs.readFileSync(this.originalDocx);
      const zip = await JSZip.loadAsync(buffer);
      const docFile = zip.file("word/document.xml");
      if (!docFile) {
        return { valid: false, errors: [`Original document.xml not found in ${this.originalDocx}`] };
      }
      originalContent = await docFile.async("string");
    } catch (e: any) {
      return { valid: false, errors: [`Error unpacking original docx: ${e.message}`] };
    }

    try {
      const modifiedContent = fs.readFileSync(modifiedFile, "utf-8");

      let modifiedNodes = parseXml(modifiedContent);
      let originalNodes = parseXml(originalContent);

      // Remove this author's tracked changes from both
      modifiedNodes = this._removeAuthorTrackedChanges(modifiedNodes);
      originalNodes = this._removeAuthorTrackedChanges(originalNodes);

      const modifiedText = this._extractTextContent(modifiedNodes);
      const originalText = this._extractTextContent(originalNodes);

      if (modifiedText !== originalText) {
        const errorMessage = this._generateDetailedDiff(
          originalText,
          modifiedText
        );
        return { valid: false, errors: [errorMessage] };
      }

      if (this.verbose) {
        console.log(`PASSED - All changes by ${this.author} are properly tracked`);
      }
      return { valid: true, errors: [] };
    } catch (e: any) {
      return { valid: false, errors: [`Error parsing XML files: ${e.message}`] };
    }
  }

  private _hasAuthorChanges(nodes: any[]): boolean {
    let found = false;
    const check = (nodeArr: any[]): void => {
      if (found) return;
      for (const node of nodeArr) {
        const tag = getTagName(node);
        if (!tag) continue;
        const localName = getLocalName(tag);
        if (localName === "ins" || localName === "del") {
          const attrs = node[":@"] || {};
          const author = attrs["@_w:author"];
          if (author === this.author) {
            found = true;
            return;
          }
        }
        if (Array.isArray(node[tag])) {
          check(node[tag]);
        }
      }
    };
    check(nodes);
    return found;
  }

  /**
   * Remove this author's tracked changes:
   * - w:ins by this author: remove entirely (inserted content disappears)
   * - w:del by this author: promote children up, converting delText -> t
   */
  private _removeAuthorTrackedChanges(nodes: any[]): any[] {
    const process = (nodeArr: any[]): any[] => {
      const result: any[] = [];

      for (const node of nodeArr) {
        const tag = getTagName(node);
        if (!tag) {
          result.push(node);
          continue;
        }

        const localName = getLocalName(tag);
        const attrs = node[":@"] || {};
        const author = attrs["@_w:author"];

        if (localName === "ins" && author === this.author) {
          // Remove entirely - inserted content by this author disappears
          continue;
        }

        if (localName === "del" && author === this.author) {
          // Promote children, converting delText -> t
          if (Array.isArray(node[tag])) {
            const promoted = this._promoteDelChildren(node[tag]);
            result.push(...promoted);
          }
          continue;
        }

        // Recurse into children
        if (Array.isArray(node[tag])) {
          const processed = process(node[tag]);
          const newNode: any = { [tag]: processed };
          if (node[":@"]) newNode[":@"] = node[":@"];
          result.push(newNode);
        } else {
          result.push(node);
        }
      }

      return result;
    };

    return process(nodes);
  }

  private _promoteDelChildren(children: any[]): any[] {
    const result: any[] = [];
    for (const child of children) {
      const converted = this._convertDelTextToT(child);
      result.push(converted);
    }
    return result;
  }

  private _convertDelTextToT(node: any): any {
    const tag = getTagName(node);
    if (!tag) return node;

    const localName = getLocalName(tag);

    // Convert delText -> t
    if (localName === "delText") {
      const prefix = tag.includes(":") ? tag.split(":")[0] : "";
      const newTag = prefix ? `${prefix}:t` : "t";
      const newNode: any = { [newTag]: node[tag] };
      if (node[":@"]) newNode[":@"] = node[":@"];
      return newNode;
    }

    // Recurse into children
    if (Array.isArray(node[tag])) {
      const newChildren = node[tag].map((c: any) =>
        this._convertDelTextToT(c)
      );
      const newNode: any = { [tag]: newChildren };
      if (node[":@"]) newNode[":@"] = node[":@"];
      return newNode;
    }

    return node;
  }

  private _extractTextContent(nodes: any[]): string {
    const paragraphs: string[] = [];

    const findParagraphs = (nodeArr: any[]): void => {
      for (const node of nodeArr) {
        const tag = getTagName(node);
        if (!tag) continue;

        if (getLocalName(tag) === "p") {
          const textParts: string[] = [];
          const findText = (children: any[]): void => {
            for (const child of children) {
              const childTag = getTagName(child);
              if (!childTag) continue;
              if (getLocalName(childTag) === "t") {
                const textArr = child[childTag];
                if (Array.isArray(textArr) && textArr.length > 0) {
                  const text =
                    typeof textArr[0] === "string"
                      ? textArr[0]
                      : textArr[0]?.["#text"] ?? "";
                  if (text) textParts.push(String(text));
                }
              }
              if (Array.isArray(child[childTag])) {
                findText(child[childTag]);
              }
            }
          };
          if (Array.isArray(node[tag])) {
            findText(node[tag]);
          }
          const paragraphText = textParts.join("");
          if (paragraphText) paragraphs.push(paragraphText);
        } else if (Array.isArray(node[tag])) {
          findParagraphs(node[tag]);
        }
      }
    };

    findParagraphs(nodes);
    return paragraphs.join("\n");
  }

  private _generateDetailedDiff(
    originalText: string,
    modifiedText: string
  ): string {
    const parts = [
      `FAILED - Document text doesn't match after removing ${this.author}'s tracked changes`,
      "",
      "Likely causes:",
      "  1. Modified text inside another author's <w:ins> or <w:del> tags",
      "  2. Made edits without proper tracked changes",
      "  3. Didn't nest <w:del> inside <w:ins> when deleting another's insertion",
      "",
      "For pre-redlined documents, use correct patterns:",
      "  - To reject another's INSERTION: Nest <w:del> inside their <w:ins>",
      "  - To restore another's DELETION: Add new <w:ins> AFTER their <w:del>",
      "",
    ];

    const gitDiff = this._getGitWordDiff(originalText, modifiedText);
    if (gitDiff) {
      parts.push("Differences:", "============", gitDiff);
    } else {
      parts.push("Unable to generate word diff (git not available)");
    }

    return parts.join("\n");
  }

  private _getGitWordDiff(
    originalText: string,
    modifiedText: string
  ): string | null {
    try {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "redlining-diff-")
      );
      const origFile = path.join(tmpDir, "original.txt");
      const modFile = path.join(tmpDir, "modified.txt");

      fs.writeFileSync(origFile, originalText, "utf-8");
      fs.writeFileSync(modFile, modifiedText, "utf-8");

      try {
        const result = child_process.spawnSync(
          "git",
          [
            "diff",
            "--word-diff=plain",
            "--word-diff-regex=.",
            "-U0",
            "--no-index",
            origFile,
            modFile,
          ],
          { encoding: "utf-8", timeout: 5000 }
        );

        if (result.stdout?.trim()) {
          const lines = result.stdout.split("\n");
          const contentLines: string[] = [];
          let inContent = false;
          for (const line of lines) {
            if (line.startsWith("@@")) {
              inContent = true;
              continue;
            }
            if (inContent && line.trim()) {
              contentLines.push(line);
            }
          }
          if (contentLines.length > 0) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return contentLines.join("\n");
          }
        }
      } catch {
        // Fall through
      }

      // After first attempt with --word-diff-regex=.
      // Fallback: try without --word-diff-regex for broader compatibility
      try {
        const result2 = child_process.spawnSync(
          "git",
          [
            "diff",
            "--word-diff=plain",
            "-U0",
            "--no-index",
            origFile,
            modFile,
          ],
          { encoding: "utf-8", timeout: 5000 }
        );

        if (result2.stdout?.trim()) {
          const lines = result2.stdout.split("\n");
          const contentLines: string[] = [];
          let inContent = false;
          for (const line of lines) {
            if (line.startsWith("@@")) {
              inContent = true;
              continue;
            }
            if (inContent && line.trim()) {
              contentLines.push(line);
            }
          }
          if (contentLines.length > 0) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return contentLines.join("\n");
          }
        }
      } catch {
        // Fall through
      }

      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // git not available
    }

    return null;
  }
}
