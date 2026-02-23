import * as fs from "fs";
import * as path from "path";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { MD_DEFAULTS } from "./configs";
import {
  MdPipeline,
  MD_STEP_INTERMEDIATE,
  MD_STEP_OUTPUT,
  MD_STEP_PARSED,
  MD_STEP_SOURCE,
  mdPipelineFromTaskDir,
} from "./pipeline";
import type { ToolResult } from "./types";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


export type { MdToolResult, ToolResult } from "./types";

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue =
  | FrontmatterScalar
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };
export type Frontmatter = Record<string, FrontmatterValue>;

export type MarkdownInlineRun = {
  text?: string;
  markdown?: string;
  html?: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  highlight?: boolean;
  subscript?: boolean;
  superscript?: boolean;
  code?: boolean;
  link?: {
    url: string;
    title?: string;
  };
  footnote_ref?: string;
  footnoteRef?: string;
  line_break?: boolean;
  lineBreak?: boolean;
};

export type HeadingBlock = {
  heading: {
    level?: number;
    text: string;
    id?: string;
  };
};

export type MarkdownListItemInput =
  | string
  | {
      text?: string;
      markdown?: string;
      runs?: MarkdownInlineRun[];
      checked?: boolean;
      children?: {
        ordered?: boolean;
        start?: number;
        items: MarkdownListItemInput[];
      };
    };

export type ParagraphBlock = {
  paragraph: {
    text?: string;
    runs?: MarkdownInlineRun[];
  };
};

export type ListBlock = {
  list: {
    items: MarkdownListItemInput[];
    ordered?: boolean;
    start?: number;
    task?: boolean;
    checked?: boolean[];
  };
};

export type CodeBlock = {
  code: {
    code: string;
    language?: string;
  };
};

export type QuoteBlock = {
  quote: {
    text: string | string[];
  };
};

export type TableBlock = {
  table: {
    headers: MarkdownTableCellInput[];
    rows: MarkdownTableCellInput[][];
    align?: Array<"left" | "center" | "right">;
  };
};

export type DefinitionListBlock = {
  definition_list: {
    items: Array<{
      term: string;
      definitions: MarkdownTableCellInput[];
    }>;
  };
};

export type FootnoteBlock = {
  footnote: {
    id: string;
    text?: string;
    markdown?: string;
    content?: MarkdownContentBlock[];
  };
};

export type HtmlBlock = {
  html: {
    html: string;
  };
};

export type RawMarkdownBlock = {
  raw_markdown: {
    markdown: string;
  };
};

export type HrBlock = {
  hr: Record<string, never>;
};

export type ImageBlock = {
  image: {
    alt: string;
    src: string;
    title?: string;
  };
};

export type MarkdownTableCellInput =
  | string
  | {
      text?: string;
      runs?: MarkdownInlineRun[];
      markdown?: string;
      raw_markdown?: string;
    };

export type MarkdownContentBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | CodeBlock
  | QuoteBlock
  | TableBlock
  | DefinitionListBlock
  | FootnoteBlock
  | HtmlBlock
  | HrBlock
  | ImageBlock
  | RawMarkdownBlock;

type ExtractedFrontmatter = {
  hasFrontmatter: boolean;
  frontmatter: Frontmatter | null;
  frontmatterRaw: string | null;
  body: string;
  bodyLineOffset: number;
};

type PathContext = {
  workingDirectory: string | null;
};

type HeadingInfo = {
  level: number;
  text: string;
  line: number;
};

export type HeadingSelector = {
  heading?: string;
  heading_path?: string[];
  occurrence?: number;
  line_start?: number;
  line_end?: number;
};

type HeadingEntry = {
  idx: number;
  depth: number;
  text: string;
  normalizedText: string;
  line: number;
  path: string[];
  sectionStart: number;
  sectionEnd: number;
};

type MdNode = Record<string, any>;

function createProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStringify, {
      bullet: "-",
      fences: true,
      listItemIndent: "one",
    });
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function defaultOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  return path.join(dir, `${base}_modified${ext || ".md"}`);
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isSubPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createPathContext(workingDirectory?: string): PathContext {
  if (!workingDirectory) return { workingDirectory: null };
  const resolved = path.resolve(workingDirectory);
  if (!fs.existsSync(resolved)) {
    throw new Error(`working_directory not found: ${workingDirectory}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`working_directory is not a directory: ${workingDirectory}`);
  }
  return { workingDirectory: fs.realpathSync(resolved) };
}

function resolveInputPath(filePath: string, context: PathContext): string {
  if (!filePath || !filePath.trim()) {
    throw new Error("path is required");
  }
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  return path.resolve(context.workingDirectory ?? process.cwd(), filePath);
}

function ensureWithinWorkingDirectory(targetPath: string, context: PathContext): void {
  if (!context.workingDirectory) return;
  if (!isSubPath(context.workingDirectory, targetPath)) {
    throw new Error(`Path escapes working_directory: ${targetPath}`);
  }
}

function ensureNoSymlinkOnExistingSegments(targetPath: string, context: PathContext): void {
  if (!context.workingDirectory) return;

  let current = targetPath;
  while (isSubPath(context.workingDirectory, current)) {
    if (fs.existsSync(current)) {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink paths are not allowed in working_directory: ${targetPath}`);
      }
    }

    if (current === context.workingDirectory) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function resolveReadPath(filePath: string, context: PathContext): string {
  const resolved = resolveInputPath(filePath, context);
  ensureWithinWorkingDirectory(resolved, context);
  if (!fs.existsSync(resolved)) {
    return resolved;
  }

  ensureNoSymlinkOnExistingSegments(resolved, context);
  if (context.workingDirectory) {
    const realResolved = fs.realpathSync(resolved);
    if (!isSubPath(context.workingDirectory, realResolved)) {
      throw new Error(`Resolved path escapes working_directory: ${realResolved}`);
    }
    return realResolved;
  }
  return resolved;
}

function resolveWritePath(filePath: string, context: PathContext): string {
  const resolved = resolveInputPath(filePath, context);
  ensureWithinWorkingDirectory(resolved, context);
  ensureNoSymlinkOnExistingSegments(resolved, context);

  if (context.workingDirectory) {
    let nearestExisting = path.dirname(resolved);
    while (!fs.existsSync(nearestExisting)) {
      const parent = path.dirname(nearestExisting);
      if (parent === nearestExisting) break;
      nearestExisting = parent;
    }
    if (fs.existsSync(nearestExisting)) {
      const realNearest = fs.realpathSync(nearestExisting);
      if (!isSubPath(context.workingDirectory, realNearest)) {
        throw new Error(`Resolved parent path escapes working_directory: ${realNearest}`);
      }
    }
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    throw new Error(`Path is a directory: ${resolved}`);
  }

  return resolved;
}

function clampHeadingLevel(level: number | undefined): number {
  if (!level || !Number.isFinite(level)) return 1;
  return Math.max(1, Math.min(6, Math.trunc(level)));
}

function yamlEscapeString(value: string): string {
  if (value.length === 0) return '""';
  if (value === "null" || value === "true" || value === "false" || /^-?\d+(\.\d+)?$/.test(value)) {
    return JSON.stringify(value);
  }
  if (/[:#\n\r"'{}\[\],&*!?|<>=%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function formatFrontmatterScalar(value: FrontmatterScalar): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return yamlEscapeString(value);
}

function isPlainObject(value: unknown): value is Record<string, FrontmatterValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatFrontmatterKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : yamlEscapeString(key);
}

function serializeFrontmatterValue(value: FrontmatterValue, indent: number): string[] {
  const sp = " ".repeat(indent);
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return [`${sp}${formatFrontmatterScalar(value as FrontmatterScalar)}`];
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${sp}[]`];
    const lines: string[] = [];
    for (const item of value) {
      const itemIsScalar =
        item === null || typeof item === "boolean" || typeof item === "number" || typeof item === "string";
      if (itemIsScalar) {
        lines.push(`${sp}- ${formatFrontmatterScalar(item as FrontmatterScalar)}`);
        continue;
      }
      lines.push(`${sp}-`);
      lines.push(...serializeFrontmatterValue(item, indent + 2));
    }
    return lines;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return [`${sp}{}`];

  const lines: string[] = [];
  for (const [key, nested] of entries) {
    const nestedIsScalar =
      nested === null || typeof nested === "boolean" || typeof nested === "number" || typeof nested === "string";
    if (nestedIsScalar) {
      lines.push(`${sp}${formatFrontmatterKey(key)}: ${formatFrontmatterScalar(nested as FrontmatterScalar)}`);
      continue;
    }
    if (Array.isArray(nested) && nested.length === 0) {
      lines.push(`${sp}${formatFrontmatterKey(key)}: []`);
      continue;
    }
    if (isPlainObject(nested) && Object.keys(nested).length === 0) {
      lines.push(`${sp}${formatFrontmatterKey(key)}: {}`);
      continue;
    }
    lines.push(`${sp}${formatFrontmatterKey(key)}:`);
    lines.push(...serializeFrontmatterValue(nested, indent + 2));
  }
  return lines;
}

function renderFrontmatter(frontmatter: Frontmatter): string {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return "";

  const lines = ["---", ...serializeFrontmatterValue(frontmatter, 0)];
  lines.push("---", "");
  return lines.join("\n");
}

function parseScalar(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed) as FrontmatterValue;
    } catch {
      return trimmed;
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function countIndent(line: string): number {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function parseInlineKeyValue(line: string): { key: string; value: string } | null {
  const sep = line.indexOf(":");
  if (sep === -1) return null;
  const key = line.slice(0, sep).trim();
  const value = line.slice(sep + 1).trim();
  if (!key) return null;
  return { key, value };
}

function parseYamlBlock(
  lines: string[],
  startIndex: number,
  indent: number
): { value: FrontmatterValue; nextIndex: number } {
  let i = startIndex;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("#")) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= lines.length) return { value: {}, nextIndex: i };

  const firstIndent = countIndent(lines[i]);
  const firstContent = lines[i].slice(firstIndent);
  const parseAsList = firstIndent === indent && firstContent.startsWith("- ");

  if (parseAsList) {
    const out: FrontmatterValue[] = [];
    while (i < lines.length) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        i += 1;
        continue;
      }
      const lineIndent = countIndent(raw);
      if (lineIndent < indent) break;
      if (lineIndent !== indent || !raw.slice(lineIndent).startsWith("- ")) break;

      const itemContent = raw.slice(lineIndent + 2).trim();
      if (itemContent === "") {
        const nested = parseYamlBlock(lines, i + 1, indent + 2);
        out.push(nested.value);
        i = nested.nextIndex;
        continue;
      }

      const keyValue = parseInlineKeyValue(itemContent);
      if (keyValue) {
        const obj: Record<string, FrontmatterValue> = {};
        if (keyValue.value === "") {
          const nested = parseYamlBlock(lines, i + 1, indent + 4);
          obj[keyValue.key] = nested.value;
          i = nested.nextIndex;
        } else {
          obj[keyValue.key] = parseScalar(keyValue.value);
          i += 1;
        }

        while (i < lines.length) {
          const line = lines[i];
          const t = line.trim();
          if (t === "" || t.startsWith("#")) {
            i += 1;
            continue;
          }
          const lineInd = countIndent(line);
          if (lineInd < indent + 2) break;
          if (lineInd !== indent + 2) break;
          if (line.slice(lineInd).startsWith("- ")) break;
          const kv = parseInlineKeyValue(line.slice(lineInd));
          if (!kv) break;
          if (kv.value === "") {
            const nested = parseYamlBlock(lines, i + 1, indent + 4);
            obj[kv.key] = nested.value;
            i = nested.nextIndex;
          } else {
            obj[kv.key] = parseScalar(kv.value);
            i += 1;
          }
        }

        out.push(obj);
        continue;
      }

      out.push(parseScalar(itemContent));
      i += 1;
    }
    return { value: out, nextIndex: i };
  }

  const out: Record<string, FrontmatterValue> = {};
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    const lineIndent = countIndent(raw);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      i += 1;
      continue;
    }

    const kv = parseInlineKeyValue(raw.slice(lineIndent));
    if (!kv) {
      i += 1;
      continue;
    }

    if (kv.value === "") {
      const nested = parseYamlBlock(lines, i + 1, indent + 2);
      out[kv.key] = nested.value;
      i = nested.nextIndex;
    } else {
      out[kv.key] = parseScalar(kv.value);
      i += 1;
    }
  }

  return { value: out, nextIndex: i };
}

function extractFrontmatter(raw: string): ExtractedFrontmatter {
  const normalized = normalizeNewlines(raw);
  if (!normalized.startsWith("---\n")) {
    return {
      hasFrontmatter: false,
      frontmatter: null,
      frontmatterRaw: null,
      body: normalized,
      bodyLineOffset: 0,
    };
  }

  const lines = normalized.split("\n");
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return {
      hasFrontmatter: false,
      frontmatter: null,
      frontmatterRaw: null,
      body: normalized,
      bodyLineOffset: 0,
    };
  }

  const fmLines = lines.slice(1, endIdx);
  const parsed = parseYamlBlock(fmLines, 0, 0).value;
  const frontmatter = isPlainObject(parsed) ? parsed : {};
  const frontmatterRaw = lines.slice(0, endIdx + 1).join("\n");

  const bodyStart = endIdx + 1;
  let body = lines.slice(bodyStart).join("\n");
  let bodyLineOffset = bodyStart;
  if (body.startsWith("\n")) {
    body = body.slice(1);
    bodyLineOffset += 1;
  }

  return { hasFrontmatter: true, frontmatter, frontmatterRaw, body, bodyLineOffset };
}

function textNode(value: string): MdNode {
  return { type: "text", value };
}

function paragraphNode(text: string): MdNode {
  return {
    type: "paragraph",
    children: [textNode(text)],
  };
}

function parseMarkdownNodes(markdown: string): MdNode[] {
  const tree = parseTree(markdown);
  return Array.isArray(tree.children) ? tree.children : [];
}

function parseInlineMarkdown(markdown: string): MdNode[] {
  const children = parseMarkdownNodes(markdown);
  const out: MdNode[] = [];
  for (const child of children) {
    if (child?.type === "paragraph" || child?.type === "heading") {
      if (Array.isArray(child.children) && child.children.length > 0) {
        out.push(...child.children);
      } else {
        out.push(textNode(nodeToText(child)));
      }
      continue;
    }
    if (child?.type === "html") {
      out.push({ type: "html", value: child.value ?? "" });
      continue;
    }
    out.push(textNode(nodeToText(child)));
  }
  if (out.length === 0) return [textNode(markdown)];
  return out;
}

function wrapInlineWithHtmlTag(tagName: "u" | "mark" | "sub" | "sup", children: MdNode[]): MdNode[] {
  if (children.length === 0) return [];
  return [{ type: "html", value: `<${tagName}>` }, ...children, { type: "html", value: `</${tagName}>` }];
}

function wrapInlineNode(type: "strong" | "emphasis" | "delete", children: MdNode[]): MdNode[] {
  if (children.length === 0) return [];
  return [{ type, children }];
}

function normalizeInlineText(text: string): string {
  return normalizeNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .trim();
}

function buildFootnoteReferenceNode(rawIdentifier: string): MdNode {
  const identifier = rawIdentifier.trim();
  if (!identifier) {
    throw new Error("footnote_ref cannot be empty");
  }
  return {
    type: "footnoteReference",
    identifier,
    label: identifier,
  };
}

function inlineRunToNodes(run: MarkdownInlineRun): MdNode[] {
  const footnoteRef = run.footnote_ref ?? run.footnoteRef;
  let nodes: MdNode[] = [];
  const baseText = run.text ?? "";
  if (run.html) {
    nodes.push({ type: "html", value: run.html });
  } else if (typeof run.markdown === "string") {
    nodes.push(...parseInlineMarkdown(run.markdown));
  } else if (baseText.length > 0) {
    nodes.push(...parseInlineMarkdown(baseText));
  }

  if (run.code) {
    const codeValue = typeof run.markdown === "string" ? run.markdown : baseText;
    nodes = [{ type: "inlineCode", value: codeValue }];
  } else {
    if (run.bold) nodes = wrapInlineNode("strong", nodes);
    if (run.italic) nodes = wrapInlineNode("emphasis", nodes);
    if (run.strikethrough) nodes = wrapInlineNode("delete", nodes);
    if (run.link) {
      nodes = [
        {
          type: "link",
          url: run.link.url,
          title: run.link.title ?? null,
          children: nodes.length > 0 ? nodes : [textNode(run.link.url)],
        },
      ];
    }
    if (run.underline) nodes = wrapInlineWithHtmlTag("u", nodes);
    if (run.highlight) nodes = wrapInlineWithHtmlTag("mark", nodes);
    if (run.subscript) nodes = wrapInlineWithHtmlTag("sub", nodes);
    if (run.superscript) nodes = wrapInlineWithHtmlTag("sup", nodes);
  }

  if (footnoteRef) {
    nodes.push(buildFootnoteReferenceNode(footnoteRef));
  }
  if (run.line_break || run.lineBreak) {
    nodes.push({ type: "break" });
  }

  return nodes.length > 0 ? nodes : [textNode("")];
}

function runsToInlineNodes(runs: MarkdownInlineRun[]): MdNode[] {
  const nodes = runs.flatMap((run) => inlineRunToNodes(run));
  return nodes.length > 0 ? nodes : [textNode("")];
}

function cellToInlineNodes(cell: MarkdownTableCellInput): MdNode[] {
  if (typeof cell === "string") {
    return parseInlineMarkdown(String(cell ?? ""));
  }
  if (typeof cell.raw_markdown === "string") {
    return parseInlineMarkdown(cell.raw_markdown);
  }
  if (typeof cell.markdown === "string") {
    return parseInlineMarkdown(cell.markdown);
  }
  if (Array.isArray(cell.runs) && cell.runs.length > 0) {
    return runsToInlineNodes(cell.runs);
  }
  if (typeof cell.text === "string") {
    return parseInlineMarkdown(cell.text);
  }
  return [textNode("")];
}

function inlineNodesToMarkdown(nodes: MdNode[]): string {
  const root: MdNode = {
    type: "root",
    children: [{ type: "paragraph", children: nodes.length > 0 ? nodes : [textNode("")] }],
  };
  return stringifyTree(root).replace(/\n$/, "");
}

function listItemInputToNodes(item: MarkdownListItemInput): MdNode[] {
  if (typeof item === "string") {
    return parseInlineMarkdown(normalizeInlineText(item));
  }
  if (typeof item.markdown === "string") {
    return parseInlineMarkdown(item.markdown);
  }
  if (Array.isArray(item.runs) && item.runs.length > 0) {
    return runsToInlineNodes(item.runs);
  }
  return parseInlineMarkdown(normalizeInlineText(item.text ?? ""));
}

function buildListNode(config: {
  ordered?: boolean;
  start?: number;
  task?: boolean;
  checked?: boolean[];
  items: MarkdownListItemInput[];
}): MdNode {
  return {
    type: "list",
    ordered: config.ordered ?? false,
    start: config.ordered ? config.start ?? 1 : undefined,
    spread: false,
    children: config.items.map((item, idx) => {
      const itemObj = typeof item === "string" ? null : item;
      const inlineNodes = listItemInputToNodes(item);
      const children: MdNode[] = [{ type: "paragraph", children: inlineNodes }];

      if (itemObj?.children?.items?.length) {
        children.push(
          buildListNode({
            ordered: itemObj.children.ordered,
            start: itemObj.children.start,
            items: itemObj.children.items,
          })
        );
      }

      const checkedValue =
        config.task || typeof itemObj?.checked === "boolean" || typeof config.checked?.[idx] === "boolean"
          ? (itemObj?.checked ?? config.checked?.[idx] ?? false)
          : undefined;

      return {
        type: "listItem",
        checked: checkedValue,
        spread: false,
        children,
      };
    }),
  };
}

function buildDefinitionListMarkdown(block: DefinitionListBlock["definition_list"]): string {
  const lines: string[] = [];
  for (const item of block.items) {
    const term = item.term.trim();
    if (!term) continue;
    lines.push(term);

    const defs = item.definitions.length > 0 ? item.definitions : [""];
    for (const def of defs) {
      const defNodes = cellToInlineNodes(def);
      const markdown = inlineNodesToMarkdown(defNodes).trim();
      const segments = markdown.length > 0 ? markdown.split("\n") : [""];
      lines.push(`: ${segments[0]}`);
      for (let i = 1; i < segments.length; i++) {
        lines.push(`  ${segments[i]}`);
      }
    }

    lines.push("");
  }
  return lines.join("\n").trim();
}

function contentBlockToNodes(block: MarkdownContentBlock): MdNode[] {
  if ("heading" in block) {
    const headingText = block.heading.text.trim();
    const headingId = block.heading.id?.trim();
    return [
      {
        type: "heading",
        depth: clampHeadingLevel(block.heading.level),
        children: [textNode(headingId ? `${headingText} {#${headingId}}` : headingText)],
      },
    ];
  }

  if ("paragraph" in block) {
    if (Array.isArray(block.paragraph.runs) && block.paragraph.runs.length > 0) {
      return [{ type: "paragraph", children: runsToInlineNodes(block.paragraph.runs) }];
    }
    const chunks = normalizeNewlines(block.paragraph.text ?? "")
      .split(/\n{2,}/g)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    return chunks.map((chunk) => ({ type: "paragraph", children: parseInlineMarkdown(chunk) }));
  }

  if ("list" in block) {
    return [buildListNode(block.list)];
  }

  if ("code" in block) {
    return [
      {
        type: "code",
        lang: block.code.language?.trim() || null,
        value: normalizeNewlines(block.code.code),
      },
    ];
  }

  if ("quote" in block) {
    const lines = Array.isArray(block.quote.text)
      ? block.quote.text
      : normalizeNewlines(block.quote.text).split("\n");
    const children = lines.filter((line) => line.trim() !== "").map((line) => paragraphNode(line.trim()));
    return [
      {
        type: "blockquote",
        children: children.length > 0 ? children : [paragraphNode("")],
      },
    ];
  }

  if ("table" in block) {
    const rowToCellNodes = (row: MarkdownTableCellInput[]): MdNode[] =>
      row.map((cell) => ({
        type: "tableCell",
        children: cellToInlineNodes(cell),
      }));

    const headerRow = rowToCellNodes(block.table.headers);
    const bodyRows = block.table.rows.map((row) => rowToCellNodes(row));

    return [
      {
        type: "table",
        align: block.table.align ?? null,
        children: [
          { type: "tableRow", children: headerRow },
          ...bodyRows.map((cells) => ({ type: "tableRow", children: cells })),
        ],
      },
    ];
  }

  if ("definition_list" in block) {
    const markdown = buildDefinitionListMarkdown(block.definition_list);
    return markdown ? parseMarkdownNodes(markdown) : [];
  }

  if ("footnote" in block) {
    const identifier = block.footnote.id?.trim();
    if (!identifier) {
      throw new Error("footnote.id is required");
    }
    let children: MdNode[] = [];
    if (Array.isArray(block.footnote.content) && block.footnote.content.length > 0) {
      children = blocksToNodes(block.footnote.content);
    } else if (typeof block.footnote.markdown === "string") {
      children = parseMarkdownNodes(block.footnote.markdown);
    } else if (typeof block.footnote.text === "string") {
      children = [{ type: "paragraph", children: parseInlineMarkdown(block.footnote.text) }];
    }
    return [
      {
        type: "footnoteDefinition",
        identifier,
        label: identifier,
        children: children.length > 0 ? children : [paragraphNode("")],
      },
    ];
  }

  if ("html" in block) {
    return [{ type: "html", value: normalizeNewlines(block.html.html) }];
  }

  if ("hr" in block) {
    return [{ type: "thematicBreak" }];
  }

  if ("image" in block) {
    return [
      {
        type: "paragraph",
        children: [
          {
            type: "image",
            alt: block.image.alt,
            url: block.image.src,
            title: block.image.title ?? null,
          },
        ],
      },
    ];
  }

  if ("raw_markdown" in block) {
    return parseMarkdownNodes(block.raw_markdown.markdown);
  }

  return [];
}

function blocksToNodes(blocks: MarkdownContentBlock[]): MdNode[] {
  return blocks.flatMap((block) => contentBlockToNodes(block));
}

function stringifyTree(tree: MdNode): string {
  return String(createProcessor().stringify(tree as import("mdast").Root));
}

function parseTree(text: string): MdNode {
  const tree = createProcessor().parse(normalizeNewlines(text)) as MdNode;
  if (!tree || tree.type !== "root" || !Array.isArray(tree.children)) {
    throw new Error("Failed to parse markdown document");
  }
  return tree;
}

function nodeToText(node: MdNode): string {
  return toString(node as import("unist").Node, { includeImageAlt: false });
}

function collectHeadings(node: MdNode, acc: HeadingInfo[], lineOffset = 0): void {
  if (!node) return;
  visit(node as import("unist").Node, "heading", (heading: import("unist").Node) => {
    const line = Number(heading.position?.start?.line ?? 0);
    const adjustedLine = Number.isFinite(line) && line > 0 ? line + lineOffset : 0;
    acc.push({
      level: Number((heading as MdNode).depth ?? 1),
      text: nodeToText(heading as MdNode).trim(),
      line: adjustedLine,
    });
  });
}

function normalizeHeadingText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function slugifyHeadingAnchor(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "section";
}

function buildTocLines(
  headings: HeadingInfo[],
  options: {
    minDepth: number;
    maxDepth: number;
    ordered: boolean;
  }
): string[] {
  const slugCounts = new Map<string, number>();
  const filtered = headings.filter((heading) => heading.level >= options.minDepth && heading.level <= options.maxDepth);
  const lines: string[] = [];

  for (const heading of filtered) {
    const baseSlug = slugifyHeadingAnchor(heading.text);
    const seen = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, seen + 1);
    const finalSlug = seen === 0 ? baseSlug : `${baseSlug}-${seen}`;

    const indent = "  ".repeat(Math.max(0, heading.level - options.minDepth));
    const bullet = options.ordered ? "1." : "-";
    lines.push(`${indent}${bullet} [${heading.text}](#${finalSlug})`);
  }

  return lines;
}

function replaceBetweenMarkers(
  text: string,
  startMarker: string,
  endMarker: string,
  replacement: string
): { replaced: boolean; text: string } {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return { replaced: false, text };
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1 || endIdx < startIdx) return { replaced: false, text };

  const head = text.slice(0, startIdx + startMarker.length);
  const tail = text.slice(endIdx);
  return {
    replaced: true,
    text: `${head}\n${replacement}\n${tail}`,
  };
}

function buildHeadingEntries(tree: MdNode, lineOffset: number): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  const headingPath: string[] = [];
  const children: MdNode[] = Array.isArray(tree.children) ? tree.children : [];

  for (let idx = 0; idx < children.length; idx++) {
    const node = children[idx];
    if (node?.type !== "heading") continue;
    const depth = Number(node.depth ?? 1);
    const text = nodeToText(node).trim();
    const normalizedText = normalizeHeadingText(text);
    const localLine = Number(node.position?.start?.line ?? 0);
    const line = Number.isFinite(localLine) && localLine > 0 ? localLine + lineOffset : 0;

    headingPath.splice(Math.max(depth - 1, 0));
    headingPath[depth - 1] = normalizedText;
    const path = headingPath.filter(Boolean);

    entries.push({
      idx,
      depth,
      text,
      normalizedText,
      line,
      path,
      sectionStart: idx,
      sectionEnd: children.length,
    });
  }

  for (let i = 0; i < entries.length; i++) {
    const current = entries[i];
    let end = children.length;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].depth <= current.depth) {
        end = entries[j].idx;
        break;
      }
    }
    current.sectionEnd = end;
  }

  return entries;
}

function resolveHeadingEntry(
  tree: MdNode,
  lineOffset: number,
  selector?: HeadingSelector
): { entry: HeadingEntry; entries: HeadingEntry[] } {
  const entries = buildHeadingEntries(tree, lineOffset);
  if (entries.length === 0) {
    throw new Error("No headings found in document");
  }

  const occurrence = Math.max(1, Math.trunc(selector?.occurrence ?? 1));
  let candidates = entries;

  if (selector?.heading_path && selector.heading_path.length > 0) {
    const normalizedPath = selector.heading_path.map((part) => normalizeHeadingText(part));
    candidates = candidates.filter((entry) => {
      if (entry.path.length !== normalizedPath.length) return false;
      return entry.path.every((part, idx) => part === normalizedPath[idx]);
    });
  } else if (selector?.heading) {
    const normalizedHeading = normalizeHeadingText(selector.heading);
    candidates = candidates.filter((entry) => entry.normalizedText === normalizedHeading);
  }

  if (typeof selector?.line_start === "number") {
    candidates = candidates.filter((entry) => entry.line >= selector.line_start!);
  }
  if (typeof selector?.line_end === "number") {
    candidates = candidates.filter((entry) => entry.line <= selector.line_end!);
  }

  if (candidates.length === 0) {
    throw new Error("No heading matches the provided selector");
  }
  if (occurrence > candidates.length) {
    throw new Error(`Heading occurrence ${occurrence} out of range (matches: ${candidates.length})`);
  }

  return { entry: candidates[occurrence - 1], entries };
}

function buildSectionNodes(content: MarkdownContentBlock[]): MdNode[] {
  return blocksToNodes(content ?? []);
}

function buildUnifiedDiff(
  beforeText: string,
  afterText: string,
  beforeLabel = "before.md",
  afterLabel = "after.md"
): string {
  const before = normalizeNewlines(beforeText).split("\n");
  const after = normalizeNewlines(afterText).split("\n");
  const n = before.length;
  const m = after.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (before[i] === after[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: string[] = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push(` ${before[i]}`);
      i += 1;
      j += 1;
      continue;
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${before[i]}`);
      i += 1;
    } else {
      lines.push(`+${after[j]}`);
      j += 1;
    }
  }
  while (i < n) {
    lines.push(`-${before[i]}`);
    i += 1;
  }
  while (j < m) {
    lines.push(`+${after[j]}`);
    j += 1;
  }

  return lines.join("\n");
}

function formatMarkdownWhitespace(
  text: string,
  options?: {
    trim_trailing_spaces?: boolean;
    collapse_blank_lines?: boolean;
    ensure_trailing_newline?: boolean;
  }
): string {
  const trimTrailingSpaces = options?.trim_trailing_spaces ?? MD_DEFAULTS.format.trimTrailingSpaces;
  const collapseBlankLines = options?.collapse_blank_lines ?? MD_DEFAULTS.format.collapseBlankLines;
  const ensureTrailingNewline = options?.ensure_trailing_newline ?? MD_DEFAULTS.format.ensureTrailingNewline;

  const inputLines = normalizeNewlines(text).split("\n");
  const outputLines: string[] = [];
  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let blankStreak = 0;

  for (const rawLine of inputLines) {
    const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (fenceChar === marker) {
        inFence = false;
        fenceChar = null;
      }
    }

    const line = trimTrailingSpaces ? rawLine.replace(/[ \t]+$/g, "") : rawLine;
    const isBlank = line.trim() === "";

    if (!inFence && collapseBlankLines && isBlank) {
      blankStreak += 1;
      if (blankStreak > 1) continue;
    } else if (!isBlank) {
      blankStreak = 0;
    }

    outputLines.push(line);
  }

  let output = outputLines.join("\n").replace(/\n+$/g, "");
  if (ensureTrailingNewline) output += "\n";
  return output;
}

function buildDocumentText(
  frontmatter: Frontmatter | undefined,
  body: string,
  options?: {
    frontmatterRaw?: string | null;
    mode?: "preserve" | "normalize";
  }
): string {
  const fm =
    options?.frontmatterRaw && options.mode !== "normalize"
      ? `${options.frontmatterRaw}\n\n`
      : frontmatter && Object.keys(frontmatter).length > 0
        ? renderFrontmatter(frontmatter)
        : "";
  const merged = `${fm}${body.replace(/^\n+/, "")}`;
  return formatMarkdownWhitespace(merged, {
    trim_trailing_spaces: true,
    collapse_blank_lines: true,
    ensure_trailing_newline: true,
  });
}

type TransformAction =
  | "replace_section"
  | "delete_section"
  | "insert_before"
  | "insert_after"
  | "rename_heading"
  | "move_section";

type TransformParams = {
  action: TransformAction;
  selector?: HeadingSelector;
  target_selector?: HeadingSelector;
  target_position?: "before" | "after";
  content?: MarkdownContentBlock[];
  new_heading?: string;
};

function applyTransformToMarkdown(
  raw: string,
  params: TransformParams
): { updatedText: string; changeSummary: string } {
  const extracted = extractFrontmatter(raw);
  const tree = parseTree(extracted.body);
  const children: MdNode[] = Array.isArray(tree.children) ? tree.children : [];

  if (params.action === "replace_section") {
    const { entry } = resolveHeadingEntry(tree, extracted.bodyLineOffset, params.selector);
    const replacement = buildSectionNodes(params.content ?? []);
    children.splice(entry.sectionStart + 1, entry.sectionEnd - (entry.sectionStart + 1), ...replacement);
    return {
      updatedText: buildDocumentText(extracted.frontmatter ?? undefined, stringifyTree(tree), {
        frontmatterRaw: extracted.frontmatterRaw,
      }),
      changeSummary: `Replaced section body: ${entry.text}`,
    };
  }

  if (params.action === "delete_section") {
    const { entry } = resolveHeadingEntry(tree, extracted.bodyLineOffset, params.selector);
    children.splice(entry.sectionStart, entry.sectionEnd - entry.sectionStart);
    return {
      updatedText: buildDocumentText(extracted.frontmatter ?? undefined, stringifyTree(tree), {
        frontmatterRaw: extracted.frontmatterRaw,
      }),
      changeSummary: `Deleted section: ${entry.text}`,
    };
  }

  if (params.action === "insert_before" || params.action === "insert_after") {
    const { entry } = resolveHeadingEntry(tree, extracted.bodyLineOffset, params.selector);
    const insertNodes = buildSectionNodes(params.content ?? []);
    const insertAt = params.action === "insert_before" ? entry.sectionStart : entry.sectionEnd;
    children.splice(insertAt, 0, ...insertNodes);
    return {
      updatedText: buildDocumentText(extracted.frontmatter ?? undefined, stringifyTree(tree), {
        frontmatterRaw: extracted.frontmatterRaw,
      }),
      changeSummary: `${params.action === "insert_before" ? "Inserted before" : "Inserted after"} section: ${entry.text}`,
    };
  }

  if (params.action === "rename_heading") {
    const { entry } = resolveHeadingEntry(tree, extracted.bodyLineOffset, params.selector);
    if (!params.new_heading?.trim()) {
      throw new Error("new_heading is required for rename_heading");
    }
    const headingNode = children[entry.sectionStart];
    headingNode.children = [textNode(params.new_heading.trim())];
    return {
      updatedText: buildDocumentText(extracted.frontmatter ?? undefined, stringifyTree(tree), {
        frontmatterRaw: extracted.frontmatterRaw,
      }),
      changeSummary: `Renamed heading "${entry.text}" -> "${params.new_heading.trim()}"`,
    };
  }

  if (params.action === "move_section") {
    const { entry: sourceEntry } = resolveHeadingEntry(tree, extracted.bodyLineOffset, params.selector);
    const { entry: targetEntry } = resolveHeadingEntry(tree, extracted.bodyLineOffset, params.target_selector);

    if (
      targetEntry.sectionStart >= sourceEntry.sectionStart &&
      targetEntry.sectionStart < sourceEntry.sectionEnd
    ) {
      throw new Error("Cannot move a section relative to a heading inside the same section");
    }

    const moving = children.slice(sourceEntry.sectionStart, sourceEntry.sectionEnd);
    children.splice(sourceEntry.sectionStart, sourceEntry.sectionEnd - sourceEntry.sectionStart);

    let targetIndex = params.target_position === "after" ? targetEntry.sectionEnd : targetEntry.sectionStart;
    if (targetEntry.sectionStart > sourceEntry.sectionStart) {
      targetIndex -= sourceEntry.sectionEnd - sourceEntry.sectionStart;
    }
    children.splice(targetIndex, 0, ...moving);

    return {
      updatedText: buildDocumentText(extracted.frontmatter ?? undefined, stringifyTree(tree), {
        frontmatterRaw: extracted.frontmatterRaw,
      }),
      changeSummary: `Moved section "${sourceEntry.text}" ${params.target_position === "after" ? "after" : "before"} "${targetEntry.text}"`,
    };
  }

  throw new Error(`Unsupported transform action: ${params.action}`);
}

function writeFile(targetPath: string, text: string, context?: PathContext): void {
  ensureParentDir(targetPath);
  const noFollowFlag = (fs.constants as Record<string, number>).O_NOFOLLOW;
  if (context?.workingDirectory && typeof noFollowFlag === "number") {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollowFlag;
    const fd = fs.openSync(targetPath, flags, 0o666);
    try {
      fs.writeFileSync(fd, text, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  fs.writeFileSync(targetPath, text, "utf-8");
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

export async function mdInitTask(params: {
  session_id: string;
  task_id: string;
  work_dir?: string;
}): Promise<ToolResult> {
  try {
    if (!params.session_id) return { success: false, output: "Missing required parameter: session_id" };
    if (!params.task_id) return { success: false, output: "Missing required parameter: task_id" };

    const pipeline = new MdPipeline({
      sessionId: params.session_id,
      taskType: "md",
      taskId: params.task_id,
      workDir: params.work_dir,
    });
    pipeline.ensureStepDirs();
    await pipeline.setMeta({
      sessionId: params.session_id,
      taskType: "md",
      taskId: params.task_id,
      createdAt: new Date().toISOString(),
    });

    return {
      success: true,
      output: `Task initialized at: ${pipeline.taskDir}`,
      outputPath: pipeline.taskDir,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function mdWriteSource(params: {
  task_dir: string;
  input_path?: string;
  markdown_text?: string;
  create_params?: Omit<Parameters<typeof markdownCreate>[0], "output_path">;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    if (!params.input_path && !params.create_params && typeof params.markdown_text !== "string") {
      return { success: false, output: "Provide input_path, markdown_text, or create_params" };
    }

    const pipeline = mdPipelineFromTaskDir(params.task_dir);
    pipeline.ensureStepDirs();
    const sourceDir = pipeline.stepPath(MD_STEP_SOURCE);
    const messages: string[] = [];

    if (params.input_path) {
      const inputPath = path.resolve(params.input_path);
      if (!(await pathExists(inputPath))) return { success: false, output: `Error: File not found: ${inputPath}` };
      const target = path.join(sourceDir, "input.md");
      ;(await fs.promises.copyFile(inputPath, target));
      messages.push(`copied source markdown -> ${target}`);
    }

    if (typeof params.markdown_text === "string") {
      const target = path.join(sourceDir, "input.md");
      ;(await fs.promises.writeFile(target, normalizeNewlines(params.markdown_text), "utf-8"));
      messages.push(`saved markdown text -> ${target}`);
    }

    if (params.create_params) {
      const target = path.join(sourceDir, "create.json");
      ;(await fs.promises.writeFile(target, JSON.stringify(params.create_params, null, 2), "utf-8"));
      messages.push(`saved create params -> ${target}`);
    }

    await pipeline.setMeta({ updatedAt: new Date().toISOString() });
    return { success: true, output: `Source written: ${messages.join(", ")}` };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function mdWriteIntermediate(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    const pipeline = mdPipelineFromTaskDir(params.task_dir);
    pipeline.ensureStepDirs();

    const sourceDir = pipeline.stepPath(MD_STEP_SOURCE);
    const intermediateDir = pipeline.stepPath(MD_STEP_INTERMEDIATE);
    const workingPath = path.join(intermediateDir, "working.md");

    const createPath = path.join(sourceDir, "create.json");
    const inputPath = path.join(sourceDir, "input.md");

    if ((await pathExists(createPath))) {
      const payload = JSON.parse((await fs.promises.readFile(createPath, "utf-8"))) as Omit<
        Parameters<typeof markdownCreate>[0],
        "output_path"
      >;
      const createResult = await markdownCreate({
        ...payload,
        output_path: workingPath,
        overwrite: true,
      });
      if (!createResult.success) {
        return { success: false, output: `Failed to build markdown source: ${createResult.output}` };
      }
    } else if ((await pathExists(inputPath))) {
      ;(await fs.promises.copyFile(inputPath, workingPath));
    } else {
      return {
        success: false,
        output: "No source found. Run md_write_source first (input_path, markdown_text, or create_params).",
      };
    }

    await pipeline.setMeta({ updatedAt: new Date().toISOString() });
    return {
      success: true,
      output: `Intermediate generated at: ${workingPath}`,
      outputPath: workingPath,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function mdPackTask(params: {
  task_dir: string;
  output_path?: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    const pipeline = mdPipelineFromTaskDir(params.task_dir);
    const workingPath = path.join(pipeline.stepPath(MD_STEP_INTERMEDIATE), "working.md");
    if (!(await pathExists(workingPath))) {
      return { success: false, output: "Missing intermediate working.md. Run md_write_intermediate or md_unpack first." };
    }

    const outputPath = params.output_path
      ? path.resolve(params.output_path)
      : path.join(pipeline.stepPath(MD_STEP_OUTPUT), "result.md");
    ;(await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }));
    ;(await fs.promises.copyFile(workingPath, outputPath));
    return { success: true, output: `Packed Markdown to ${outputPath}`, outputPath };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function mdUnpackTask(params: {
  task_dir: string;
  input_path: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    if (!params.input_path) return { success: false, output: "Missing required parameter: input_path" };
    const sourceWrite = await mdWriteSource({
      task_dir: params.task_dir,
      input_path: params.input_path,
    });
    if (!sourceWrite.success) return sourceWrite;
    return mdWriteIntermediate({ task_dir: params.task_dir });
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function mdReadParsed(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    const pipeline = mdPipelineFromTaskDir(params.task_dir);
    const workingPath = path.join(pipeline.stepPath(MD_STEP_INTERMEDIATE), "working.md");
    const sourcePath = path.join(pipeline.stepPath(MD_STEP_SOURCE), "input.md");
    const inputPath = (await pathExists(workingPath)) ? workingPath : sourcePath;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: "No markdown source found. Run md_write_source or md_unpack first." };
    }

    const [readResult, outlineResult] = await Promise.all([
      markdownRead({
        path: inputPath,
        include_frontmatter: true,
        limit: 300,
      }),
      markdownExtractOutline({
        path: inputPath,
        max_depth: 6,
      }),
    ]);
    if (!readResult.success) return readResult;

    const combined = [
      readResult.output,
      "",
      "---- Outline ----",
      outlineResult.success ? outlineResult.output : `Outline error: ${outlineResult.output}`,
    ].join("\n");

    const parsedPath = path.join(pipeline.stepPath(MD_STEP_PARSED), "summary.txt");
    ;(await fs.promises.writeFile(parsedPath, combined, "utf-8"));
    return { success: true, output: combined, outputPath: parsedPath };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function mdReadSource(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    const pipeline = mdPipelineFromTaskDir(params.task_dir);
    const sourceDir = pipeline.stepPath(MD_STEP_SOURCE);
    const createPath = path.join(sourceDir, "create.json");
    const inputPath = path.join(sourceDir, "input.md");

    if ((await pathExists(createPath))) {
      return {
        success: true,
        output: (await fs.promises.readFile(createPath, "utf-8")),
        outputPath: createPath,
      };
    }

    if ((await pathExists(inputPath))) {
      return {
        success: true,
        output: (await fs.promises.readFile(inputPath, "utf-8")),
        outputPath: inputPath,
      };
    }

    return { success: false, output: "No source found. Run md_write_source first." };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function markdownCreate(params: {
  output_path: string;
  title?: string;
  frontmatter?: Frontmatter;
  content?: MarkdownContentBlock[];
  overwrite?: boolean;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const outputPath = resolveWritePath(params.output_path, pathContext);
    if (!outputPath) return { success: false, output: "Error: output_path is required" };

    if (!params.overwrite && (await pathExists(outputPath))) {
      return {
        success: false,
        output: `Error: File already exists: ${outputPath}. Set overwrite=true to replace.`,
      };
    }

    const children: MdNode[] = [];
    if (params.title) {
      children.push({
        type: "heading",
        depth: 1,
        children: [textNode(params.title.trim())],
      });
    }
    children.push(...blocksToNodes(params.content ?? []));

    const body = stringifyTree({ type: "root", children });
    const finalText = buildDocumentText(params.frontmatter, body);
    writeFile(outputPath, finalText, pathContext);

    return {
      success: true,
      output: `Created Markdown document at ${outputPath}`,
      outputPath,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownRead(params: {
  path: string;
  start_line?: number;
  limit?: number;
  include_line_numbers?: boolean;
  include_frontmatter?: boolean;
  output_format?: "text" | "json";
  include_ast?: boolean;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);

    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const extracted = extractFrontmatter(raw);
    const bodyTree = parseTree(extracted.body);
    const headings: HeadingInfo[] = [];
    collectHeadings(bodyTree, headings, extracted.bodyLineOffset);

    const viewText = params.include_frontmatter ? normalizeNewlines(raw) : extracted.body;
    const allLines = viewText.split("\n");
    const start = Math.max(1, params.start_line ?? 1);
    const limit = Math.max(1, params.limit ?? 200);
    const from = start - 1;
    const to = Math.min(allLines.length, from + limit);

    const snippetLines = allLines.slice(from, to).map((line, idx) =>
      params.include_line_numbers ? `${from + idx + 1}: ${line}` : line
    );

    if (params.output_format === "json") {
      const payload: Record<string, unknown> = {
        file: inputPath,
        line_count: allLines.length,
        frontmatter_present: extracted.hasFrontmatter,
        frontmatter: extracted.frontmatter ?? null,
        headings,
        excerpt: {
          start_line: from + 1,
          end_line: to,
          lines: snippetLines,
        },
      };
      if (params.include_ast) {
        payload.ast = bodyTree;
      }
      return { success: true, output: JSON.stringify(payload, null, 2) };
    }

    const out: string[] = [];
    out.push(`File: ${inputPath}`);
    out.push(`Lines: ${allLines.length}`);
    out.push(`Frontmatter: ${extracted.hasFrontmatter ? "present" : "none"}`);
    out.push(`Headings: ${headings.length}`);
    if (headings.length > 0) {
      out.push("Outline:");
      for (const h of headings.slice(0, 20)) {
        out.push(`- H${h.level} L${h.line || "?"}: ${h.text}`);
      }
    }
    out.push("");
    out.push(`Excerpt (${from + 1}-${to}):`);
    out.push(snippetLines.join("\n"));

    return { success: true, output: out.join("\n") };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownExtractOutline(params: {
  path: string;
  max_depth?: number;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);

    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const extracted = extractFrontmatter(raw);
    const body = extracted.body;
    const tree = parseTree(body);
    const maxDepth = Math.max(1, Math.min(6, Math.trunc(params.max_depth ?? 6)));

    const headings: HeadingInfo[] = [];
    collectHeadings(tree, headings, extracted.bodyLineOffset);
    const filtered = headings.filter((h) => h.level <= maxDepth);

    if (filtered.length === 0) {
      return { success: true, output: "No headings found" };
    }

    const lines = filtered.map(
      (h) => `${"  ".repeat(h.level - 1)}- [H${h.level}] ${h.text} (line ${h.line || "?"})`
    );
    return { success: true, output: lines.join("\n") };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownExtractStyleProfile(params: {
  path: string;
  max_examples?: number;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);

    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const extracted = extractFrontmatter(raw);
    const tree = parseTree(extracted.body);
    const maxExamples = Math.max(1, params.max_examples ?? 20);

    const headings: HeadingInfo[] = [];
    collectHeadings(tree, headings, extracted.bodyLineOffset);
    const headingLevels: Record<string, number> = {};
    for (const heading of headings) {
      const key = String(heading.level);
      headingLevels[key] = (headingLevels[key] ?? 0) + 1;
    }

    let emphasis = 0;
    let strong = 0;
    let del = 0;
    let inlineCode = 0;
    let blockquote = 0;
    let thematicBreak = 0;
    let codeBlock = 0;
    let table = 0;
    let link = 0;
    let externalLink = 0;
    let image = 0;
    let html = 0;
    let orderedLists = 0;
    let unorderedLists = 0;
    let listItems = 0;
    let taskItems = 0;
    const codeLanguages: Record<string, number> = {};

    visit(tree as import("unist").Node, (node: import("unist").Node) => {
      const n = node as MdNode;
      switch (n.type) {
        case "emphasis":
          emphasis += 1;
          break;
        case "strong":
          strong += 1;
          break;
        case "delete":
          del += 1;
          break;
        case "inlineCode":
          inlineCode += 1;
          break;
        case "blockquote":
          blockquote += 1;
          break;
        case "thematicBreak":
          thematicBreak += 1;
          break;
        case "code":
          codeBlock += 1;
          codeLanguages[String(n.lang ?? "(none)")] = (codeLanguages[String(n.lang ?? "(none)")] ?? 0) + 1;
          break;
        case "table":
          table += 1;
          break;
        case "link":
          link += 1;
          if (typeof n.url === "string" && /^(https?:)?\/\//i.test(n.url)) externalLink += 1;
          break;
        case "image":
          image += 1;
          break;
        case "html":
          html += 1;
          break;
        case "list":
          if (n.ordered) orderedLists += 1;
          else unorderedLists += 1;
          break;
        case "listItem":
          listItems += 1;
          if (typeof n.checked === "boolean") taskItems += 1;
          break;
      }
    });

    const profile = {
      source: inputPath,
      limitations: {
        visualStyleModel: false,
        reason: "Markdown stores syntax structure, not rendered visual style (font family, exact size, colors, margins).",
      },
      frontmatter: {
        present: extracted.hasFrontmatter,
        keys: extracted.frontmatter ? Object.keys(extracted.frontmatter) : [],
        valueTypes: extracted.frontmatter
          ? Object.fromEntries(
            Object.entries(extracted.frontmatter).map(([k, v]) => [k, v === null ? "null" : typeof v]),
          )
          : {},
      },
      headingProfile: {
        total: headings.length,
        levels: headingLevels,
        samples: headings.slice(0, maxExamples),
      },
      syntaxProfile: {
        emphasis,
        strong,
        delete: del,
        inlineCode,
        blockquote,
        thematicBreak,
        codeBlock,
        codeLanguages,
        table,
        link,
        externalLink,
        internalLink: Math.max(0, link - externalLink),
        image,
        html,
        orderedLists,
        unorderedLists,
        listItems,
        taskItems,
      },
    };

    return { success: true, output: JSON.stringify(profile, null, 2) };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

/**
 * Unified template style parser entrypoint for Markdown toolkit.
 * Keeps backward compatibility by delegating to markdownExtractStyleProfile.
 */
export async function parseTemplateStyle(
  params: Parameters<typeof markdownExtractStyleProfile>[0] & {
    preflightRead?: boolean;
    preflight_read?: boolean;
  },
): Promise<ToolResult> {
  const runPreflight = params.preflightRead ?? params.preflight_read ?? true;
  if (runPreflight) {
    const preflight = await markdownRead({
      path: params.path,
      working_directory: params.working_directory,
      limit: 1,
    });
    if (!preflight.success) {
      return {
        success: false,
        output: `Preflight read failed: ${preflight.output}`,
      };
    }
  }
  return markdownExtractStyleProfile(params);
}

export async function markdownAppendContent(params: {
  path: string;
  content: MarkdownContentBlock[];
  output_path?: string;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const newNodes = blocksToNodes(params.content ?? []);
    if (newNodes.length === 0) {
      return { success: false, output: "Error: content is empty" };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const extracted = extractFrontmatter(raw);
    const tree = parseTree(extracted.body);
    tree.children.push(...newNodes);

    const outputPath = resolveWritePath(
      params.output_path ?? defaultOutputPath(inputPath),
      pathContext
    );
    const nextBody = stringifyTree(tree);
    const output = buildDocumentText(extracted.frontmatter ?? undefined, nextBody, {
      frontmatterRaw: extracted.frontmatterRaw,
    });
    writeFile(outputPath, output, pathContext);

    return {
      success: true,
      output: `Appended content and saved to ${outputPath}`,
      outputPath,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownUpdateSection(params: {
  path: string;
  heading?: string;
  selector?: HeadingSelector;
  content: MarkdownContentBlock[];
  output_path?: string;
  create_if_missing?: boolean;
  heading_level?: number;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const extracted = extractFrontmatter(raw);
    const tree = parseTree(extracted.body);
    const newNodes = blocksToNodes(params.content ?? []);

    const normalizedSelector: HeadingSelector | undefined = params.selector
      ? { ...params.selector }
      : params.heading
        ? { heading: params.heading }
        : undefined;
    if (params.heading && normalizedSelector && !normalizedSelector.heading) {
      normalizedSelector.heading = params.heading;
    }

    let targetEntry: HeadingEntry | null = null;
    if (normalizedSelector) {
      try {
        targetEntry = resolveHeadingEntry(tree, extracted.bodyLineOffset, normalizedSelector).entry;
      } catch {
        targetEntry = null;
      }
    }

    if (!targetEntry) {
      if (!params.create_if_missing) {
        const fallbackName =
          normalizedSelector?.heading ??
          normalizedSelector?.heading_path?.[normalizedSelector.heading_path.length - 1] ??
          params.heading ??
          "(unknown)";
        return {
          success: false,
          output: `Error: heading not found: ${fallbackName}`,
        };
      }

      const newHeadingText =
        normalizedSelector?.heading ??
        normalizedSelector?.heading_path?.[normalizedSelector.heading_path.length - 1] ??
        params.heading;
      if (!newHeadingText?.trim()) {
        return {
          success: false,
          output: "Error: create_if_missing=true requires heading, selector.heading, or selector.heading_path",
        };
      }

      const level = clampHeadingLevel(params.heading_level ?? 2);
      tree.children.push({
        type: "heading",
        depth: level,
        children: [textNode(newHeadingText.trim())],
      });
      tree.children.push(...newNodes);

      const outputPath = resolveWritePath(
        params.output_path ?? defaultOutputPath(inputPath),
        pathContext
      );
      const out = buildDocumentText(extracted.frontmatter ?? undefined, stringifyTree(tree), {
        frontmatterRaw: extracted.frontmatterRaw,
      });
      writeFile(outputPath, out, pathContext);
      return {
        success: true,
        output: `Heading not found, created new section and saved to ${outputPath}`,
        outputPath,
      };
    }

    tree.children.splice(
      targetEntry.sectionStart + 1,
      targetEntry.sectionEnd - (targetEntry.sectionStart + 1),
      ...newNodes
    );

    const outputPath = resolveWritePath(
      params.output_path ?? defaultOutputPath(inputPath),
      pathContext
    );
    const output = buildDocumentText(extracted.frontmatter ?? undefined, stringifyTree(tree), {
      frontmatterRaw: extracted.frontmatterRaw,
    });
    writeFile(outputPath, output, pathContext);

    return {
      success: true,
      output: `Updated section "${targetEntry.text}" and saved to ${outputPath}`,
      outputPath,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownFormatDocument(params: {
  path: string;
  output_path?: string;
  trim_trailing_spaces?: boolean;
  collapse_blank_lines?: boolean;
  ensure_trailing_newline?: boolean;
  mode?: "normalize" | "preserve";
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const extracted = extractFrontmatter(raw);
    const mode = params.mode ?? MD_DEFAULTS.format.mode;
    const canonicalBody = mode === "normalize" ? stringifyTree(parseTree(extracted.body)) : extracted.body;
    const withFrontmatter = buildDocumentText(extracted.frontmatter ?? undefined, canonicalBody, {
      frontmatterRaw: extracted.frontmatterRaw,
      mode,
    });

    const formatted = formatMarkdownWhitespace(withFrontmatter, {
      trim_trailing_spaces: params.trim_trailing_spaces,
      collapse_blank_lines: params.collapse_blank_lines,
      ensure_trailing_newline: params.ensure_trailing_newline,
    });

    const outputPath = resolveWritePath(
      params.output_path ?? defaultOutputPath(inputPath),
      pathContext
    );
    writeFile(outputPath, formatted, pathContext);
    return {
      success: true,
      output: `Formatted Markdown and saved to ${outputPath}`,
      outputPath,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownManageFrontmatter(params: {
  path: string;
  action: "get" | "set" | "remove";
  frontmatter?: Frontmatter;
  output_path?: string;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const extracted = extractFrontmatter(raw);

    if (params.action === "get") {
      if (!extracted.hasFrontmatter || !extracted.frontmatter) {
        return { success: true, output: "Frontmatter: none" };
      }
      return {
        success: true,
        output: JSON.stringify(
          {
            frontmatter: extracted.frontmatter,
            raw: extracted.frontmatterRaw,
          },
          null,
          2
        ),
      };
    }

    const outputPath = resolveWritePath(
      params.output_path ?? defaultOutputPath(inputPath),
      pathContext
    );

    if (params.action === "remove") {
      if (!extracted.hasFrontmatter) {
        return { success: false, output: "Error: document has no frontmatter to remove" };
      }
      const canonicalBody = stringifyTree(parseTree(extracted.body));
      const cleaned = formatMarkdownWhitespace(canonicalBody, { ensure_trailing_newline: true });
      writeFile(outputPath, cleaned, pathContext);
      return {
        success: true,
        output: `Removed frontmatter and saved to ${outputPath}`,
        outputPath,
      };
    }

    if (!params.frontmatter) {
      return { success: false, output: "Error: frontmatter is required for action=set" };
    }

    const canonicalBody = stringifyTree(parseTree(extracted.body));
    const next = renderFrontmatter(params.frontmatter) + canonicalBody.replace(/^\n+/, "");
    const formatted = formatMarkdownWhitespace(next, { ensure_trailing_newline: true });
    writeFile(outputPath, formatted, pathContext);
    return {
      success: true,
      output: `Set frontmatter and saved to ${outputPath}`,
      outputPath,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

type ValidationIssue = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  line?: number;
};

function findFirstMatchLine(text: string, pattern: RegExp): number | undefined {
  const lines = normalizeNewlines(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const probe = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    if (probe.test(lines[i])) return i + 1;
  }
  return undefined;
}

export async function markdownValidateDocument(params: {
  path: string;
  profile?: "commonmark" | "gfm" | "strict";
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const profile = params.profile ?? "gfm";
    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const issues: ValidationIssue[] = [];
    let parsedTree: MdNode | null = null;

    const addIssue = (
      code: string,
      message: string,
      severity: ValidationIssue["severity"] = "warning",
      pattern?: RegExp
    ) => {
      issues.push({
        code,
        severity,
        message,
        line: pattern ? findFirstMatchLine(raw, pattern) : undefined,
      });
    };

    try {
      const extracted = extractFrontmatter(raw);
      parsedTree = parseTree(extracted.body);
    } catch {
      addIssue("parse-error", "Markdown parser could not parse the document body.", "error");
    }

    if (parsedTree) {
      const linkDefinitions = new Set<string>();
      const linkReferences = new Set<string>();
      const footnoteDefinitions = new Set<string>();
      const footnoteReferences = new Set<string>();

      visit(parsedTree as import("unist").Node, (node: import("unist").Node) => {
        const n = node as MdNode;
        if (n.type === "definition" && typeof n.identifier === "string") {
          linkDefinitions.add(String(n.identifier).toLowerCase());
        }
        if (n.type === "linkReference" && typeof n.identifier === "string") {
          linkReferences.add(String(n.identifier).toLowerCase());
        }
        if (n.type === "footnoteDefinition" && typeof n.identifier === "string") {
          footnoteDefinitions.add(String(n.identifier).toLowerCase());
        }
        if (n.type === "footnoteReference" && typeof n.identifier === "string") {
          footnoteReferences.add(String(n.identifier).toLowerCase());
        }
      });

      for (const ref of linkReferences) {
        if (!linkDefinitions.has(ref)) {
          addIssue("missing-link-definition", `Reference-style link is missing definition: [${ref}]`, "warning");
        }
      }
      for (const ref of footnoteReferences) {
        if (!footnoteDefinitions.has(ref)) {
          addIssue("missing-footnote-definition", `Footnote reference is missing definition: [^${ref}]`, "warning");
        }
      }
    }

    const hasTaskList = /^\s*[-*+]\s+\[[ xX]\]\s+/m.test(raw);
    const hasTable = /^\|.*\|/m.test(raw);
    const hasHeadingId = /#{1,6}\s+.*\{#[^}]+\}/m.test(raw);
    const hasFootnote = /\[\^[^\]]+\]/m.test(raw);
    const hasFootnoteDef = /^\[\^[^\]]+\]:\s+/m.test(raw);
    const hasDefinitionList = /^\s*:\s+\S+/m.test(raw);
    const hasHighlight = /==[^=\n]+==/m.test(raw);
    const hasSubscriptLike = /(^|[^~])~[^~\n]+~([^~]|$)/m.test(raw);
    const hasRawHtml = /<([a-zA-Z][\w:-]*)(\s[^>]*)?>/m.test(raw);
    const hasHiddenRefComment = /^\[[^\]]+\]:\s*#\s*$/m.test(raw);
    const footnoteRefMatches = Array.from(raw.matchAll(/\[\^([^\]\s]+)\](?!:)/g));
    const footnoteDefMatches = Array.from(raw.matchAll(/^\s{0,3}\[\^([^\]\s]+)\]:/gm));
    const footnoteRefSet = new Set(footnoteRefMatches.map((m) => m[1].toLowerCase()));
    const footnoteDefSet = new Set(footnoteDefMatches.map((m) => m[1].toLowerCase()));

    for (const ref of footnoteRefSet) {
      if (!footnoteDefSet.has(ref)) {
        addIssue(
          "missing-footnote-definition",
          `Footnote reference is missing definition: [^${ref}]`,
          "warning"
        );
      }
    }

    if (profile === "commonmark") {
      if (hasTaskList) addIssue("task-list", "Task lists are not part of strict CommonMark.", "warning", /^\s*[-*+]\s+\[[ xX]\]\s+/m);
      if (hasTable) addIssue("table", "Pipe tables are not part of strict CommonMark.", "warning", /^\|.*\|/m);
      if (/~~[^~]+~~/m.test(raw)) addIssue("strikethrough", "Strikethrough is not part of strict CommonMark.", "warning", /~~[^~]+~~/m);
    }

    if (hasHeadingId) addIssue("heading-id", "Heading IDs `{#id}` are renderer-dependent.", "warning", /#{1,6}\s+.*\{#[^}]+\}/m);
    if (hasFootnote || hasFootnoteDef) addIssue("footnote", "Footnotes are extended syntax and renderer-dependent.", "warning", /\[\^[^\]]+\]/m);
    if (hasDefinitionList) addIssue("definition-list", "Definition lists are not universally supported.", "warning", /^\s*:\s+\S+/m);
    if (hasHighlight) addIssue("highlight", "Highlight syntax `==text==` is not widely supported.", "warning", /==[^=\n]+==/m);
    if (hasSubscriptLike) addIssue("subscript", "Subscript via `~text~` is renderer-dependent and may be rewritten.", "warning", /(^|[^~])~[^~\n]+~([^~]|$)/m);
    if (hasRawHtml) addIssue("raw-html", "Raw HTML may be sanitized by some renderers.", "info", /<([a-zA-Z][\w:-]*)(\s[^>]*)?>/m);
    if (hasHiddenRefComment) addIssue("hidden-comment", "Hidden comment reference syntax is hacky and renderer-dependent.", "info", /^\[[^\]]+\]:\s*#\s*$/m);

    const payload = {
      file: inputPath,
      profile,
      issue_count: issues.length,
      issues,
    };

    return { success: true, output: JSON.stringify(payload, null, 2) };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownGenerateToc(params: {
  path: string;
  output_path?: string;
  min_depth?: number;
  max_depth?: number;
  include_h1?: boolean;
  ordered?: boolean;
  heading?: string;
  marker_start?: string;
  marker_end?: string;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const extracted = extractFrontmatter(raw);
    const tree = parseTree(extracted.body);
    const headings: HeadingInfo[] = [];
    collectHeadings(tree, headings, extracted.bodyLineOffset);

    const minDepthBase = params.include_h1
      ? 1
      : (MD_DEFAULTS.toc.includeH1 ? 1 : MD_DEFAULTS.toc.minDepth);
    const minDepth = Math.max(1, Math.min(6, Math.trunc(params.min_depth ?? minDepthBase)));
    const maxDepth = Math.max(minDepth, Math.min(6, Math.trunc(params.max_depth ?? MD_DEFAULTS.toc.maxDepth)));
    const tocLines = buildTocLines(headings, {
      minDepth,
      maxDepth,
      ordered: params.ordered ?? MD_DEFAULTS.toc.ordered,
    });

    if (tocLines.length === 0) {
      return {
        success: false,
        output: `Error: no headings found for TOC range H${minDepth}-H${maxDepth}`,
      };
    }

    const headingPrefix = params.heading?.trim();
    const tocBody = tocLines.join("\n");
    const tocBlock = headingPrefix
      ? `${headingPrefix.startsWith("#") ? headingPrefix : `## ${headingPrefix}`}\n\n${tocBody}`
      : tocBody;

    const startMarker = params.marker_start ?? MD_DEFAULTS.toc.startMarker;
    const endMarker = params.marker_end ?? MD_DEFAULTS.toc.endMarker;
    const markerReplaced = replaceBetweenMarkers(normalizeNewlines(raw), startMarker, endMarker, tocBlock);

    let updatedText: string;
    if (markerReplaced.replaced) {
      updatedText = formatMarkdownWhitespace(markerReplaced.text, { ensure_trailing_newline: true });
    } else {
      const body = extracted.body;
      const lines = body.split("\n");
      let h1Index = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === "") continue;
        if (/^#\s+\S+/.test(lines[i])) h1Index = i;
        break;
      }

      const before = h1Index >= 0 ? lines.slice(0, h1Index + 1).join("\n").trimEnd() : "";
      const after = h1Index >= 0 ? lines.slice(h1Index + 1).join("\n").replace(/^\n+/, "") : body.replace(/^\n+/, "");
      const mergedBody = [before, tocBlock, after].filter((part) => part && part.trim().length > 0).join("\n\n");
      updatedText = buildDocumentText(extracted.frontmatter ?? undefined, mergedBody, {
        frontmatterRaw: extracted.frontmatterRaw,
        mode: "preserve",
      });
    }

    const outputPath = resolveWritePath(params.output_path ?? defaultOutputPath(inputPath), pathContext);
    writeFile(outputPath, updatedText, pathContext);

    return {
      success: true,
      output: markerReplaced.replaced
        ? `Replaced TOC between markers and saved to ${outputPath}`
        : `Inserted TOC and saved to ${outputPath}`,
      outputPath,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownTransformDocument(params: {
  path: string;
  action: TransformAction;
  selector?: HeadingSelector;
  target_selector?: HeadingSelector;
  target_position?: "before" | "after";
  content?: MarkdownContentBlock[];
  new_heading?: string;
  output_path?: string;
  dry_run?: boolean;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const raw = (await fs.promises.readFile(inputPath, "utf-8"));
    const transformed = applyTransformToMarkdown(raw, {
      action: params.action,
      selector: params.selector,
      target_selector: params.target_selector,
      target_position: params.target_position,
      content: params.content,
      new_heading: params.new_heading,
    });

    if (params.dry_run) {
      const diff = buildUnifiedDiff(raw, transformed.updatedText, inputPath, `${inputPath} (dry-run)`);
      return {
        success: true,
        output: `${transformed.changeSummary}\n\n${diff}`,
      };
    }

    const outputPath = resolveWritePath(
      params.output_path ?? defaultOutputPath(inputPath),
      pathContext
    );
    writeFile(outputPath, transformed.updatedText, pathContext);
    return {
      success: true,
      output: `${transformed.changeSummary}\nSaved to ${outputPath}`,
      outputPath,
    };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}

export async function markdownDiffDocument(params: {
  path: string;
  compare_path?: string;
  transform?: {
    action: TransformAction;
    selector?: HeadingSelector;
    target_selector?: HeadingSelector;
    target_position?: "before" | "after";
    content?: MarkdownContentBlock[];
    new_heading?: string;
  };
  output_path?: string;
  working_directory?: string;
}): Promise<ToolResult> {
  try {
    const pathContext = createPathContext(params.working_directory);
    const inputPath = resolveReadPath(params.path, pathContext);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const before = (await fs.promises.readFile(inputPath, "utf-8"));
    let after = before;
    let afterLabel = params.compare_path ?? `${inputPath} (transformed)`;

    if (params.transform) {
      after = applyTransformToMarkdown(before, params.transform).updatedText;
    } else if (params.compare_path) {
      const comparePath = resolveReadPath(params.compare_path, pathContext);
      if (!(await pathExists(comparePath))) {
        return { success: false, output: `Error: compare_path not found: ${comparePath}` };
      }
      after = (await fs.promises.readFile(comparePath, "utf-8"));
      afterLabel = comparePath;
    } else {
      return {
        success: false,
        output: "Error: Provide compare_path or transform for md_diff_document",
      };
    }

    const diff = buildUnifiedDiff(before, after, inputPath, afterLabel);
    if (params.output_path) {
      const diffPath = resolveWritePath(params.output_path, pathContext);
      writeFile(diffPath, diff, pathContext);
      return {
        success: true,
        output: `Diff generated and saved to ${diffPath}`,
        outputPath: diffPath,
      };
    }
    return { success: true, output: diff };
  } catch (error: any) {
    return { success: false, output: `Error: ${error.message}` };
  }
}
