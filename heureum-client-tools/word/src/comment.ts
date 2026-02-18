/**
 * Add comments to DOCX documents.
 *
 * After running, add markers to document.xml:
 *   <w:commentRangeStart w:id="0"/>
 *   ... commented content ...
 *   <w:commentRangeEnd w:id="0"/>
 *   <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
 *
 * Ported from comment.py
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { buildXml, getTagName, parseXml } from "./xml-utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_DIR = path.join(__dirname, "templates");

const NS: Record<string, string> = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  w16cid: "http://schemas.microsoft.com/office/word/2016/wordml/cid",
  w16cex: "http://schemas.microsoft.com/office/word/2018/wordml/cex",
};

const COMMENT_XML = `\
<w:comment w:id="{id}" w:author="{author}" w:date="{date}" w:initials="{initials}">
  <w:p w14:paraId="{para_id}" w14:textId="77777777">
    <w:r>
      <w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>
      <w:annotationRef/>
    </w:r>
    <w:r>
      <w:rPr>
        <w:color w:val="000000"/>
        <w:sz w:val="20"/>
        <w:szCs w:val="20"/>
      </w:rPr>
      <w:t>{text}</w:t>
    </w:r>
  </w:p>
</w:comment>`;

export const COMMENT_MARKER_TEMPLATE = `
Add to document.xml (markers must be direct children of w:p, never inside w:r):
  <w:commentRangeStart w:id="{cid}"/>
  <w:r>...</w:r>
  <w:commentRangeEnd w:id="{cid}"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{cid}"/></w:r>`;

export const REPLY_MARKER_TEMPLATE = `
Nest markers inside parent {pid}'s markers (markers must be direct children of w:p, never inside w:r):
  <w:commentRangeStart w:id="{pid}"/><w:commentRangeStart w:id="{cid}"/>
  <w:r>...</w:r>
  <w:commentRangeEnd w:id="{cid}"/><w:commentRangeEnd w:id="{pid}"/>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{pid}"/></w:r>
  <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="{cid}"/></w:r>`;

const SMART_QUOTE_ENTITIES: Record<string, string> = {
  "\u201c": "&#x201C;",
  "\u201d": "&#x201D;",
  "\u2018": "&#x2018;",
  "\u2019": "&#x2019;",
};

function generateHexId(): string {
  const value = Math.floor(Math.random() * 0x7ffffffe);
  return value.toString(16).toUpperCase().padStart(8, "0");
}

function encodeSmartQuotes(text: string): string {
  let result = text;
  for (const [char, entity] of Object.entries(SMART_QUOTE_ENTITIES)) {
    result = result.replaceAll(char, entity);
  }
  return result;
}

/** Alias for buildXml — kept for backward compatibility with _internal exports */
const buildXmlString = buildXml;

/**
 * Append XML content as a child of the specified root tag in a file.
 */
function appendXml(
  xmlPath: string,
  rootTag: string,
  content: string
): void {
  const fileContent = fs.readFileSync(xmlPath, "utf-8");
  const nodes = parseXml(fileContent);

  // Build namespace attributes for the wrapper
  const nsAttrs = Object.entries(NS)
    .map(([k, v]) => `xmlns:${k}="${v}"`)
    .join(" ");
  const wrappedContent = `<root ${nsAttrs}>${content}</root>`;
  const contentNodes = parseXml(wrappedContent);

  // Find the root element
  let rootNode: any = null;
  for (const node of nodes) {
    const tag = getTagName(node);
    if (tag === rootTag) {
      rootNode = node;
      break;
    }
  }

  if (!rootNode) return;

  // Get children from the wrapper's "root" element
  const wrapperNode = contentNodes[0];
  const wrapperTag = getTagName(wrapperNode);
  if (!wrapperTag) return;

  const childrenToAdd = wrapperNode[wrapperTag];
  if (!Array.isArray(childrenToAdd)) return;

  // Add only element children (skip text nodes)
  if (!Array.isArray(rootNode[rootTag])) rootNode[rootTag] = [];
  for (const child of childrenToAdd) {
    if (typeof child === "object" && child !== null && getTagName(child)) {
      rootNode[rootTag].push(child);
    }
  }

  const output = encodeSmartQuotes(buildXmlString(nodes));
  fs.writeFileSync(xmlPath, output, "utf-8");
}

/** Find paraId from a comment by its id in comments.xml */
function findParaId(commentsPath: string, commentId: number): string | null {
  const content = fs.readFileSync(commentsPath, "utf-8");
  const nodes = parseXml(content);

  function findInNodes(arr: any[]): string | null {
    for (const node of arr) {
      const tag = getTagName(node);
      if (!tag) continue;

      // Check if this is a w:comment with matching id
      if (tag === "w:comment" || tag.endsWith(":comment")) {
        const attrs = node[":@"] || {};
        const idVal = attrs["@_w:id"];
        if (idVal === String(commentId)) {
          // Find w:p child and get w14:paraId
          if (Array.isArray(node[tag])) {
            for (const child of node[tag]) {
              const childTag = getTagName(child);
              if (
                childTag &&
                (childTag === "w:p" || childTag.endsWith(":p"))
              ) {
                const childAttrs = child[":@"] || {};
                const paraId = childAttrs["@_w14:paraId"];
                if (paraId) return paraId;
              }
            }
          }
        }
      }

      // Recurse
      if (tag && Array.isArray(node[tag])) {
        const found = findInNodes(node[tag]);
        if (found) return found;
      }
    }
    return null;
  }

  return findInNodes(nodes);
}

/** Get the next available relationship ID from a .rels file */
function getNextRid(relsPath: string): number {
  const content = fs.readFileSync(relsPath, "utf-8");
  const nodes = parseXml(content);

  let maxRid = 0;
  function findRels(arr: any[]): void {
    for (const node of arr) {
      const tag = getTagName(node);
      if (tag === "Relationship") {
        const attrs = node[":@"] || {};
        const rid = attrs["@_Id"] || "";
        if (rid.startsWith("rId")) {
          const num = parseInt(rid.slice(3), 10);
          if (!isNaN(num) && num > maxRid) maxRid = num;
        }
      }
      if (tag && Array.isArray(node[tag])) {
        findRels(node[tag]);
      }
    }
  }
  findRels(nodes);
  return maxRid + 1;
}

/** Check if a relationship target exists in a .rels file */
function hasRelationship(relsPath: string, target: string): boolean {
  const content = fs.readFileSync(relsPath, "utf-8");
  const nodes = parseXml(content);

  function search(arr: any[]): boolean {
    for (const node of arr) {
      const tag = getTagName(node);
      if (tag === "Relationship") {
        const attrs = node[":@"] || {};
        if (attrs["@_Target"] === target) return true;
      }
      if (tag && Array.isArray(node[tag])) {
        if (search(node[tag])) return true;
      }
    }
    return false;
  }
  return search(nodes);
}

/** Check if a content type override exists */
function hasContentType(ctPath: string, partName: string): boolean {
  const content = fs.readFileSync(ctPath, "utf-8");
  const nodes = parseXml(content);

  function search(arr: any[]): boolean {
    for (const node of arr) {
      const tag = getTagName(node);
      if (tag === "Override") {
        const attrs = node[":@"] || {};
        if (attrs["@_PartName"] === partName) return true;
      }
      if (tag && Array.isArray(node[tag])) {
        if (search(node[tag])) return true;
      }
    }
    return false;
  }
  return search(nodes);
}

/** Ensure comment relationships are registered in document.xml.rels */
function ensureCommentRelationships(unpackedDir: string): void {
  const relsPath = path.join(
    unpackedDir,
    "word",
    "_rels",
    "document.xml.rels"
  );
  if (!fs.existsSync(relsPath)) return;

  const content = fs.readFileSync(relsPath, "utf-8");
  const nodes = parseXml(content);

  let nextRid = getNextRid(relsPath);

  const rels: [string, string][] = [
    [
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
      "comments.xml",
    ],
    [
      "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
      "commentsExtended.xml",
    ],
    [
      "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
      "commentsIds.xml",
    ],
    [
      "http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible",
      "commentsExtensible.xml",
    ],
  ];

  // Find the root Relationships element
  let rootNode: any = null;
  let rootTag: string = "";
  for (const node of nodes) {
    const tag = getTagName(node);
    if (tag === "Relationships") {
      rootNode = node;
      rootTag = tag;
      break;
    }
  }
  if (!rootNode) return;

  if (!Array.isArray(rootNode[rootTag])) rootNode[rootTag] = [];

  let added = 0;
  for (const [relType, target] of rels) {
    // Check each target individually — some may already exist
    if (hasRelationship(relsPath, target)) continue;
    rootNode[rootTag].push({
      Relationship: [],
      ":@": {
        "@_Id": `rId${nextRid}`,
        "@_Type": relType,
        "@_Target": target,
      },
    });
    nextRid++;
    added++;
  }

  if (added > 0) {
    fs.writeFileSync(relsPath, buildXmlString(nodes), "utf-8");
  }
}

/** Ensure comment content types are registered */
function ensureCommentContentTypes(unpackedDir: string): void {
  const ctPath = path.join(unpackedDir, "[Content_Types].xml");
  if (!fs.existsSync(ctPath)) return;

  const content = fs.readFileSync(ctPath, "utf-8");
  const nodes = parseXml(content);

  const overrides: [string, string][] = [
    [
      "/word/comments.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
    ],
    [
      "/word/commentsExtended.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
    ],
    [
      "/word/commentsIds.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml",
    ],
    [
      "/word/commentsExtensible.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml",
    ],
  ];

  // Find the root Types element
  let rootNode: any = null;
  let rootTag: string = "";
  for (const node of nodes) {
    const tag = getTagName(node);
    if (tag === "Types") {
      rootNode = node;
      rootTag = tag;
      break;
    }
  }
  if (!rootNode) return;

  if (!Array.isArray(rootNode[rootTag])) rootNode[rootTag] = [];

  let added = 0;
  for (const [partName, contentType] of overrides) {
    // Check each content type individually
    if (hasContentType(ctPath, partName)) continue;
    rootNode[rootTag].push({
      Override: [],
      ":@": {
        "@_PartName": partName,
        "@_ContentType": contentType,
      },
    });
    added++;
  }

  if (added > 0) {
    fs.writeFileSync(ctPath, buildXmlString(nodes), "utf-8");
  }
}

/** Copy a template file if the destination doesn't exist */
function ensureTemplate(templateName: string, destPath: string): void {
  if (fs.existsSync(destPath)) return;
  const srcPath = path.join(TEMPLATE_DIR, templateName);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, destPath);
  }
}

/** @internal Exported for testing only */
export const _internal = {
  generateHexId,
  encodeSmartQuotes,
  parseXml: parseXml,
  buildXmlString,
  getTagName,
  appendXml,
  findParaId,
  getNextRid,
  hasRelationship,
  hasContentType,
  ensureCommentRelationships,
  ensureCommentContentTypes,
  ensureTemplate,
};

/**
 * Add a comment to an unpacked DOCX document.
 *
 * @param unpackedDir - Path to unpacked DOCX directory
 * @param commentId - Comment ID (must be unique)
 * @param text - Comment text (pre-escaped XML)
 * @param author - Author name
 * @param initials - Author initials
 * @param parentId - Parent comment ID for replies
 * @returns [paraId, message] tuple
 */
export function addComment(
  unpackedDir: string,
  commentId: number,
  text: string,
  author: string = "Claude",
  initials: string = "C",
  parentId?: number
): [string, string] {
  const word = path.join(unpackedDir, "word");
  if (!fs.existsSync(word)) {
    return ["", `Error: ${word} not found`];
  }

  const paraId = generateHexId();
  const durableId = generateHexId();
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // comments.xml
  const commentsPath = path.join(word, "comments.xml");
  if (!fs.existsSync(commentsPath)) {
    ensureTemplate("comments.xml", commentsPath);
  }
  // Always ensure rels & content types — the functions are idempotent
  ensureCommentRelationships(unpackedDir);
  ensureCommentContentTypes(unpackedDir);

  const commentXml = COMMENT_XML.replace("{id}", String(commentId))
    .replace("{author}", author)
    .replace("{date}", ts)
    .replace("{initials}", initials)
    .replace("{para_id}", paraId)
    .replace("{text}", text);

  appendXml(commentsPath, "w:comments", commentXml);

  // commentsExtended.xml
  const extPath = path.join(word, "commentsExtended.xml");
  ensureTemplate("commentsExtended.xml", extPath);

  if (parentId !== undefined) {
    const parentPara = findParaId(commentsPath, parentId);
    if (!parentPara) {
      return ["", `Error: Parent comment ${parentId} not found`];
    }
    appendXml(
      extPath,
      "w15:commentsEx",
      `<w15:commentEx w15:paraId="${paraId}" w15:paraIdParent="${parentPara}" w15:done="0"/>`
    );
  } else {
    appendXml(
      extPath,
      "w15:commentsEx",
      `<w15:commentEx w15:paraId="${paraId}" w15:done="0"/>`
    );
  }

  // commentsIds.xml
  const idsPath = path.join(word, "commentsIds.xml");
  ensureTemplate("commentsIds.xml", idsPath);
  appendXml(
    idsPath,
    "w16cid:commentsIds",
    `<w16cid:commentId w16cid:paraId="${paraId}" w16cid:durableId="${durableId}"/>`
  );

  // commentsExtensible.xml
  const extensiblePath = path.join(word, "commentsExtensible.xml");
  ensureTemplate("commentsExtensible.xml", extensiblePath);
  appendXml(
    extensiblePath,
    "w16cex:commentsExtensible",
    `<w16cex:commentExtensible w16cex:durableId="${durableId}" w16cex:dateUtc="${ts}"/>`
  );

  const action = parentId !== undefined ? "reply" : "comment";
  return [paraId, `Added ${action} ${commentId} (para_id=${paraId})`];
}
