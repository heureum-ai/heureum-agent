/**
 * Shared XML parsing/building utilities for DOCX manipulation.
 *
 * Uses fast-xml-parser with preserveOrder: true.
 * Centralizes PARSER_OPTIONS, BUILDER_OPTIONS, parseXml, buildXml,
 * getTagName, and tagMatches to avoid duplication across modules.
 */
import { XMLParser, XMLBuilder } from "fast-xml-parser";

export const PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
  allowBooleanAttributes: true,
};

export const BUILDER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  suppressBooleanAttributes: false,
  format: false,
};

/**
 * Parse an XML string into a fast-xml-parser preserveOrder node array.
 * Filters out the `?xml` declaration node to prevent double declarations
 * when round-tripping through buildXml.
 */
export function parseXml(xmlStr: string): any[] {
  const parser = new XMLParser(PARSER_OPTIONS);
  const result = parser.parse(xmlStr);
  return Array.isArray(result)
    ? result.filter((n: any) => !("?xml" in n))
    : [result];
}

/**
 * Build an XML string from a fast-xml-parser preserveOrder node array.
 * Prepends the `<?xml ...?>` declaration and filters out any `?xml` nodes
 * to avoid double declarations.
 */
export function buildXml(nodes: any[]): string {
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  const filtered = nodes.filter((n: any) => !("?xml" in n));
  return '<?xml version="1.0" encoding="UTF-8"?>' + builder.build(filtered);
}

/**
 * Get the tag name of a preserveOrder node.
 * Returns the first key that is not a special prefix (`@_`, `#`, `:@`).
 * Returns null for text nodes, attribute containers, or non-objects.
 */
export function getTagName(node: any): string | null {
  if (typeof node !== "object" || node === null) return null;
  for (const key of Object.keys(node)) {
    if (!key.startsWith("@_") && !key.startsWith("#") && key !== ":@") {
      return key;
    }
  }
  return null;
}

/**
 * Check if a tag name matches a local name (handles namespace prefixes).
 * e.g. tagMatches("w:r", "r") === true, tagMatches("w:rPr", "r") === false
 */
export function tagMatches(tagName: string | null, localName: string): boolean {
  if (!tagName) return false;
  return tagName === localName || tagName.endsWith(`:${localName}`);
}
