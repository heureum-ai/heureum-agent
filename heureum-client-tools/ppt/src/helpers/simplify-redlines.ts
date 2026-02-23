/**
 * Simplify tracked changes by merging adjacent w:ins or w:del elements.
 *
 * Merges adjacent <w:ins> elements from the same author into a single element.
 * Same for <w:del> elements. This makes heavily-redlined documents easier to
 * work with by reducing the number of tracked change wrappers.
 *
 * Rules:
 * - Only merges w:ins with w:ins, w:del with w:del (same element type)
 * - Only merges if same author (ignores timestamp differences)
 * - Only merges if truly adjacent (only whitespace between them)
 *
 * Ported from simplify_redlines.py
 */
import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";
import { parseXml, buildXml, getTagName, tagMatches } from "../xml-utils";

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function findElements(nodes: any[], localName: string): any[] {
  const results: any[] = [];
  function traverse(node: any) {
    if (typeof node !== "object" || node === null) return;
    const tag = getTagName(node);
    if (tagMatches(tag, localName)) {
      results.push(node);
    }
    if (tag && Array.isArray(node[tag])) {
      for (const child of node[tag]) {
        traverse(child);
      }
    }
  }
  for (const n of nodes) {
    traverse(n);
  }
  return results;
}

/** Get the author attribute from a tracked change element */
function getAuthor(elem: any): string {
  const attrs = elem[":@"];
  if (!attrs) return "";
  // Try w:author first
  if (attrs["@_w:author"]) return attrs["@_w:author"];
  // Look for any author attribute
  for (const key of Object.keys(attrs)) {
    if (key.endsWith(":author") || key === "@_author") {
      return attrs[key];
    }
  }
  return "";
}

/** Check if two tracked changes can be merged (same author, adjacent) */
function canMergeTracked(
  container: any,
  containerTag: string,
  elem1Index: number,
  elem2Index: number
): boolean {
  const children = container[containerTag];
  const elem1 = children[elem1Index];
  const elem2 = children[elem2Index];

  if (getAuthor(elem1) !== getAuthor(elem2)) return false;

  // Check that only whitespace text nodes exist between them
  for (let i = elem1Index + 1; i < elem2Index; i++) {
    const between = children[i];
    if (typeof between === "object" && between !== null) {
      const betweenTag = getTagName(between);
      if (betweenTag) return false; // Element node between them
    }
    if (typeof between === "string" && between.trim() !== "") return false;
  }
  return true;
}

/** Merge tracked changes of a given type within a container */
function mergeTrackedChangesIn(
  container: any,
  trackedTag: string
): number {
  const containerTag = getTagName(container);
  if (!containerTag || !Array.isArray(container[containerTag])) return 0;

  const children = container[containerTag];

  // Find indices of tracked change elements
  let tracked: number[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childTag = getTagName(child);
    if (tagMatches(childTag, trackedTag)) {
      tracked.push(i);
    }
  }

  if (tracked.length < 2) return 0;

  let mergeCount = 0;
  let ti = 0;

  while (ti < tracked.length - 1) {
    const currIdx = tracked[ti];
    const nextIdx = tracked[ti + 1];

    if (canMergeTracked(container, containerTag, currIdx, nextIdx)) {
      const target = children[currIdx];
      const source = children[nextIdx];
      const targetTag = getTagName(target)!;
      const sourceTag = getTagName(source)!;

      // Move all children from source to target
      if (!Array.isArray(target[targetTag])) target[targetTag] = [];
      if (Array.isArray(source[sourceTag])) {
        target[targetTag].push(...source[sourceTag]);
      }

      // Remove source and any whitespace between them
      // Remove items between currIdx and nextIdx (exclusive of currIdx)
      const removeCount = nextIdx - currIdx;
      children.splice(currIdx + 1, removeCount);

      // Recalculate tracked indices
      tracked = [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const childTag = getTagName(child);
        if (tagMatches(childTag, trackedTag)) {
          tracked.push(i);
        }
      }

      mergeCount++;
      // Don't advance ti — try to merge the same element with the next one
    } else {
      ti++;
    }
  }

  return mergeCount;
}

/**
 * Simplify tracked changes by merging adjacent w:ins or w:del from same author.
 *
 * @param inputDir - Path to unpacked DOCX directory
 * @returns [simplifyCount, message]
 */
/** @internal Exported for testing only */
export const _internal = {
  parseXml,
  buildXml,
  getTagName,
  tagMatches,
  findElements,
  getAuthor,
  canMergeTracked,
  mergeTrackedChangesIn,
};

export function simplifyRedlines(inputDir: string): [number, string] {
  const docXml = path.join(inputDir, "word", "document.xml");

  if (!fs.existsSync(docXml)) {
    return [0, `Error: ${docXml} not found`];
  }

  try {
    const content = fs.readFileSync(docXml, "utf-8");
    const nodes = parseXml(content);

    let mergeCount = 0;

    // Find all containers: paragraphs (p) and table cells (tc)
    const containers = [
      ...findElements(nodes, "p"),
      ...findElements(nodes, "tc"),
    ];

    for (const container of containers) {
      mergeCount += mergeTrackedChangesIn(container, "ins");
      mergeCount += mergeTrackedChangesIn(container, "del");
    }

    const xml = buildXml(nodes);
    fs.writeFileSync(docXml, xml, "utf-8");
    return [mergeCount, `Simplified ${mergeCount} tracked changes`];
  } catch (e: any) {
    return [0, `Error: ${e.message}`];
  }
}

/**
 * Get tracked change authors from a document.xml file path.
 */
export function getTrackedChangeAuthors(
  docXmlPath: string
): Record<string, number> {
  if (!fs.existsSync(docXmlPath)) return {};

  try {
    const content = fs.readFileSync(docXmlPath, "utf-8");
    const nodes = parseXml(content);

    const authors: Record<string, number> = {};
    for (const tag of ["ins", "del"]) {
      const elements = findElements(nodes, tag);
      for (const elem of elements) {
        const author = getAuthor(elem);
        if (author) {
          authors[author] = (authors[author] || 0) + 1;
        }
      }
    }
    return authors;
  } catch {
    return {};
  }
}

/**
 * Get tracked change authors from a .docx file.
 */
export async function getAuthorsFromDocx(
  docxPath: string
): Promise<Record<string, number>> {
  try {
    const buffer = (await fs.promises.readFile(docxPath));
    const zip = await JSZip.loadAsync(buffer);
    const docFile = zip.file("word/document.xml");
    if (!docFile) return {};

    const content = await docFile.async("string");
    const nodes = parseXml(content);

    const authors: Record<string, number> = {};
    for (const tag of ["ins", "del"]) {
      const elements = findElements(nodes, tag);
      for (const elem of elements) {
        const author = getAuthor(elem);
        if (author) {
          authors[author] = (authors[author] || 0) + 1;
        }
      }
    }
    return authors;
  } catch {
    return {};
  }
}

/**
 * Infer the author who made changes by comparing modified vs original.
 */
export async function inferAuthor(
  modifiedDir: string,
  originalDocx: string,
  defaultAuthor: string = "Claude"
): Promise<string> {
  const modifiedXml = path.join(modifiedDir, "word", "document.xml");
  const modifiedAuthors = getTrackedChangeAuthors(modifiedXml);

  if (Object.keys(modifiedAuthors).length === 0) return defaultAuthor;

  const originalAuthors = await getAuthorsFromDocx(originalDocx);

  const newChanges: Record<string, number> = {};
  for (const [author, count] of Object.entries(modifiedAuthors)) {
    const originalCount = originalAuthors[author] || 0;
    const diff = count - originalCount;
    if (diff > 0) {
      newChanges[author] = diff;
    }
  }

  if (Object.keys(newChanges).length === 0) return defaultAuthor;
  if (Object.keys(newChanges).length === 1)
    return Object.keys(newChanges)[0];

  throw new Error(
    `Multiple authors added new changes: ${JSON.stringify(newChanges)}. ` +
      "Cannot infer which author to validate."
  );
}
