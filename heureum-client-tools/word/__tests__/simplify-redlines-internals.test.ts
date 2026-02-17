/**
 * Function-level unit tests for simplify-redlines.ts internal functions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { _internal } from "../src/helpers/simplify-redlines";

const {
  parseXml,
  buildXml,
  getTagName,
  tagMatches,
  findElements,
  getAuthor,
  canMergeTracked,
  mergeTrackedChangesIn,
} = _internal;

// ── parseXml / buildXml ──────────────────────────────────────────────

describe("simplify-redlines parseXml", () => {
  it("filters ?xml declaration", () => {
    const nodes = parseXml('<?xml version="1.0"?><root/>');
    expect(nodes.every((n: any) => !("?xml" in n))).toBe(true);
    expect(getTagName(nodes[0])).toBe("root");
  });
});

describe("simplify-redlines buildXml", () => {
  it("produces single ?xml declaration", () => {
    const nodes = parseXml('<?xml version="1.0"?><root/>');
    const xml = buildXml(nodes);
    expect((xml.match(/<\?xml/g) || []).length).toBe(1);
    expect(xml).toContain("<root");
  });
});

// ── getTagName / tagMatches ──────────────────────────────────────────

describe("simplify-redlines getTagName", () => {
  it("returns tag name for element", () => {
    expect(getTagName({ "w:ins": [] })).toBe("w:ins");
  });

  it("returns null for #text node", () => {
    expect(getTagName({ "#text": "x" })).toBeNull();
  });

  it("returns null for null", () => {
    expect(getTagName(null)).toBeNull();
  });
});

describe("simplify-redlines tagMatches", () => {
  it("matches namespaced tag", () => {
    expect(tagMatches("w:ins", "ins")).toBe(true);
  });

  it("matches exact local name", () => {
    expect(tagMatches("ins", "ins")).toBe(true);
  });

  it("rejects different local name", () => {
    expect(tagMatches("w:del", "ins")).toBe(false);
  });

  it("handles null", () => {
    expect(tagMatches(null, "ins")).toBe(false);
  });
});

// ── findElements ─────────────────────────────────────────────────────

describe("findElements", () => {
  it("finds top-level elements", () => {
    const xml = '<root><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>hi</w:t></w:r></w:ins></root>';
    const nodes = parseXml(xml);
    const found = findElements(nodes, "ins");
    expect(found.length).toBe(1);
  });

  it("finds nested elements", () => {
    const xml = '<root><w:p><w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>hi</w:t></w:r></w:ins></w:p></root>';
    const nodes = parseXml(xml);
    const found = findElements(nodes, "ins");
    expect(found.length).toBe(1);
  });

  it("returns empty when no match", () => {
    const xml = "<root><w:p><w:r><w:t>hi</w:t></w:r></w:p></root>";
    const nodes = parseXml(xml);
    const found = findElements(nodes, "ins");
    expect(found.length).toBe(0);
  });

  it("finds multiple elements", () => {
    const xml = `<root>
      <w:p>
        <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>a</w:t></w:r></w:ins>
        <w:ins w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>b</w:t></w:r></w:ins>
      </w:p>
    </root>`;
    const nodes = parseXml(xml);
    const found = findElements(nodes, "ins");
    expect(found.length).toBe(2);
  });

  it("finds both ins and del", () => {
    const xml = `<root>
      <w:p>
        <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>a</w:t></w:r></w:ins>
        <w:del w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>b</w:delText></w:r></w:del>
      </w:p>
    </root>`;
    const nodes = parseXml(xml);
    expect(findElements(nodes, "ins").length).toBe(1);
    expect(findElements(nodes, "del").length).toBe(1);
  });
});

// ── getAuthor ────────────────────────────────────────────────────────

describe("getAuthor", () => {
  it("returns w:author attribute", () => {
    const xml = '<w:ins w:id="1" w:author="John" w:date="2024-01-01T00:00:00Z"><w:r><w:t>hi</w:t></w:r></w:ins>';
    const node = parseXml(xml)[0];
    expect(getAuthor(node)).toBe("John");
  });

  it("returns empty string when no author", () => {
    const xml = '<w:ins w:id="1" w:date="2024-01-01T00:00:00Z"><w:r><w:t>hi</w:t></w:r></w:ins>';
    const node = parseXml(xml)[0];
    expect(getAuthor(node)).toBe("");
  });

  it("returns empty string when no attributes", () => {
    expect(getAuthor({ "w:ins": [] })).toBe("");
  });
});

// ── canMergeTracked ──────────────────────────────────────────────────

describe("canMergeTracked", () => {
  it("returns true for adjacent same-author ins elements", () => {
    const xml = `<w:p>
      <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>a</w:t></w:r></w:ins>
      <w:ins w:id="2" w:author="A" w:date="2024-01-02T00:00:00Z"><w:r><w:t>b</w:t></w:r></w:ins>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const tag = getTagName(container)!;
    const children = container[tag];

    // Find the indices of ins elements
    const insIndices: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (tagMatches(getTagName(children[i]), "ins")) insIndices.push(i);
    }
    expect(insIndices.length).toBe(2);
    expect(canMergeTracked(container, tag, insIndices[0], insIndices[1])).toBe(true);
  });

  it("returns false for different authors", () => {
    const xml = `<w:p>
      <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>a</w:t></w:r></w:ins>
      <w:ins w:id="2" w:author="B" w:date="2024-01-01T00:00:00Z"><w:r><w:t>b</w:t></w:r></w:ins>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const tag = getTagName(container)!;
    const children = container[tag];

    const insIndices: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (tagMatches(getTagName(children[i]), "ins")) insIndices.push(i);
    }
    expect(canMergeTracked(container, tag, insIndices[0], insIndices[1])).toBe(false);
  });

  it("returns false when element exists between tracked changes", () => {
    const xml = `<w:p>
      <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>a</w:t></w:r></w:ins>
      <w:r><w:t>middle</w:t></w:r>
      <w:ins w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>b</w:t></w:r></w:ins>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const tag = getTagName(container)!;
    const children = container[tag];

    const insIndices: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (tagMatches(getTagName(children[i]), "ins")) insIndices.push(i);
    }
    expect(canMergeTracked(container, tag, insIndices[0], insIndices[1])).toBe(false);
  });
});

// ── mergeTrackedChangesIn ────────────────────────────────────────────

describe("mergeTrackedChangesIn", () => {
  it("merges adjacent ins elements from same author", () => {
    const xml = `<w:p>
      <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>a</w:t></w:r></w:ins>
      <w:ins w:id="2" w:author="A" w:date="2024-01-02T00:00:00Z"><w:r><w:t>b</w:t></w:r></w:ins>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const count = mergeTrackedChangesIn(container, "ins");
    expect(count).toBe(1);

    // Should have 1 ins element with 2 runs
    const tag = getTagName(container)!;
    const insElems = container[tag].filter((c: any) => tagMatches(getTagName(c), "ins"));
    expect(insElems.length).toBe(1);
  });

  it("does not merge adjacent del elements from different authors", () => {
    const xml = `<w:p>
      <w:del w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>a</w:delText></w:r></w:del>
      <w:del w:id="2" w:author="B" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>b</w:delText></w:r></w:del>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const count = mergeTrackedChangesIn(container, "del");
    expect(count).toBe(0);
  });

  it("returns 0 for single tracked change", () => {
    const xml = `<w:p>
      <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>a</w:t></w:r></w:ins>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const count = mergeTrackedChangesIn(container, "ins");
    expect(count).toBe(0);
  });

  it("returns 0 for no tracked changes", () => {
    const xml = "<w:p><w:r><w:t>normal</w:t></w:r></w:p>";
    const nodes = parseXml(xml);
    const container = nodes[0];
    const count = mergeTrackedChangesIn(container, "ins");
    expect(count).toBe(0);
  });

  it("merges three consecutive same-author ins elements", () => {
    const xml = `<w:p>
      <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>a</w:t></w:r></w:ins>
      <w:ins w:id="2" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>b</w:t></w:r></w:ins>
      <w:ins w:id="3" w:author="A" w:date="2024-01-01T00:00:00Z"><w:r><w:t>c</w:t></w:r></w:ins>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const count = mergeTrackedChangesIn(container, "ins");
    expect(count).toBe(2);

    const tag = getTagName(container)!;
    const insElems = container[tag].filter((c: any) => tagMatches(getTagName(c), "ins"));
    expect(insElems.length).toBe(1);
  });
});
