/**
 * High-level DOCX tool wrappers for LLM tool calls via Electron IPC.
 *
 * Each function handles the full cycle: unpack -> modify -> pack -> cleanup.
 * Returns a ToolResult with success status, human-readable output, and optional output path.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { XMLBuilder } from "fast-xml-parser";
import { parseXml, getTagName, tagMatches, BUILDER_OPTIONS as BASE_BUILDER_OPTIONS } from "./xml-utils";
import { unpack } from "./unpack";
import { pack } from "./pack";
import { addComment, _internal as commentInternal } from "./comment";
import { acceptChanges } from "./accept-changes";
import { runSoffice } from "./soffice";
import { mergeRuns } from "./helpers/merge-runs";
import { simplifyRedlines } from "./helpers/simplify-redlines";
import { DOCXSchemaValidator } from "./validators/docx";
import { RedliningValidator } from "./validators/redlining";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  PageOrientation, LevelFormat, PageBreak,
  Table, TableRow, TableCell, BorderStyle, WidthType, ShadingType,
  ImageRun, Header, Footer, PageNumber, TableOfContents, ExternalHyperlink,
} from "docx";

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

export interface ToolResult {
  success: boolean;
  output: string;
  outputPath?: string;
}

// tools.ts uses formatted output (pretty-printed) since pack will condense later
const FORMATTED_BUILDER_OPTIONS = {
  ...BASE_BUILDER_OPTIONS,
  format: true,
  indentBy: "  ",
};

function buildFormattedXml(nodes: any[]): string {
  const builder = new XMLBuilder(FORMATTED_BUILDER_OPTIONS);
  const filtered = nodes.filter((n: any) => !("?xml" in n));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(filtered);
}

function getLocalName(tag: string): string {
  const idx = tag.lastIndexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

/** Create a temporary directory for DOCX operations. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "docx-tool-"));
}

/** Compute the default output path: {dir}/{basename}_modified.docx */
function defaultOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  return path.join(dir, `${base}_modified${ext}`);
}

/** Get text content from a w:t / w:delText element. */
function getTextContent(tElem: any): string {
  const tag = getTagName(tElem);
  if (!tag) return "";
  const arr = tElem[tag];
  if (!Array.isArray(arr) || arr.length === 0) return "";
  const first = arr[0];
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null && "#text" in first)
    return String(first["#text"]);
  return "";
}

/** Get the next available w:id in the document (for tracked changes, comments, bookmarks). */
function getNextWId(nodes: any[]): number {
  let maxId = 0;
  function walk(nodeArr: any[]): void {
    for (const node of nodeArr) {
      const tag = getTagName(node);
      if (!tag) continue;
      const attrs = node[":@"] || {};
      const wId = attrs["@_w:id"];
      if (wId !== undefined) {
        const num = parseInt(wId, 10);
        if (!isNaN(num) && num > maxId) maxId = num;
      }
      if (Array.isArray(node[tag])) walk(node[tag]);
    }
  }
  walk(nodes);
  return maxId + 1;
}

// ---------------------------------------------------------------------------
// XML tree traversal helpers for docxRead
// ---------------------------------------------------------------------------

interface ParagraphInfo {
  index: number;
  text: string;
  formatting: string[];
}

interface TrackedChangeInfo {
  type: "ins" | "del";
  text: string;
  author: string;
  date: string;
}

interface CommentInfo {
  id: string;
  author: string;
  text: string;
}

/** Extract paragraph text and basic formatting from parsed XML nodes. */
function extractParagraphs(nodes: any[]): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = [];
  let idx = 0;

  function findParagraphs(nodeArr: any[]): void {
    for (const node of nodeArr) {
      const tag = getTagName(node);
      if (!tag) continue;

      if (getLocalName(tag) === "p") {
        const textParts: string[] = [];
        const fmt: Set<string> = new Set();

        function collectText(children: any[]): void {
          for (const child of children) {
            const childTag = getTagName(child);
            if (!childTag) continue;
            const local = getLocalName(childTag);

            if (local === "r") {
              // Check run properties for formatting
              if (Array.isArray(child[childTag])) {
                for (const rc of child[childTag]) {
                  const rcTag = getTagName(rc);
                  if (rcTag && getLocalName(rcTag) === "rPr") {
                    if (Array.isArray(rc[rcTag])) {
                      for (const prop of rc[rcTag]) {
                        const propTag = getTagName(prop);
                        if (!propTag) continue;
                        const propLocal = getLocalName(propTag);
                        if (propLocal === "b") fmt.add("bold");
                        if (propLocal === "i") fmt.add("italic");
                        if (propLocal === "u") fmt.add("underline");
                        if (propLocal === "strike") fmt.add("strikethrough");
                      }
                    }
                  }
                }
                collectText(child[childTag]);
              }
            } else if (local === "t" || local === "delText") {
              textParts.push(getTextContent(child));
            } else if (local === "ins" || local === "del") {
              // Recurse into tracked changes to get their text too
              if (Array.isArray(child[childTag])) {
                collectText(child[childTag]);
              }
            } else if (Array.isArray(child[childTag])) {
              collectText(child[childTag]);
            }
          }
        }

        if (Array.isArray(node[tag])) {
          collectText(node[tag]);
        }

        paragraphs.push({
          index: idx,
          text: textParts.join(""),
          formatting: Array.from(fmt),
        });
        idx++;
      } else if (Array.isArray(node[tag])) {
        findParagraphs(node[tag]);
      }
    }
  }

  findParagraphs(nodes);
  return paragraphs;
}

/** Extract tracked change info from parsed XML nodes. */
function extractTrackedChanges(nodes: any[]): TrackedChangeInfo[] {
  const changes: TrackedChangeInfo[] = [];

  function walk(nodeArr: any[]): void {
    for (const node of nodeArr) {
      const tag = getTagName(node);
      if (!tag) continue;
      const local = getLocalName(tag);

      if (local === "ins" || local === "del") {
        const attrs = node[":@"] || {};
        const author = attrs["@_w:author"] || "";
        const date = attrs["@_w:date"] || "";

        // Collect text from child runs
        const textParts: string[] = [];
        function collectText(children: any[]): void {
          for (const child of children) {
            const childTag = getTagName(child);
            if (!childTag) continue;
            const childLocal = getLocalName(childTag);
            if (childLocal === "t" || childLocal === "delText") {
              textParts.push(getTextContent(child));
            }
            if (Array.isArray(child[childTag])) {
              collectText(child[childTag]);
            }
          }
        }

        if (Array.isArray(node[tag])) {
          collectText(node[tag]);
        }

        if (textParts.length > 0) {
          changes.push({
            type: local as "ins" | "del",
            text: textParts.join(""),
            author,
            date: date ? date.split("T")[0] : "",
          });
        }
      }

      if (Array.isArray(node[tag])) {
        walk(node[tag]);
      }
    }
  }

  walk(nodes);
  return changes;
}

/** Extract comments from comments.xml. */
function extractComments(commentsXml: string): CommentInfo[] {
  const comments: CommentInfo[] = [];
  const nodes = parseXml(commentsXml);

  function walk(nodeArr: any[]): void {
    for (const node of nodeArr) {
      const tag = getTagName(node);
      if (!tag) continue;

      if (getLocalName(tag) === "comment") {
        const attrs = node[":@"] || {};
        const id = attrs["@_w:id"] || "";
        const author = attrs["@_w:author"] || "";

        const textParts: string[] = [];
        function collectText(children: any[]): void {
          for (const child of children) {
            const childTag = getTagName(child);
            if (!childTag) continue;
            if (getLocalName(childTag) === "t") {
              textParts.push(getTextContent(child));
            }
            if (Array.isArray(child[childTag])) {
              collectText(child[childTag]);
            }
          }
        }

        if (Array.isArray(node[tag])) {
          collectText(node[tag]);
        }

        comments.push({
          id,
          author,
          text: textParts.join(""),
        });
      }

      if (Array.isArray(node[tag])) {
        walk(node[tag]);
      }
    }
  }

  walk(nodes);
  return comments;
}

// ---------------------------------------------------------------------------
// Find paragraphs in the parsed tree for modification
// ---------------------------------------------------------------------------

/** Collect w:p nodes from the parsed tree in document order. */
function collectParagraphNodes(nodes: any[]): any[] {
  const result: any[] = [];

  function walk(nodeArr: any[]): void {
    for (const node of nodeArr) {
      const tag = getTagName(node);
      if (!tag) continue;
      if (getLocalName(tag) === "p") {
        result.push(node);
      }
      if (Array.isArray(node[tag])) {
        walk(node[tag]);
      }
    }
  }

  walk(nodes);
  return result;
}

// ---------------------------------------------------------------------------
// Helpers for new tools (deleteParagraph, reviewChanges, insertImage, convertToImages)
// ---------------------------------------------------------------------------

/** Convert a w:r node's w:t elements to w:delText (for tracked deletion). */
function convertRunToDeleted(runNode: any): any {
  const tag = getTagName(runNode);
  if (!tag || !tagMatches(tag, "r")) return runNode;
  const children = runNode[tag];
  if (!Array.isArray(children)) return runNode;

  const newChildren = children.map((child: any) => {
    const childTag = getTagName(child);
    if (!childTag) return child;
    if (tagMatches(childTag, "t")) {
      const text = getTextContent(child);
      const delTextNode: any = {
        "w:delText": [{ "#text": text }],
      };
      if (text.startsWith(" ") || text.endsWith(" ")) {
        delTextNode[":@"] = { "@_xml:space": "preserve" };
      }
      return delTextNode;
    }
    return child;
  });

  const result: any = { [tag]: newChildren };
  if (runNode[":@"]) result[":@"] = runNode[":@"];
  return result;
}

interface TrackedChangeNodeInfo {
  type: "ins" | "del";
  node: any;
  parentArray: any[];
  indexInParent: number;
  text: string;
  author: string;
  date: string;
}

/** Collect tracked change nodes with parent references for modification. */
function collectTrackedChangeNodes(nodes: any[]): TrackedChangeNodeInfo[] {
  const changes: TrackedChangeNodeInfo[] = [];

  function walk(nodeArr: any[]): void {
    for (let i = 0; i < nodeArr.length; i++) {
      const node = nodeArr[i];
      const tag = getTagName(node);
      if (!tag) continue;
      const local = getLocalName(tag);

      if (local === "ins" || local === "del") {
        const attrs = node[":@"] || {};
        const author = attrs["@_w:author"] || "";
        const date = attrs["@_w:date"] || "";

        const textParts: string[] = [];
        function collectText(children: any[]): void {
          for (const child of children) {
            const childTag = getTagName(child);
            if (!childTag) continue;
            const childLocal = getLocalName(childTag);
            if (childLocal === "t" || childLocal === "delText") {
              textParts.push(getTextContent(child));
            }
            if (Array.isArray(child[childTag])) {
              collectText(child[childTag]);
            }
          }
        }

        if (Array.isArray(node[tag])) {
          collectText(node[tag]);
        }

        if (textParts.length > 0) {
          changes.push({
            type: local as "ins" | "del",
            node,
            parentArray: nodeArr,
            indexInParent: i,
            text: textParts.join(""),
            author,
            date,
          });
        }
      }

      if (Array.isArray(node[tag])) {
        walk(node[tag]);
      }
    }
  }

  walk(nodes);
  return changes;
}

interface ParagraphWithParent {
  node: any;
  parentArray: any[];
  indexInParent: number;
}

/** Find a paragraph by document-order index and return it with its parent array. */
function findParagraphWithParent(nodes: any[], targetIndex: number): ParagraphWithParent | null {
  let currentIndex = 0;

  function walk(nodeArr: any[]): ParagraphWithParent | null {
    for (let i = 0; i < nodeArr.length; i++) {
      const node = nodeArr[i];
      const tag = getTagName(node);
      if (!tag) continue;

      if (getLocalName(tag) === "p") {
        if (currentIndex === targetIndex) {
          return { node, parentArray: nodeArr, indexInParent: i };
        }
        currentIndex++;
      }

      if (Array.isArray(node[tag])) {
        const found = walk(node[tag]);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(nodes);
}

/** Get the next available wp:docPr id in the document. */
function getNextDocPrId(nodes: any[]): number {
  let maxId = 0;

  function walk(nodeArr: any[]): void {
    for (const node of nodeArr) {
      const tag = getTagName(node);
      if (!tag) continue;
      if (tagMatches(tag, "docPr")) {
        const attrs = node[":@"] || {};
        const id = parseInt(attrs["@_id"], 10);
        if (!isNaN(id) && id > maxId) maxId = id;
      }
      if (Array.isArray(node[tag])) walk(node[tag]);
    }
  }

  walk(nodes);
  return maxId + 1;
}

/** Ensure an image extension has a Default content type entry. */
function ensureImageContentType(ctPath: string, ext: string): void {
  if (!fs.existsSync(ctPath)) return;

  const contentTypeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
  };

  const ct = contentTypeMap[ext];
  if (!ct) return;

  const content = fs.readFileSync(ctPath, "utf-8");
  const nodes = parseXml(content);

  // Check if Default for this extension already exists
  for (const node of nodes) {
    const tag = getTagName(node);
    if (tag !== "Types") continue;
    if (!Array.isArray(node[tag])) continue;
    for (const child of node[tag]) {
      const childTag = getTagName(child);
      if (childTag === "Default") {
        const attrs = child[":@"] || {};
        if (attrs["@_Extension"] === ext) return;
      }
    }
  }

  // Add Default entry
  for (const node of nodes) {
    const tag = getTagName(node);
    if (tag !== "Types") continue;
    if (!Array.isArray(node[tag])) node[tag] = [];
    node[tag].push({
      Default: [],
      ":@": {
        "@_Extension": ext,
        "@_ContentType": ct,
      },
    });
    break;
  }

  fs.writeFileSync(ctPath, buildFormattedXml(nodes), "utf-8");
}

/** Ensure the w:document root element has required namespace declarations. */
function ensureNamespaces(nodes: any[], nsAttrs: Record<string, string>): void {
  for (const node of nodes) {
    const tag = getTagName(node);
    if (tag && tagMatches(tag, "document")) {
      if (!node[":@"]) node[":@"] = {};
      for (const [key, value] of Object.entries(nsAttrs)) {
        if (!(key in node[":@"])) {
          node[":@"][key] = value;
        }
      }
      return;
    }
  }
}

/** Strip xmlns namespace declarations from a parsed node's attributes. */
function stripNamespaceDecls(node: any): void {
  if (node[":@"]) {
    for (const key of Object.keys(node[":@"])) {
      if (key.startsWith("@_xmlns:") || key === "@_xmlns") {
        delete node[":@"][key];
      }
    }
  }
}

/** Escape a string for safe use in an XML attribute value. */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// 1. docxRead
// ---------------------------------------------------------------------------

export async function docxRead(params: {
  path: string;
}): Promise<ToolResult> {
  const inputPath = params.path;
  let tmpDir: string | undefined;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    tmpDir = makeTempDir();
    const unpackDir = path.join(tmpDir, "unpacked");
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {
      mergeRuns: true,
      simplifyRedlines: true,
    });

    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    // Read document.xml
    const docXmlPath = path.join(unpackDir, "word", "document.xml");
    if (!fs.existsSync(docXmlPath)) {
      return { success: false, output: "Error: document.xml not found in DOCX" };
    }

    const docContent = fs.readFileSync(docXmlPath, "utf-8");
    const docNodes = parseXml(docContent);

    // Extract paragraphs
    const paragraphs = extractParagraphs(docNodes);

    // Extract tracked changes
    const trackedChanges = extractTrackedChanges(docNodes);

    // Extract comments
    const commentsPath = path.join(unpackDir, "word", "comments.xml");
    let comments: CommentInfo[] = [];
    if (fs.existsSync(commentsPath)) {
      const commentsContent = fs.readFileSync(commentsPath, "utf-8");
      comments = extractComments(commentsContent);
    }

    // Build output
    const lines: string[] = [];

    const nonEmptyCount = paragraphs.filter(p => p.text.length > 0).length;
    lines.push(`Paragraphs (${paragraphs.length} total, ${nonEmptyCount} with text):`);
    for (const p of paragraphs) {
      if (p.text.length === 0) continue; // Skip empty paragraphs in output
      const fmtStr = p.formatting.length > 0
        ? ` (${p.formatting.join(", ")})`
        : "";
      const display = p.text.length > 200
        ? p.text.slice(0, 200) + "..."
        : p.text;
      lines.push(`[${p.index}] "${display}"${fmtStr}`);
    }

    if (trackedChanges.length > 0) {
      lines.push("");
      lines.push(`Tracked Changes (${trackedChanges.length}):`);
      for (const tc of trackedChanges) {
        const display = tc.text.length > 100
          ? tc.text.slice(0, 100) + "..."
          : tc.text;
        lines.push(`- [${tc.type}] "${display}" by ${tc.author}${tc.date ? ` (${tc.date})` : ""}`);
      }
    }

    if (comments.length > 0) {
      lines.push("");
      lines.push(`Comments (${comments.length}):`);
      for (const c of comments) {
        const display = c.text.length > 200
          ? c.text.slice(0, 200) + "..."
          : c.text;
        lines.push(`- Comment ${c.id} by ${c.author}: "${display}"`);
      }
    }

    return { success: true, output: lines.join("\n") };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 2. docxAddComment
// ---------------------------------------------------------------------------

export async function docxAddComment(params: {
  path: string;
  paragraphIndex: number;
  paragraphIndexEnd?: number;
  text: string;
  author?: string;
  outputPath?: string;
  parentCommentId?: number;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const paragraphIndex = params.paragraphIndex;
  const paragraphIndexEnd = params.paragraphIndexEnd ?? paragraphIndex;
  const commentText = params.text;
  const author = params.author ?? "Claude";
  const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
  let tmpDir: string | undefined;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    tmpDir = makeTempDir();
    const unpackDir = path.join(tmpDir, "unpacked");
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {
      mergeRuns: true,
      simplifyRedlines: false,
    });

    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    // Read document.xml
    const docXmlPath = path.join(unpackDir, "word", "document.xml");
    if (!fs.existsSync(docXmlPath)) {
      return { success: false, output: "Error: document.xml not found in DOCX" };
    }

    const docContent = fs.readFileSync(docXmlPath, "utf-8");
    const docNodes = parseXml(docContent);

    // Find paragraph nodes
    const paragraphNodes = collectParagraphNodes(docNodes);
    if (paragraphIndex < 0 || paragraphIndex >= paragraphNodes.length) {
      return {
        success: false,
        output: `Error: Paragraph index ${paragraphIndex} out of range (0-${paragraphNodes.length - 1})`,
      };
    }
    if (paragraphIndexEnd < paragraphIndex) {
      return {
        success: false,
        output: `Error: paragraphIndexEnd (${paragraphIndexEnd}) must be >= paragraphIndex (${paragraphIndex})`,
      };
    }
    if (paragraphIndexEnd >= paragraphNodes.length) {
      return {
        success: false,
        output: `Error: paragraphIndexEnd ${paragraphIndexEnd} out of range (0-${paragraphNodes.length - 1})`,
      };
    }

    // Determine the next available comment ID by scanning document.xml
    const commentId = getNextWId(docNodes);

    // Derive initials from author
    const initials = author
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase())
      .join("");

    // Add comment XML files (comments.xml, commentsExtended.xml, etc.)
    const [, addMsg] = addComment(
      unpackDir,
      commentId,
      commentText,
      author,
      initials,
      params.parentCommentId
    );

    if (addMsg.startsWith("Error")) {
      return { success: false, output: addMsg };
    }

    // Build comment range start node
    const rangeStart = {
      "w:commentRangeStart": [],
      ":@": { "@_w:id": String(commentId) },
    };

    // Build comment range end node
    const rangeEnd = {
      "w:commentRangeEnd": [],
      ":@": { "@_w:id": String(commentId) },
    };

    // Build comment reference run (placed after the paragraph)
    const commentRefRun = {
      "w:r": [
        {
          "w:rPr": [{ "w:rStyle": [], ":@": { "@_w:val": "CommentReference" } }],
        },
        {
          "w:commentReference": [],
          ":@": { "@_w:id": String(commentId) },
        },
      ],
    };

    // Insert commentRangeStart in the START paragraph
    const startParagraph = paragraphNodes[paragraphIndex];
    const startTag = getTagName(startParagraph)!;
    if (!Array.isArray(startParagraph[startTag])) {
      startParagraph[startTag] = [];
    }

    // Find insertion point: after pPr if present
    let insertIdx = 0;
    for (let i = 0; i < startParagraph[startTag].length; i++) {
      const childTag = getTagName(startParagraph[startTag][i]);
      if (childTag && getLocalName(childTag) === "pPr") {
        insertIdx = i + 1;
        break;
      }
    }
    startParagraph[startTag].splice(insertIdx, 0, rangeStart);

    // Insert commentRangeEnd and commentReference in the END paragraph
    const endParagraph = paragraphNodes[paragraphIndexEnd];
    const endTag = getTagName(endParagraph)!;
    if (!Array.isArray(endParagraph[endTag])) {
      endParagraph[endTag] = [];
    }
    endParagraph[endTag].push(rangeEnd);
    endParagraph[endTag].push(commentRefRun);

    // Write modified document.xml
    fs.writeFileSync(docXmlPath, buildFormattedXml(docNodes), "utf-8");

    // Pack
    const [, packMsg] = await pack(unpackDir, outputPath, { validate: false });

    if (packMsg.startsWith("Error")) {
      return { success: false, output: packMsg };
    }

    if (paragraphIndex === paragraphIndexEnd) {
      return {
        success: true,
        output: `Added comment by ${author} on paragraph ${paragraphIndex}: "${commentText}"`,
        outputPath,
      };
    } else {
      return {
        success: true,
        output: `Added comment by ${author} on paragraphs ${paragraphIndex}-${paragraphIndexEnd}: "${commentText}"`,
        outputPath,
      };
    }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 3. docxRedline
// ---------------------------------------------------------------------------

/** Convert straight quotes/apostrophes to smart quote XML entities for OOXML. */
const SMART_QUOTE_MAP: Record<string, string> = {
  "\u2018": "&#x2018;",  // left single
  "\u2019": "&#x2019;",  // right single / apostrophe
  "\u201C": "&#x201C;",  // left double
  "\u201D": "&#x201D;",  // right double
};

function applySmartQuotes(text: string): string {
  let result = text;
  for (const [char, entity] of Object.entries(SMART_QUOTE_MAP)) {
    result = result.replaceAll(char, entity);
  }
  return result;
}

/**
 * Create a w:del element wrapping the deleted text.
 */
function makeDelNode(
  text: string,
  author: string,
  date: string,
  wId: number,
  rPrChildren: any[] | null
): any {
  const delTextNode: any = {
    "w:delText": [{ "#text": text }],
  };
  if (text.startsWith(" ") || text.endsWith(" ")) {
    delTextNode[":@"] = { "@_xml:space": "preserve" };
  }

  const runChildren: any[] = [];
  if (rPrChildren) {
    runChildren.push({ "w:rPr": rPrChildren });
  }
  runChildren.push(delTextNode);

  return {
    "w:del": [{ "w:r": runChildren }],
    ":@": {
      "@_w:id": String(wId),
      "@_w:author": author,
      "@_w:date": date,
    },
  };
}

/**
 * Create a w:ins element wrapping the inserted text.
 */
function makeInsNode(
  text: string,
  author: string,
  date: string,
  wId: number,
  rPrChildren: any[] | null
): any {
  const smartText = applySmartQuotes(text);
  const tNode: any = {
    "w:t": [{ "#text": smartText }],
  };
  if (text.startsWith(" ") || text.endsWith(" ")) {
    tNode[":@"] = { "@_xml:space": "preserve" };
  }

  const runChildren: any[] = [];
  if (rPrChildren) {
    runChildren.push({ "w:rPr": rPrChildren });
  }
  runChildren.push(tNode);

  return {
    "w:ins": [{ "w:r": runChildren }],
    ":@": {
      "@_w:id": String(wId),
      "@_w:author": author,
      "@_w:date": date,
    },
  };
}

/**
 * Deep-clone a fast-xml-parser node array (used for preserving rPr).
 */
function cloneNodes(nodes: any[]): any[] {
  return JSON.parse(JSON.stringify(nodes));
}

export async function docxRedline(params: {
  path: string;
  changes: Array<{ find: string; replace: string; paragraphIndex?: number }>;
  author?: string;
  outputPath?: string;
  matchAll?: boolean;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const changes = params.changes;
  const author = params.author ?? "Claude";
  const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
  const matchAll = params.matchAll ?? false;
  let tmpDir: string | undefined;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    if (!changes || changes.length === 0) {
      return { success: false, output: "Error: No changes provided" };
    }

    tmpDir = makeTempDir();
    const unpackDir = path.join(tmpDir, "unpacked");
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {
      mergeRuns: true,
      simplifyRedlines: true,
    });

    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    const docXmlPath = path.join(unpackDir, "word", "document.xml");
    if (!fs.existsSync(docXmlPath)) {
      return { success: false, output: "Error: document.xml not found in DOCX" };
    }

    const docContent = fs.readFileSync(docXmlPath, "utf-8");
    const docNodes = parseXml(docContent);

    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    let nextId = getNextWId(docNodes);
    let totalApplied = 0;
    const notFound: string[] = [];

    for (const change of changes) {
      const { find: findText, replace: replaceText, paragraphIndex: targetParaIdx } = change;
      if (!findText) continue;

      let changeApplied = 0;

      // Walk all paragraphs and look for the text in runs
      const paragraphNodes = collectParagraphNodes(docNodes);

      for (let pIdx = 0; pIdx < paragraphNodes.length; pIdx++) {
        const para = paragraphNodes[pIdx];

        // If paragraphIndex specified, skip non-matching paragraphs
        if (targetParaIdx !== undefined && pIdx !== targetParaIdx) continue;

        const paraTag = getTagName(para)!;
        if (!Array.isArray(para[paraTag])) continue;

        // Try to apply the change within this paragraph's runs.
        // Strategy: collect all w:r elements, concatenate their text,
        // check if findText is present, then rebuild runs with del/ins.
        const applied = applyChangeInParagraph(
          para,
          paraTag,
          findText,
          replaceText,
          author,
          ts,
          nextId,
          matchAll
        );

        if (applied > 0) {
          nextId += applied * 2; // Each application uses 2 IDs (one for del, one for ins)
          changeApplied += applied;
          if (!matchAll && targetParaIdx === undefined) break; // Original behavior: stop at first match
        }
      }

      if (changeApplied > 0) {
        totalApplied += changeApplied;
      } else {
        notFound.push(findText);
      }
    }

    // Write back
    fs.writeFileSync(docXmlPath, buildFormattedXml(docNodes), "utf-8");

    // Pack
    const [, packMsg] = await pack(unpackDir, outputPath, { validate: false });

    if (packMsg.startsWith("Error")) {
      return { success: false, output: packMsg };
    }

    const outputLines: string[] = [];
    outputLines.push(`Applied ${totalApplied}/${changes.length} tracked change(s) by ${author}.`);
    if (notFound.length > 0) {
      outputLines.push(`Not found: ${notFound.map((t) => `"${t}"`).join(", ")}`);
    }

    return {
      success: totalApplied > 0,
      output: outputLines.join("\n"),
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Apply a single find/replace tracked change within a paragraph (one occurrence).
 *
 * Walks the paragraph's direct child runs (w:r) — including runs nested inside
 * w:hyperlink containers — builds a concatenated text view, and if findText is
 * present, splits the runs at the match boundary and inserts w:del + w:ins nodes.
 *
 * Returns true if the change was applied.
 */
function applyOneChange(
  para: any,
  paraTag: string,
  findText: string,
  replaceText: string,
  author: string,
  date: string,
  startId: number
): boolean {
  const children = para[paraTag];

  // Collect run info: indices of w:r children, with their text and rPr
  interface RunInfo {
    childIndex: number;
    containerIndex: number | null; // index within hyperlink's children, null if direct
    containerChildIndex: number | null; // the index of the hyperlink in paragraph's children
    text: string;
    rPrChildren: any[] | null;
    startOffset: number; // offset in concatenated text
  }

  const runs: RunInfo[] = [];
  let concat = "";

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childTag = getTagName(child);
    if (!childTag) continue;

    if (tagMatches(childTag, "r")) {
      if (!Array.isArray(child[childTag])) continue;

      // Extract rPr
      let rPr: any[] | null = null;
      let runText = "";

      for (const rc of child[childTag]) {
        const rcTag = getTagName(rc);
        if (!rcTag) continue;
        if (getLocalName(rcTag) === "rPr" && Array.isArray(rc[rcTag])) {
          rPr = cloneNodes(rc[rcTag]);
        }
        if (getLocalName(rcTag) === "t") {
          runText += getTextContent(rc);
        }
      }

      runs.push({
        childIndex: i,
        containerIndex: null,
        containerChildIndex: null,
        text: runText,
        rPrChildren: rPr,
        startOffset: concat.length,
      });
      concat += runText;
    } else if (tagMatches(childTag, "hyperlink")) {
      // Look inside hyperlink for runs
      if (Array.isArray(child[childTag])) {
        for (let j = 0; j < child[childTag].length; j++) {
          const hChild = child[childTag][j];
          const hChildTag = getTagName(hChild);
          if (!hChildTag || !tagMatches(hChildTag, "r")) continue;
          if (!Array.isArray(hChild[hChildTag])) continue;

          let rPr: any[] | null = null;
          let runText = "";
          for (const rc of hChild[hChildTag]) {
            const rcTag = getTagName(rc);
            if (!rcTag) continue;
            if (getLocalName(rcTag) === "rPr" && Array.isArray(rc[rcTag])) {
              rPr = cloneNodes(rc[rcTag]);
            }
            if (getLocalName(rcTag) === "t") {
              runText += getTextContent(rc);
            }
          }

          runs.push({
            childIndex: i,
            containerIndex: j,
            containerChildIndex: i,
            text: runText,
            rPrChildren: rPr,
            startOffset: concat.length,
          });
          concat += runText;
        }
      }
    }
  }

  // Check if findText exists in the concatenated text
  const matchIdx = concat.indexOf(findText);
  if (matchIdx === -1) return false;

  const matchEnd = matchIdx + findText.length;

  // Determine which runs are affected by the match
  // A run is affected if its text range [startOffset, startOffset+text.length)
  // overlaps with [matchIdx, matchEnd)
  const affectedRuns: RunInfo[] = [];
  for (const r of runs) {
    const rStart = r.startOffset;
    const rEnd = rStart + r.text.length;
    if (rEnd > matchIdx && rStart < matchEnd) {
      affectedRuns.push(r);
    }
  }

  if (affectedRuns.length === 0) return false;

  // Check that all affected runs are in the same container
  const firstContainer = affectedRuns[0].containerChildIndex;
  const allSameContainer = affectedRuns.every(r => r.containerChildIndex === firstContainer);
  if (!allSameContainer) return false; // cannot handle cross-container changes

  // Use the rPr from the first affected run for the tracked change markup
  const rPr = affectedRuns[0].rPrChildren;

  // Build replacement nodes:
  // 1. If the first affected run has text before the match, keep that as a plain run
  // 2. w:del with the matched text
  // 3. w:ins with the replacement text (if non-empty)
  // 4. If the last affected run has text after the match, keep that as a plain run

  const newNodes: any[] = [];

  // Text before the match in the first affected run
  const firstRun = affectedRuns[0];
  const prefixLen = matchIdx - firstRun.startOffset;
  if (prefixLen > 0) {
    const prefix = firstRun.text.slice(0, prefixLen);
    newNodes.push(makeTextRun(prefix, firstRun.rPrChildren));
  }

  // w:del
  newNodes.push(makeDelNode(findText, author, date, startId, rPr));

  // w:ins (only if replacement is non-empty)
  if (replaceText) {
    newNodes.push(makeInsNode(replaceText, author, date, startId + 1, rPr));
  }

  // Text after the match in the last affected run
  const lastRun = affectedRuns[affectedRuns.length - 1];
  const lastRunEnd = lastRun.startOffset + lastRun.text.length;
  const suffixLen = lastRunEnd - matchEnd;
  if (suffixLen > 0) {
    const suffix = lastRun.text.slice(lastRun.text.length - suffixLen);
    newNodes.push(makeTextRun(suffix, lastRun.rPrChildren));
  }

  // Determine which children array to splice into and do the splice
  if (firstContainer !== null) {
    // Runs are inside a hyperlink
    const hyperlink = children[firstContainer];
    const hyperlinkTag = getTagName(hyperlink)!;
    const targetChildren = hyperlink[hyperlinkTag];

    const firstIdx = affectedRuns[0].containerIndex!;
    const lastIdx = affectedRuns[affectedRuns.length - 1].containerIndex!;
    const removeCount = lastIdx - firstIdx + 1;
    targetChildren.splice(firstIdx, removeCount, ...newNodes);
  } else {
    const firstChildIdx = affectedRuns[0].childIndex;
    const lastChildIdx = affectedRuns[affectedRuns.length - 1].childIndex;
    const removeCount = lastChildIdx - firstChildIdx + 1;
    children.splice(firstChildIdx, removeCount, ...newNodes);
  }

  return true;
}

/**
 * Apply find/replace tracked change(s) within a paragraph.
 *
 * When matchAll is false, applies only the first occurrence (returns 0 or 1).
 * When matchAll is true, applies all non-overlapping occurrences (returns count).
 * To prevent infinite loops, if replaceText contains findText, only one pass is done.
 *
 * Returns the number of changes applied.
 */
function applyChangeInParagraph(
  para: any,
  paraTag: string,
  findText: string,
  replaceText: string,
  author: string,
  date: string,
  startId: number,
  matchAll: boolean = false
): number {
  let totalApplied = 0;
  let currentId = startId;

  // Prevent infinite loops when replacement contains the search text
  const couldLoop = replaceText.includes(findText);

  while (true) {
    const applied = applyOneChange(para, paraTag, findText, replaceText, author, date, currentId);
    if (!applied) break;
    totalApplied++;
    currentId += 2;
    if (!matchAll || couldLoop) break; // Only one iteration if not matchAll or could loop
  }

  return totalApplied;
}

/** Create a plain w:r node with text. */
function makeTextRun(text: string, rPrChildren: any[] | null): any {
  const tNode: any = {
    "w:t": [{ "#text": text }],
  };
  if (text.startsWith(" ") || text.endsWith(" ")) {
    tNode[":@"] = { "@_xml:space": "preserve" };
  }

  const runChildren: any[] = [];
  if (rPrChildren) {
    runChildren.push({ "w:rPr": cloneNodes(rPrChildren) });
  }
  runChildren.push(tNode);

  return { "w:r": runChildren };
}

// ---------------------------------------------------------------------------
// 4. docxValidate
// ---------------------------------------------------------------------------

export async function docxValidate(params: {
  path: string;
  autoRepair?: boolean;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const autoRepair = params.autoRepair ?? true;
  let tmpDir: string | undefined;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    tmpDir = makeTempDir();
    const unpackDir = path.join(tmpDir, "unpacked");
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {
      mergeRuns: false,
      simplifyRedlines: false,
    });

    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    const outputLines: string[] = [];

    const docxValidator = new DOCXSchemaValidator(
      unpackDir,
      inputPath
    );
    const redliningValidator = new RedliningValidator(
      unpackDir,
      inputPath,
      false,
      "Claude"
    );

    if (autoRepair) {
      const repairs =
        docxValidator.repair() + redliningValidator.repair();
      if (repairs > 0) {
        outputLines.push(`Auto-repaired ${repairs} issue(s).`);
      }
    }

    const docxResult = await docxValidator.validate();
    const redliningResult = await redliningValidator.validate();

    if (docxResult.errors.length > 0) {
      outputLines.push(...docxResult.errors);
    }
    if (redliningResult.errors.length > 0) {
      outputLines.push(...redliningResult.errors);
    }

    if (docxResult.valid && redliningResult.valid) {
      outputLines.push("All validations PASSED.");
      return {
        success: true,
        output: outputLines.join("\n"),
      };
    } else {
      return {
        success: false,
        output: outputLines.join("\n"),
      };
    }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 5. docxSimplify
// ---------------------------------------------------------------------------

export async function docxSimplify(params: {
  path: string;
  outputPath?: string;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
  let tmpDir: string | undefined;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    tmpDir = makeTempDir();
    const unpackDir = path.join(tmpDir, "unpacked");

    // Unpack without automatic merging/simplifying (we will do it explicitly)
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {
      mergeRuns: false,
      simplifyRedlines: false,
    });

    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    // Run merge runs
    const [mergeCount] = mergeRuns(unpackDir);

    // Run simplify redlines
    const [simplifyCount] = simplifyRedlines(unpackDir);

    // Pack
    const [, packMsg] = await pack(unpackDir, outputPath, { validate: false });

    if (packMsg.startsWith("Error")) {
      return { success: false, output: packMsg };
    }

    return {
      success: true,
      output: `Simplified document: merged ${mergeCount} runs, simplified ${simplifyCount} tracked changes.`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 6. docxAcceptChanges
// ---------------------------------------------------------------------------

export async function docxAcceptChanges(params: {
  path: string;
  outputPath?: string;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const [, msg] = acceptChanges(inputPath, outputPath);

    if (msg.startsWith("Error")) {
      return { success: false, output: msg };
    }

    return {
      success: true,
      output: msg,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// 7. docxConvert
// ---------------------------------------------------------------------------

const SUPPORTED_CONVERT_FORMATS = new Set(["pdf", "html", "txt", "rtf", "docx"]);

export async function docxConvert(params: {
  path: string;
  format: "pdf" | "html" | "txt" | "rtf" | "docx";
  outputPath?: string;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const format = params.format;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    if (!SUPPORTED_CONVERT_FORMATS.has(format)) {
      return { success: false, output: `Error: Unsupported format: ${format}. Supported: ${[...SUPPORTED_CONVERT_FORMATS].join(", ")}` };
    }

    const absoluteInput = path.resolve(inputPath);
    const inputBasename = path.basename(inputPath, path.extname(inputPath));
    const defaultOut = path.join(path.dirname(absoluteInput), `${inputBasename}.${format}`);
    const outputPath = params.outputPath ? path.resolve(params.outputPath) : defaultOut;
    const outputDir = path.dirname(outputPath);

    fs.mkdirSync(outputDir, { recursive: true });

    const result = runSoffice(
      ["--headless", "--convert-to", format, absoluteInput],
      { cwd: outputDir, timeout: 60000 }
    );

    if (result.error) {
      if ((result.error as any).code === "ENOENT") {
        return { success: false, output: "Error: LibreOffice (soffice) not found. Please install LibreOffice." };
      }
      return { success: false, output: `Error: ${result.error.message}` };
    }

    if (result.status !== 0) {
      return { success: false, output: `Error: LibreOffice conversion failed: ${result.stderr || result.stdout}` };
    }

    // soffice writes to cwd as {basename}.{format}
    const sofficeOutput = path.join(outputDir, `${inputBasename}.${format}`);

    // If the user specified a different outputPath, rename
    if (sofficeOutput !== outputPath) {
      if (fs.existsSync(sofficeOutput)) {
        fs.renameSync(sofficeOutput, outputPath);
      }
    }

    if (!fs.existsSync(outputPath)) {
      return { success: false, output: `Error: Conversion completed but output file not found at ${outputPath}` };
    }

    return {
      success: true,
      output: `Converted ${path.basename(inputPath)} to ${format}: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// 8. docxCreate
// ---------------------------------------------------------------------------

/** Paragraph content item for docxCreate */
export interface CreateParagraph {
  text?: string;
  heading?: 1 | 2 | 3;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;       // Hex color e.g. "FF0000"
  fontSize?: number;    // Half-points, overrides document default
  alignment?: "left" | "center" | "right";
  bullet?: boolean;
  numbered?: boolean;
  pageBreak?: boolean;
  level?: number;  // For nested lists (0, 1, 2)
  link?: string;   // External hyperlink URL
  spacing?: { before?: number; after?: number };
  indent?: { left?: number; hanging?: number };
}

/** Table content item for docxCreate */
export interface CreateTable {
  rows: string[][];
  headerRow?: boolean;
  columnWidths?: number[];
}

/** Image content item for docxCreate */
export interface CreateImage {
  path: string;
  width: number;
  height: number;
  type?: "png" | "jpg" | "gif" | "bmp";
  altText?: { title?: string; description?: string; name?: string };
}

/** A single content block in the document */
export interface CreateContentBlock {
  paragraph?: CreateParagraph;
  table?: CreateTable;
  image?: CreateImage;
  toc?: { heading?: string; headingStyleRange?: string };
}

export async function docxCreate(params: {
  outputPath: string;
  content: CreateContentBlock[];
  pageSize?: "letter" | "a4";
  landscape?: boolean;
  font?: string;
  fontSize?: number;
  margin?: number | { top: number; right: number; bottom: number; left: number };
  header?: string;
  footer?: string;
}): Promise<ToolResult> {
  const outputPath = params.outputPath;
  const content = params.content;
  const pageSizeName = params.pageSize ?? "letter";
  const landscape = params.landscape ?? false;
  const font = params.font ?? "Arial";
  const fontSize = params.fontSize ?? 24; // half-points: 24 = 12pt
  const headerText = params.header;
  const footerText = params.footer;

  try {
    if (!content || content.length === 0) {
      return { success: false, output: "Error: No content provided" };
    }

    const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
      1: HeadingLevel.HEADING_1,
      2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3,
    };

    const alignmentMap: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
      left: AlignmentType.LEFT,
      center: AlignmentType.CENTER,
      right: AlignmentType.RIGHT,
    };

    // Page dimensions in DXA (SKILL.md canonical values)
    const pageDimensions = pageSizeName === "a4"
      ? { width: 11906, height: 16838 }
      : { width: 12240, height: 15840 };

    const pageSizeConfig: any = {
      ...pageDimensions,
    };
    if (landscape) {
      pageSizeConfig.orientation = PageOrientation.LANDSCAPE;
    }

    // Margins in DXA (default: 1 inch = 1440)
    let marginConfig: { top: number; right: number; bottom: number; left: number };
    if (params.margin === undefined) {
      marginConfig = { top: 1440, right: 1440, bottom: 1440, left: 1440 };
    } else if (typeof params.margin === "number") {
      marginConfig = { top: params.margin, right: params.margin, bottom: params.margin, left: params.margin };
    } else {
      marginConfig = params.margin;
    }

    // Numbering config for bullets and numbered lists (multi-level)
    const numberingConfig = {
      config: [
        {
          reference: "bullets",
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
            { level: 1, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
            { level: 2, format: LevelFormat.BULLET, text: "\u25AA", alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 2160, hanging: 360 } } } },
          ],
        },
        {
          reference: "numbers",
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2)", alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
            { level: 2, format: LevelFormat.LOWER_ROMAN, text: "%3.", alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 2160, hanging: 360 } } } },
          ],
        },
      ],
    };

    // Build content children
    const children: (Paragraph | Table)[] = [];

    for (const block of content) {
      if (block.paragraph) {
        const p = block.paragraph;

        // Page break
        if (p.pageBreak) {
          children.push(new Paragraph({ children: [new PageBreak()] }));
          continue;
        }

        const listLevel = p.level ?? 0;

        // Handle hyperlink paragraphs
        if (p.link) {
          const linkChildren: any[] = [];
          if (p.text) {
            linkChildren.push(
              new ExternalHyperlink({
                link: p.link,
                children: [
                  new TextRun({
                    text: p.text,
                    style: "Hyperlink",
                    font,
                    size: fontSize,
                  }),
                ],
              })
            );
          }
          const paragraphOptions: any = { children: linkChildren };
          if (p.alignment && alignmentMap[p.alignment]) {
            paragraphOptions.alignment = alignmentMap[p.alignment];
          }
          children.push(new Paragraph(paragraphOptions));
          continue;
        }

        const runOptions: any = {
          text: p.text ?? "",
          bold: p.bold,
          italics: p.italic,
          font,
          size: p.fontSize ?? fontSize,
        };
        if (p.underline) {
          runOptions.underline = {};
        }
        if (p.strikethrough) {
          runOptions.strike = true;
        }
        if (p.color) {
          runOptions.color = p.color;
        }

        const paragraphOptions: any = {
          children: [new TextRun(runOptions)],
        };

        if (p.heading && headingMap[p.heading]) {
          paragraphOptions.heading = headingMap[p.heading];
        }

        if (p.alignment && alignmentMap[p.alignment]) {
          paragraphOptions.alignment = alignmentMap[p.alignment];
        }

        if (p.bullet) {
          paragraphOptions.numbering = { reference: "bullets", level: listLevel };
        } else if (p.numbered) {
          paragraphOptions.numbering = { reference: "numbers", level: listLevel };
        }

        if (p.spacing) {
          paragraphOptions.spacing = {};
          if (p.spacing.before !== undefined) paragraphOptions.spacing.before = p.spacing.before;
          if (p.spacing.after !== undefined) paragraphOptions.spacing.after = p.spacing.after;
        }

        if (p.indent) {
          paragraphOptions.indent = {};
          if (p.indent.left !== undefined) paragraphOptions.indent.left = p.indent.left;
          if (p.indent.hanging !== undefined) paragraphOptions.indent.hanging = p.indent.hanging;
        }

        children.push(new Paragraph(paragraphOptions));
      } else if (block.table) {
        const t = block.table;
        if (!t.rows || t.rows.length === 0) continue;

        const colCount = t.rows[0].length;
        // Default: equal column widths summing to content width (page - margins)
        const contentWidth = pageDimensions.width - marginConfig.left - marginConfig.right;
        const colWidths = t.columnWidths ?? Array(colCount).fill(Math.floor(contentWidth / colCount));

        const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
        const borders = { top: border, bottom: border, left: border, right: border };

        const tableRows = t.rows.map((row, rowIdx) => {
          const cells = row.map((cellText, colIdx) => {
            const cellChildren = [
              new Paragraph({
                children: [
                  new TextRun({
                    text: cellText,
                    bold: t.headerRow && rowIdx === 0,
                    font,
                    size: fontSize,
                  }),
                ],
              }),
            ];

            const cellOptions: any = {
              borders,
              width: { size: colWidths[colIdx] ?? colWidths[0], type: WidthType.DXA },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: cellChildren,
            };

            if (t.headerRow && rowIdx === 0) {
              cellOptions.shading = { fill: "D5E8F0", type: ShadingType.CLEAR };
            }

            return new TableCell(cellOptions);
          });

          return new TableRow({ children: cells });
        });

        children.push(
          new Table({
            width: { size: contentWidth, type: WidthType.DXA },
            columnWidths: colWidths,
            rows: tableRows,
          })
        );
      } else if (block.image) {
        const img = block.image;
        if (!fs.existsSync(img.path)) {
          return { success: false, output: `Error: Image file not found: ${img.path}` };
        }

        const rawExt = (img.type ?? path.extname(img.path).slice(1).toLowerCase());
        const ext = (rawExt === "jpeg" ? "jpg" : rawExt) as
          "png" | "jpg" | "gif" | "bmp";
        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                type: ext,
                data: fs.readFileSync(img.path),
                transformation: { width: img.width, height: img.height },
                altText: {
                  title: img.altText?.title ?? "Image",
                  description: img.altText?.description ?? "Image",
                  name: img.altText?.name ?? "Image",
                },
              }),
            ],
          })
        );
      } else if (block.toc) {
        const tocHeading = block.toc.heading ?? "Table of Contents";
        const range = block.toc.headingStyleRange ?? "1-3";
        children.push(
          new TableOfContents(tocHeading, {
            hyperlink: true,
            headingStyleRange: range,
          })
        );
      }
    }

    // Section properties
    const sectionProperties: any = {
      page: {
        size: pageSizeConfig,
        margin: marginConfig,
      },
    };

    // Headers/Footers
    const headers: any = {};
    const footers: any = {};

    if (headerText) {
      headers.default = new Header({
        children: [new Paragraph({ children: [new TextRun({ text: headerText, font, size: fontSize })] })],
      });
    }

    if (footerText) {
      footers.default = new Footer({
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: footerText, font, size: fontSize }),
              new TextRun({ text: " Page " }),
              new TextRun({ children: [PageNumber.CURRENT] }),
            ],
          }),
        ],
      });
    }

    const doc = new Document({
      styles: {
        default: {
          document: {
            run: { font, size: fontSize },
          },
        },
        paragraphStyles: [
          {
            id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
            run: { size: 32, bold: true, font },
            paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 },
          },
          {
            id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
            run: { size: 28, bold: true, font },
            paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 },
          },
          {
            id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
            run: { size: 24, bold: true, font },
            paragraph: { spacing: { before: 120, after: 120 }, outlineLevel: 2 },
          },
        ],
      },
      numbering: numberingConfig,
      sections: [
        {
          properties: sectionProperties,
          ...(Object.keys(headers).length > 0 && { headers }),
          ...(Object.keys(footers).length > 0 && { footers }),
          children,
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    const dir = path.dirname(outputPath);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, buffer);

    if (!fs.existsSync(outputPath)) {
      return { success: false, output: `Error: Failed to create file at ${outputPath}` };
    }

    const paragraphCount = content.filter(b => b.paragraph).length;
    const tableCount = content.filter(b => b.table).length;
    const imageCount = content.filter(b => b.image).length;
    const tocCount = content.filter(b => b.toc).length;

    const parts: string[] = [];
    if (paragraphCount > 0) parts.push(`${paragraphCount} paragraph(s)`);
    if (tableCount > 0) parts.push(`${tableCount} table(s)`);
    if (imageCount > 0) parts.push(`${imageCount} image(s)`);
    if (tocCount > 0) parts.push(`${tocCount} table(s) of contents`);

    return {
      success: true,
      output: `Created DOCX with ${parts.join(", ")}: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// 9. docxDeleteParagraph
// ---------------------------------------------------------------------------

export async function docxDeleteParagraph(params: {
  path: string;
  paragraphIndices: number[];
  author?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const paragraphIndices = params.paragraphIndices;
  const author = params.author ?? "Claude";
  const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
  let tmpDir: string | undefined;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    if (!paragraphIndices || paragraphIndices.length === 0) {
      return { success: false, output: "Error: No paragraph indices provided" };
    }

    tmpDir = makeTempDir();
    const unpackDir = path.join(tmpDir, "unpacked");
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {
      mergeRuns: true,
      simplifyRedlines: true,
    });

    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    const docXmlPath = path.join(unpackDir, "word", "document.xml");
    if (!fs.existsSync(docXmlPath)) {
      return { success: false, output: "Error: document.xml not found in DOCX" };
    }

    const docContent = fs.readFileSync(docXmlPath, "utf-8");
    const docNodes = parseXml(docContent);

    const allParagraphs = collectParagraphNodes(docNodes);
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    let nextId = getNextWId(docNodes);
    let deletedCount = 0;

    // Validate indices
    for (const idx of paragraphIndices) {
      if (idx < 0 || idx >= allParagraphs.length) {
        return {
          success: false,
          output: `Error: Paragraph index ${idx} out of range (0-${allParagraphs.length - 1})`,
        };
      }
    }

    const sortedIndices = [...new Set(paragraphIndices)].sort((a, b) => a - b);

    for (const idx of sortedIndices) {
      const para = allParagraphs[idx];
      const paraTag = getTagName(para)!;
      if (!Array.isArray(para[paraTag])) continue;

      const children = para[paraTag];
      const newChildren: any[] = [];

      for (const child of children) {
        const childTag = getTagName(child);
        if (!childTag) {
          newChildren.push(child);
          continue;
        }

        const local = getLocalName(childTag);

        if (local === "pPr") {
          // Add w:del marker inside w:pPr/w:rPr
          const pPrChildren = Array.isArray(child[childTag]) ? [...child[childTag]] : [];

          // Find or create w:rPr within w:pPr
          let rPrIdx = -1;
          for (let i = 0; i < pPrChildren.length; i++) {
            const pprChildTag = getTagName(pPrChildren[i]);
            if (pprChildTag && getLocalName(pprChildTag) === "rPr") {
              rPrIdx = i;
              break;
            }
          }

          const delMarker = {
            "w:del": [],
            ":@": {
              "@_w:id": String(nextId++),
              "@_w:author": author,
              "@_w:date": ts,
            },
          };

          if (rPrIdx >= 0) {
            const rPrNode = pPrChildren[rPrIdx];
            const rPrTag = getTagName(rPrNode)!;
            const rPrChildren = Array.isArray(rPrNode[rPrTag]) ? [...rPrNode[rPrTag]] : [];
            rPrChildren.push(delMarker);
            const newRPr: any = { [rPrTag]: rPrChildren };
            if (rPrNode[":@"]) newRPr[":@"] = rPrNode[":@"];
            pPrChildren[rPrIdx] = newRPr;
          } else {
            pPrChildren.push({ "w:rPr": [delMarker] });
          }

          const newPPr: any = { [childTag]: pPrChildren };
          if (child[":@"]) newPPr[":@"] = child[":@"];
          newChildren.push(newPPr);
        } else if (local === "r") {
          // Convert run to deleted
          const convertedRun = convertRunToDeleted(child);
          newChildren.push({
            "w:del": [convertedRun],
            ":@": {
              "@_w:id": String(nextId++),
              "@_w:author": author,
              "@_w:date": ts,
            },
          });
        } else if (local === "ins") {
          // Reject insertion: convert text inside and wrap in w:del
          const insChildren = Array.isArray(child[childTag]) ? child[childTag] : [];
          const convertedInsChildren = insChildren.map((insChild: any) => {
            const insChildTag = getTagName(insChild);
            if (insChildTag && getLocalName(insChildTag) === "r") {
              return convertRunToDeleted(insChild);
            }
            return insChild;
          });

          const modifiedIns: any = { [childTag]: convertedInsChildren };
          if (child[":@"]) modifiedIns[":@"] = child[":@"];
          newChildren.push({
            "w:del": [modifiedIns],
            ":@": {
              "@_w:id": String(nextId++),
              "@_w:author": author,
              "@_w:date": ts,
            },
          });
        } else if (local === "del") {
          // Already deleted, keep as-is
          newChildren.push(child);
        } else {
          // Other elements (bookmarks, comment markers, etc.)
          newChildren.push(child);
        }
      }

      // If no w:pPr existed, add one with the deletion marker
      const hasPPr = newChildren.some((c: any) => {
        const t = getTagName(c);
        return t && getLocalName(t) === "pPr";
      });
      if (!hasPPr) {
        const delMarker = {
          "w:del": [],
          ":@": {
            "@_w:id": String(nextId++),
            "@_w:author": author,
            "@_w:date": ts,
          },
        };
        newChildren.unshift({ "w:pPr": [{ "w:rPr": [delMarker] }] });
      }

      para[paraTag] = newChildren;
      deletedCount++;
    }

    // Write back
    fs.writeFileSync(docXmlPath, buildFormattedXml(docNodes), "utf-8");

    const [, packMsg] = await pack(unpackDir, outputPath, { validate: false });
    if (packMsg.startsWith("Error")) {
      return { success: false, output: packMsg };
    }

    return {
      success: true,
      output: `Deleted ${deletedCount} paragraph(s) as tracked changes by ${author}.`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 10. docxReviewChanges
// ---------------------------------------------------------------------------

export async function docxReviewChanges(params: {
  path: string;
  action: "reject" | "restore";
  changeIndex: number;
  author?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const action = params.action;
  const changeIndex = params.changeIndex;
  const author = params.author ?? "Claude";
  const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
  let tmpDir: string | undefined;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    tmpDir = makeTempDir();
    const unpackDir = path.join(tmpDir, "unpacked");
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {
      mergeRuns: true,
      simplifyRedlines: true,
    });

    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    const docXmlPath = path.join(unpackDir, "word", "document.xml");
    if (!fs.existsSync(docXmlPath)) {
      return { success: false, output: "Error: document.xml not found in DOCX" };
    }

    const docContent = fs.readFileSync(docXmlPath, "utf-8");
    const docNodes = parseXml(docContent);

    const trackedChanges = collectTrackedChangeNodes(docNodes);

    if (trackedChanges.length === 0) {
      return { success: false, output: "Error: No tracked changes found in document" };
    }

    if (changeIndex < 0 || changeIndex >= trackedChanges.length) {
      return {
        success: false,
        output: `Error: Change index ${changeIndex} out of range (0-${trackedChanges.length - 1})`,
      };
    }

    const change = trackedChanges[changeIndex];
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    let nextId = getNextWId(docNodes);

    if (action === "reject") {
      if (change.type === "ins") {
        // Reject insertion: convert w:t → w:delText and wrap in w:del
        const insTag = getTagName(change.node)!;
        const insChildren = Array.isArray(change.node[insTag]) ? change.node[insTag] : [];

        const convertedChildren = insChildren.map((child: any) => {
          const childTag = getTagName(child);
          if (childTag && getLocalName(childTag) === "r") {
            return convertRunToDeleted(child);
          }
          return child;
        });

        const modifiedIns: any = { [insTag]: convertedChildren };
        if (change.node[":@"]) modifiedIns[":@"] = change.node[":@"];

        const delWrapper = {
          "w:del": [modifiedIns],
          ":@": {
            "@_w:id": String(nextId),
            "@_w:author": author,
            "@_w:date": ts,
          },
        };

        change.parentArray[change.indexInParent] = delWrapper;
      } else {
        return {
          success: false,
          output: "Error: Cannot reject a deletion. Use action \"restore\" for deletions.",
        };
      }
    } else if (action === "restore") {
      if (change.type === "del") {
        // Restore deletion: insert w:ins with same text after the w:del
        const delTag = getTagName(change.node)!;
        const delChildren = Array.isArray(change.node[delTag]) ? change.node[delTag] : [];

        const textParts: string[] = [];
        let rPrChildren: any[] | null = null;

        for (const child of delChildren) {
          const childTag = getTagName(child);
          if (!childTag) continue;
          if (getLocalName(childTag) === "r") {
            if (Array.isArray(child[childTag])) {
              for (const rc of child[childTag]) {
                const rcTag = getTagName(rc);
                if (!rcTag) continue;
                if (getLocalName(rcTag) === "rPr" && !rPrChildren) {
                  rPrChildren = cloneNodes(rc[rcTag]);
                }
                if (getLocalName(rcTag) === "delText") {
                  textParts.push(getTextContent(rc));
                }
              }
            }
          }
        }

        if (textParts.length === 0) {
          return { success: false, output: "Error: No text found in deletion to restore" };
        }

        const restoredText = textParts.join("");
        const insNode = makeInsNode(restoredText, author, ts, nextId, rPrChildren);

        // Insert w:ins after the w:del
        change.parentArray.splice(change.indexInParent + 1, 0, insNode);
      } else {
        return {
          success: false,
          output: "Error: Cannot restore an insertion. Use action \"reject\" for insertions.",
        };
      }
    }

    // Write back
    fs.writeFileSync(docXmlPath, buildFormattedXml(docNodes), "utf-8");

    const [, packMsg] = await pack(unpackDir, outputPath, { validate: false });
    if (packMsg.startsWith("Error")) {
      return { success: false, output: packMsg };
    }

    const changeDesc = change.type === "ins" ? "insertion" : "deletion";
    const actionDesc = action === "reject" ? "Rejected" : "Restored";
    const displayText = change.text.length > 50 ? change.text.slice(0, 50) + "..." : change.text;

    return {
      success: true,
      output: `${actionDesc} ${changeDesc} "${displayText}" by ${change.author}.`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 11. docxInsertImage
// ---------------------------------------------------------------------------

export async function docxInsertImage(params: {
  path: string;
  imagePath: string;
  paragraphIndex: number;
  width?: number;
  height?: number;
  altText?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const imagePath = params.imagePath;
  const paragraphIndex = params.paragraphIndex;
  const widthPx = params.width ?? 400;
  const heightPx = params.height ?? 300;
  const altText = params.altText ?? "Image";
  const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
  let tmpDir: string | undefined;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }
    if (!fs.existsSync(imagePath)) {
      return { success: false, output: `Error: Image file not found: ${imagePath}` };
    }

    tmpDir = makeTempDir();
    const unpackDir = path.join(tmpDir, "unpacked");
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {
      mergeRuns: false,
      simplifyRedlines: false,
    });

    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    const docXmlPath = path.join(unpackDir, "word", "document.xml");
    if (!fs.existsSync(docXmlPath)) {
      return { success: false, output: "Error: document.xml not found in DOCX" };
    }

    const docContent = fs.readFileSync(docXmlPath, "utf-8");
    const docNodes = parseXml(docContent);

    // Validate paragraph index
    const paraInfo = findParagraphWithParent(docNodes, paragraphIndex);
    if (!paraInfo) {
      const totalParagraphs = collectParagraphNodes(docNodes).length;
      return {
        success: false,
        output: `Error: Paragraph index ${paragraphIndex} out of range (0-${totalParagraphs - 1})`,
      };
    }

    // Copy image to word/media/
    const mediaDir = path.join(unpackDir, "word", "media");
    fs.mkdirSync(mediaDir, { recursive: true });

    const imageExt = path.extname(imagePath).toLowerCase();
    const existingMedia = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
    const imageNum = existingMedia.length + 1;
    const imageName = `image${imageNum}${imageExt}`;
    fs.copyFileSync(imagePath, path.join(mediaDir, imageName));

    // Add relationship in document.xml.rels
    const relsPath = path.join(unpackDir, "word", "_rels", "document.xml.rels");
    const nextRid = commentInternal.getNextRid(relsPath);
    const rId = `rId${nextRid}`;

    const relsContent = fs.readFileSync(relsPath, "utf-8");
    const relsNodes = parseXml(relsContent);

    for (const node of relsNodes) {
      if (getTagName(node) === "Relationships") {
        if (!Array.isArray(node["Relationships"])) node["Relationships"] = [];
        node["Relationships"].push({
          Relationship: [],
          ":@": {
            "@_Id": rId,
            "@_Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
            "@_Target": `media/${imageName}`,
          },
        });
        break;
      }
    }

    fs.writeFileSync(relsPath, buildFormattedXml(relsNodes), "utf-8");

    // Add content type for image extension if needed
    const ctPath = path.join(unpackDir, "[Content_Types].xml");
    const extNoDot = imageExt.slice(1);
    ensureImageContentType(ctPath, extNoDot);

    // Dimensions in EMU (1 pixel at 96 DPI = 9525 EMU)
    const EMU_PER_PX = 9525;
    const cx = widthPx * EMU_PER_PX;
    const cy = heightPx * EMU_PER_PX;

    const docPrId = getNextDocPrId(docNodes);
    const hexId = commentInternal.generateHexId();

    // Build the drawing XML as a standalone fragment
    const drawingXml =
      `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"` +
      ` xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"` +
      ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
      ` xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"` +
      ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` +
      ` xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"` +
      ` w14:paraId="${hexId}" w14:textId="77777777">` +
      `<w:r>` +
      `<w:drawing>` +
      `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:docPr id="${docPrId}" name="Picture ${docPrId}" descr="${escapeXmlAttr(altText)}"/>` +
      `<wp:cNvGraphicFramePr>` +
      `<a:graphicFrameLocks noChangeAspect="1"/>` +
      `</wp:cNvGraphicFramePr>` +
      `<a:graphic>` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic>` +
      `<pic:nvPicPr>` +
      `<pic:cNvPr id="0" name="${escapeXmlAttr(imageName)}"/>` +
      `<pic:cNvPicPr/>` +
      `</pic:nvPicPr>` +
      `<pic:blipFill>` +
      `<a:blip r:embed="${rId}"/>` +
      `<a:stretch><a:fillRect/></a:stretch>` +
      `</pic:blipFill>` +
      `<pic:spPr>` +
      `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `</pic:spPr>` +
      `</pic:pic>` +
      `</a:graphicData>` +
      `</a:graphic>` +
      `</wp:inline>` +
      `</w:drawing>` +
      `</w:r>` +
      `</w:p>`;

    const drawingNodes = parseXml(drawingXml);
    // Strip namespace declarations from parsed node (they're on the root document element)
    for (const node of drawingNodes) {
      stripNamespaceDecls(node);
    }

    // Insert the new paragraph after the target paragraph
    const { parentArray, indexInParent } = paraInfo;
    parentArray.splice(indexInParent + 1, 0, ...drawingNodes);

    // Ensure the document root has required namespaces
    ensureNamespaces(docNodes, {
      "@_xmlns:a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "@_xmlns:pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    });

    // Write back
    fs.writeFileSync(docXmlPath, buildFormattedXml(docNodes), "utf-8");

    const [, packMsg] = await pack(unpackDir, outputPath, { validate: false });
    if (packMsg.startsWith("Error")) {
      return { success: false, output: packMsg };
    }

    return {
      success: true,
      output: `Inserted image after paragraph ${paragraphIndex}: ${path.basename(imagePath)} (${widthPx}x${heightPx}px)`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  } finally {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 12. docxConvertToImages
// ---------------------------------------------------------------------------

export async function docxConvertToImages(params: {
  path: string;
  format?: "jpeg" | "png";
  dpi?: number;
  outputDir?: string;
}): Promise<ToolResult> {
  const inputPath = params.path;
  const format = params.format ?? "jpeg";
  const dpi = params.dpi ?? 150;

  try {
    if (!fs.existsSync(inputPath)) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const outputDir = params.outputDir ?? path.join(path.dirname(inputPath), "images");
    fs.mkdirSync(outputDir, { recursive: true });

    // Step 1: Convert DOCX to PDF via soffice
    const pdfDir = makeTempDir();
    try {
      const sofficeResult = runSoffice(
        ["--headless", "--convert-to", "pdf", path.resolve(inputPath)],
        { cwd: pdfDir, timeout: 60000 }
      );

      if (sofficeResult.error) {
        if ((sofficeResult.error as any).code === "ENOENT") {
          return { success: false, output: "Error: LibreOffice (soffice) not found. Please install LibreOffice." };
        }
        return { success: false, output: `Error: ${sofficeResult.error.message}` };
      }

      if (sofficeResult.status !== 0) {
        return { success: false, output: `Error: LibreOffice conversion failed: ${sofficeResult.stderr || sofficeResult.stdout}` };
      }

      const pdfBasename = path.basename(inputPath, path.extname(inputPath)) + ".pdf";
      const pdfPath = path.join(pdfDir, pdfBasename);

      if (!fs.existsSync(pdfPath)) {
        return { success: false, output: "Error: PDF conversion produced no output" };
      }

      // Step 2: Convert PDF to images via pdftoppm
      const prefix = path.join(outputDir, "page");
      const pdftoppmArgs = ["-r", String(dpi)];
      if (format === "jpeg") {
        pdftoppmArgs.push("-jpeg");
      } else {
        pdftoppmArgs.push("-png");
      }
      pdftoppmArgs.push(pdfPath, prefix);

      const pdftoppmResult = spawnSync("pdftoppm", pdftoppmArgs, {
        encoding: "utf-8",
        timeout: 120000,
      });

      if (pdftoppmResult.error) {
        if ((pdftoppmResult.error as any).code === "ENOENT") {
          return { success: false, output: "Error: pdftoppm not found. Please install poppler-utils." };
        }
        return { success: false, output: `Error: ${pdftoppmResult.error.message}` };
      }

      if (pdftoppmResult.status !== 0) {
        return { success: false, output: `Error: pdftoppm conversion failed: ${pdftoppmResult.stderr}` };
      }

      // Collect output files
      const ext = format === "jpeg" ? "jpg" : "png";
      const outputFiles = fs.readdirSync(outputDir)
        .filter(f => f.startsWith("page") && f.endsWith(`.${ext}`))
        .sort()
        .map(f => path.join(outputDir, f));

      if (outputFiles.length === 0) {
        return { success: false, output: "Error: No images generated" };
      }

      return {
        success: true,
        output: `Converted ${path.basename(inputPath)} to ${outputFiles.length} ${format.toUpperCase()} image(s) at ${dpi} DPI in ${outputDir}`,
        outputPath: outputDir,
      };
    } finally {
      fs.rmSync(pdfDir, { recursive: true, force: true });
    }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Main entry point for IPC handler. */
export async function handleDocxTool(
  toolName: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "docxRead":
      return docxRead(params as { path: string });
    case "docxAddComment":
      return docxAddComment(
        params as {
          path: string;
          paragraphIndex: number;
          paragraphIndexEnd?: number;
          text: string;
          author?: string;
          outputPath?: string;
          parentCommentId?: number;
        }
      );
    case "docxRedline":
      return docxRedline(
        params as {
          path: string;
          changes: Array<{ find: string; replace: string; paragraphIndex?: number }>;
          author?: string;
          outputPath?: string;
          matchAll?: boolean;
        }
      );
    case "docxValidate":
      return docxValidate(
        params as { path: string; autoRepair?: boolean }
      );
    case "docxSimplify":
      return docxSimplify(
        params as { path: string; outputPath?: string }
      );
    case "docxAcceptChanges":
      return docxAcceptChanges(
        params as { path: string; outputPath?: string }
      );
    case "docxConvert":
      return docxConvert(
        params as { path: string; format: "pdf" | "html" | "txt" | "rtf" | "docx"; outputPath?: string }
      );
    case "docxCreate":
      return docxCreate(
        params as Parameters<typeof docxCreate>[0]
      );
    case "docxDeleteParagraph":
      return docxDeleteParagraph(
        params as {
          path: string;
          paragraphIndices: number[];
          author?: string;
          outputPath?: string;
        }
      );
    case "docxReviewChanges":
      return docxReviewChanges(
        params as {
          path: string;
          action: "reject" | "restore";
          changeIndex: number;
          author?: string;
          outputPath?: string;
        }
      );
    case "docxInsertImage":
      return docxInsertImage(
        params as {
          path: string;
          imagePath: string;
          paragraphIndex: number;
          width?: number;
          height?: number;
          altText?: string;
          outputPath?: string;
        }
      );
    case "docxConvertToImages":
      return docxConvertToImages(
        params as {
          path: string;
          format?: "jpeg" | "png";
          dpi?: number;
          outputDir?: string;
        }
      );
    default:
      return { success: false, output: `Unknown tool: ${toolName}` };
  }
}
