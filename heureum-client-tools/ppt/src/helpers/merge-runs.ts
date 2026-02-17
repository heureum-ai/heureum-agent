/**
 * Merge adjacent runs with identical formatting in DOCX.
 *
 * Merges adjacent <w:r> elements that have identical <w:rPr> properties.
 * Works on runs in paragraphs and inside tracked changes (<w:ins>, <w:del>).
 *
 * Also:
 * - Removes rsid attributes from runs (revision metadata that doesn't affect rendering)
 * - Removes proofErr elements (spell/grammar markers that block merging)
 *
 * Ported from merge_runs.py
 */
import * as fs from "fs";
import * as path from "path";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import {
  PARSER_OPTIONS as BASE_PARSER_OPTIONS,
  BUILDER_OPTIONS,
  buildXml,
  getTagName,
  tagMatches,
} from "../xml-utils";

/** Extended parser options with cdata/comment support for merge-runs */
const PARSER_OPTIONS = {
  ...BASE_PARSER_OPTIONS,
  cdataPropName: "__cdata",
  commentPropName: "__comment",
};

function parseXml(xmlStr: string): any[] {
  const parser = new XMLParser(PARSER_OPTIONS);
  const result = parser.parse(xmlStr);
  return Array.isArray(result)
    ? result.filter((n: any) => !("?xml" in n))
    : [result];
}

/** Check if a node is a run element */
function isRun(node: any): boolean {
  return tagMatches(getTagName(node), "r");
}

/** Remove all descendant elements matching localName from children arrays */
function removeElements(nodes: any[], localName: string): void {
  function processChildren(childArr: any[]): void {
    for (let i = childArr.length - 1; i >= 0; i--) {
      const child = childArr[i];
      if (typeof child !== "object" || child === null) continue;
      const childTag = getTagName(child);
      if (tagMatches(childTag, localName)) {
        childArr.splice(i, 1);
      } else if (childTag && Array.isArray(child[childTag])) {
        processChildren(child[childTag]);
      }
    }
  }
  for (const node of nodes) {
    const tag = getTagName(node);
    if (tag && Array.isArray(node[tag])) {
      processChildren(node[tag]);
    }
  }
}

/** Strip rsid attributes from all run elements */
function stripRunRsidAttrs(nodes: any[]): void {
  function traverse(node: any): void {
    if (typeof node !== "object" || node === null) return;
    const tag = getTagName(node);
    if (tagMatches(tag, "r")) {
      const attrs = node[":@"];
      if (attrs) {
        for (const key of Object.keys(attrs)) {
          if (key.toLowerCase().includes("rsid")) {
            delete attrs[key];
          }
        }
        if (Object.keys(attrs).length === 0) delete node[":@"];
      }
    }
    if (tag && Array.isArray(node[tag])) {
      for (const child of node[tag]) {
        traverse(child);
      }
    }
  }
  for (const n of nodes) traverse(n);
}

/** Get the rPr child serialized as string for comparison */
function getRprString(run: any): string | null {
  const tag = getTagName(run);
  if (!tag || !Array.isArray(run[tag])) return null;
  for (const child of run[tag]) {
    const childTag = getTagName(child);
    if (tagMatches(childTag, "rPr")) {
      const builder = new XMLBuilder(BUILDER_OPTIONS);
      return builder.build([child]);
    }
  }
  return null;
}

/** Check if two runs can be merged (identical rPr) */
function canMerge(run1: any, run2: any): boolean {
  const rpr1 = getRprString(run1);
  const rpr2 = getRprString(run2);
  if ((rpr1 === null) !== (rpr2 === null)) return false;
  if (rpr1 === null) return true;
  return rpr1 === rpr2;
}

/** Move non-rPr content from source run to target run */
function mergeRunContent(target: any, source: any): void {
  const targetTag = getTagName(target)!;
  const sourceTag = getTagName(source)!;
  if (!Array.isArray(target[targetTag])) target[targetTag] = [];
  if (!Array.isArray(source[sourceTag])) return;

  for (const child of source[sourceTag]) {
    const childTag = getTagName(child);
    if (childTag && tagMatches(childTag, "rPr")) continue;
    target[targetTag].push(child);
  }
}

/** Consolidate adjacent text elements within a run */
function consolidateText(run: any): void {
  const tag = getTagName(run);
  if (!tag || !Array.isArray(run[tag])) return;

  const children = run[tag];

  // Collect text element indices
  const tIndices: number[] = [];
  for (let i = 0; i < children.length; i++) {
    if (tagMatches(getTagName(children[i]), "t")) {
      tIndices.push(i);
    }
  }

  // Merge from end to beginning to preserve indices
  for (let k = tIndices.length - 1; k > 0; k--) {
    const currIdx = tIndices[k];
    const prevIdx = tIndices[k - 1];

    // Check adjacency: no element nodes between them
    let adjacent = true;
    for (let j = prevIdx + 1; j < currIdx; j++) {
      const between = children[j];
      if (typeof between === "object" && between !== null && getTagName(between)) {
        adjacent = false;
        break;
      }
    }
    if (!adjacent) continue;

    const prevElem = children[prevIdx];
    const currElem = children[currIdx];

    const prevText = getTextContent(prevElem);
    const currText = getTextContent(currElem);
    const merged = prevText + currText;

    setTextContent(prevElem, merged);

    // Update xml:space attribute
    if (!prevElem[":@"]) prevElem[":@"] = {};
    if (merged.startsWith(" ") || merged.endsWith(" ")) {
      prevElem[":@"]["@_xml:space"] = "preserve";
    } else {
      delete prevElem[":@"]["@_xml:space"];
      if (Object.keys(prevElem[":@"]).length === 0) {
        delete prevElem[":@"];
      }
    }

    // Remove current t element and anything between
    children.splice(prevIdx + 1, currIdx - prevIdx);
  }
}

/** Get text content from a w:t element */
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

/** Set text content on a w:t element */
function setTextContent(tElem: any, text: string): void {
  const tag = getTagName(tElem);
  if (!tag) return;
  tElem[tag] = [{ "#text": text }];
}

/**
 * Traverse the tree and merge runs in every container that has run children.
 * Returns the total number of merges.
 */
function traverseAndMerge(nodes: any[]): number {
  let total = 0;

  function process(node: any): void {
    const tag = getTagName(node);
    if (!tag || !Array.isArray(node[tag])) return;

    const children = node[tag];

    // Check if this node has any run children
    const hasRuns = children.some(
      (c: any) => typeof c === "object" && c !== null && isRun(c)
    );

    if (hasRuns) {
      total += mergeRunsInChildren(children);
    }

    // Recurse into children
    for (const child of children) {
      if (typeof child === "object" && child !== null) {
        process(child);
      }
    }
  }

  for (const node of nodes) {
    process(node);
  }
  return total;
}

/** Check if a node is a whitespace-only #text node */
function isWhitespaceText(node: any): boolean {
  if (typeof node !== "object" || node === null) return false;
  if ("#text" in node) {
    return String(node["#text"]).trim() === "";
  }
  return false;
}

/** Find next element sibling index, skipping whitespace #text nodes */
function nextElementIndex(children: any[], startIdx: number): number {
  for (let j = startIdx; j < children.length; j++) {
    const child = children[j];
    if (typeof child !== "object" || child === null) continue;
    if (isWhitespaceText(child)) continue;
    if (getTagName(child)) return j;
  }
  return -1;
}

/** Merge adjacent runs within a children array */
function mergeRunsInChildren(children: any[]): number {
  let mergeCount = 0;
  let i = 0;

  while (i < children.length) {
    const child = children[i];
    if (typeof child !== "object" || child === null || !isRun(child)) {
      i++;
      continue;
    }

    // Try to merge with subsequent adjacent runs (skipping whitespace text nodes)
    let merged = true;
    while (merged) {
      merged = false;
      const nextIdx = nextElementIndex(children, i + 1);
      if (nextIdx === -1) break;
      const next = children[nextIdx];
      if (!isRun(next) || !canMerge(child, next)) break;

      mergeRunContent(child, next);
      // Remove everything from i+1 to nextIdx (inclusive) — whitespace nodes and the merged run
      children.splice(i + 1, nextIdx - i);
      mergeCount++;
      merged = true;
    }

    consolidateText(child);
    i++;
  }

  return mergeCount;
}

/**
 * Merge adjacent runs with identical formatting in a DOCX document.
 *
 * @param inputDir - Path to unpacked DOCX directory
 * @returns [mergeCount, message]
 */
/** @internal Exported for testing only */
export const _internal = {
  parseXml,
  buildXml,
  getTagName,
  tagMatches,
  isRun,
  removeElements,
  stripRunRsidAttrs,
  getRprString,
  canMerge,
  mergeRunContent,
  consolidateText,
  getTextContent,
  setTextContent,
  traverseAndMerge,
  isWhitespaceText,
  nextElementIndex,
  mergeRunsInChildren,
};

export function mergeRuns(inputDir: string): [number, string] {
  const docXml = path.join(inputDir, "word", "document.xml");

  if (!fs.existsSync(docXml)) {
    return [0, `Error: ${docXml} not found`];
  }

  try {
    const content = fs.readFileSync(docXml, "utf-8");
    const nodes = parseXml(content);

    // Remove proofErr elements
    removeElements(nodes, "proofErr");

    // Strip rsid attributes from runs
    stripRunRsidAttrs(nodes);

    // Traverse tree and merge runs in all containers
    const mergeCount = traverseAndMerge(nodes);

    const xml = buildXml(nodes);
    fs.writeFileSync(docXml, xml, "utf-8");
    return [mergeCount, `Merged ${mergeCount} runs`];
  } catch (e: any) {
    return [0, `Error: ${e.message}`];
  }
}
