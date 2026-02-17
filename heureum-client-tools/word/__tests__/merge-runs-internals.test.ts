/**
 * Function-level unit tests for merge-runs.ts internal functions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { _internal } from "../src/helpers/merge-runs";
import {
  createTestDocxBuffer,
  unpackDocxToDir,
} from "./helpers/create-test-docx";

const {
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
} = _internal;

// ── parseXml / buildXml ──────────────────────────────────────────────

describe("parseXml", () => {
  it("filters out ?xml declaration node", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><root><child/></root>';
    const nodes = parseXml(xml);
    expect(nodes.every((n: any) => !("?xml" in n))).toBe(true);
  });

  it("returns root element(s)", () => {
    const xml = '<?xml version="1.0"?><root><child/></root>';
    const nodes = parseXml(xml);
    expect(getTagName(nodes[0])).toBe("root");
  });
});

describe("buildXml", () => {
  it("roundtrips simple XML", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><root><child/></root>';
    const nodes = parseXml(xml);
    const result = buildXml(nodes);
    expect(result).toContain("<?xml");
    expect(result).toContain("<root>");
    expect(result).toContain("<child");
  });

  it("does not double ?xml declaration", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><root/>';
    const nodes = parseXml(xml);
    const result = buildXml(nodes);
    const matches = result.match(/<\?xml/g);
    expect(matches).toHaveLength(1);
  });
});

// ── getTagName / tagMatches ──────────────────────────────────────────

describe("getTagName", () => {
  it("returns tag name for element node", () => {
    expect(getTagName({ "w:r": [] })).toBe("w:r");
  });

  it("returns null for #text node", () => {
    expect(getTagName({ "#text": "hello" })).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(getTagName(null)).toBeNull();
    expect(getTagName(undefined)).toBeNull();
  });

  it("ignores :@ attribute container", () => {
    expect(getTagName({ "w:p": [], ":@": { "@_id": "1" } })).toBe("w:p");
  });

  it("returns null for empty object", () => {
    expect(getTagName({})).toBeNull();
  });
});

describe("tagMatches", () => {
  it("matches exact local name", () => {
    expect(tagMatches("r", "r")).toBe(true);
  });

  it("matches namespaced tag", () => {
    expect(tagMatches("w:r", "r")).toBe(true);
  });

  it("rejects different local name", () => {
    expect(tagMatches("w:p", "r")).toBe(false);
  });

  it("handles null", () => {
    expect(tagMatches(null, "r")).toBe(false);
  });

  it("does not false-match partial names", () => {
    expect(tagMatches("w:rPr", "r")).toBe(false);
  });
});

// ── isRun ────────────────────────────────────────────────────────────

describe("isRun", () => {
  it("returns true for w:r", () => {
    expect(isRun({ "w:r": [] })).toBe(true);
  });

  it("returns true for bare r", () => {
    expect(isRun({ r: [] })).toBe(true);
  });

  it("returns false for w:rPr", () => {
    expect(isRun({ "w:rPr": [] })).toBe(false);
  });

  it("returns false for w:p", () => {
    expect(isRun({ "w:p": [] })).toBe(false);
  });

  it("returns false for #text node", () => {
    expect(isRun({ "#text": "abc" })).toBe(false);
  });
});

// ── removeElements ───────────────────────────────────────────────────

describe("removeElements", () => {
  it("removes top-level matching elements", () => {
    const xml =
      '<root><w:proofErr w:type="spellStart"/><w:r><w:t>hi</w:t></w:r></root>';
    const nodes = parseXml(xml);
    removeElements(nodes, "proofErr");
    const rebuilt = buildXml(nodes);
    expect(rebuilt).not.toContain("proofErr");
    expect(rebuilt).toContain("w:r");
  });

  it("removes nested matching elements", () => {
    const xml = "<root><parent><w:proofErr/></parent></root>";
    const nodes = parseXml(xml);
    removeElements(nodes, "proofErr");
    const rebuilt = buildXml(nodes);
    expect(rebuilt).not.toContain("proofErr");
  });

  it("removes multiple occurrences", () => {
    const xml =
      "<root><w:proofErr/><w:r/><w:proofErr/></root>";
    const nodes = parseXml(xml);
    removeElements(nodes, "proofErr");
    const rebuilt = buildXml(nodes);
    expect(rebuilt).not.toContain("proofErr");
  });

  it("does nothing when no match", () => {
    const xml = "<root><w:r><w:t>hi</w:t></w:r></root>";
    const nodes = parseXml(xml);
    const before = buildXml(nodes);
    removeElements(nodes, "proofErr");
    const after = buildXml(nodes);
    expect(after).toBe(before);
  });
});

// ── stripRunRsidAttrs ────────────────────────────────────────────────

describe("stripRunRsidAttrs", () => {
  it("removes w:rsidR from runs", () => {
    const xml = '<root><w:r w:rsidR="00A1"><w:t>hi</w:t></w:r></root>';
    const nodes = parseXml(xml);
    stripRunRsidAttrs(nodes);
    const rebuilt = buildXml(nodes);
    expect(rebuilt).not.toContain("rsid");
    expect(rebuilt).toContain("w:r");
  });

  it("removes multiple rsid attributes", () => {
    const xml =
      '<root><w:r w:rsidR="001" w:rsidRPr="002"><w:t>hi</w:t></w:r></root>';
    const nodes = parseXml(xml);
    stripRunRsidAttrs(nodes);
    const rebuilt = buildXml(nodes);
    expect(rebuilt).not.toContain("rsid");
  });

  it("does not remove non-rsid attributes from runs", () => {
    const xml =
      '<root><w:r w:rsidR="001" w:customAttr="keep"><w:t>hi</w:t></w:r></root>';
    const nodes = parseXml(xml);
    stripRunRsidAttrs(nodes);
    const rebuilt = buildXml(nodes);
    expect(rebuilt).not.toContain("rsid");
    expect(rebuilt).toContain("customAttr");
  });

  it("does not remove rsid from non-run elements", () => {
    const xml = '<root><w:p w:rsidR="001"><w:r><w:t>hi</w:t></w:r></w:p></root>';
    const nodes = parseXml(xml);
    stripRunRsidAttrs(nodes);
    const rebuilt = buildXml(nodes);
    // p still has rsid
    expect(rebuilt).toContain("rsidR");
  });

  it("handles runs without attributes", () => {
    const xml = "<root><w:r><w:t>hi</w:t></w:r></root>";
    const nodes = parseXml(xml);
    // Should not throw
    stripRunRsidAttrs(nodes);
    expect(buildXml(nodes)).toContain("w:r");
  });
});

// ── canMerge / getRprString ──────────────────────────────────────────

describe("canMerge", () => {
  it("returns true for two runs without rPr", () => {
    const run1 = parseXml("<w:r><w:t>a</w:t></w:r>")[0];
    const run2 = parseXml("<w:r><w:t>b</w:t></w:r>")[0];
    expect(canMerge(run1, run2)).toBe(true);
  });

  it("returns true for identical rPr", () => {
    const run1 = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>a</w:t></w:r>")[0];
    const run2 = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>b</w:t></w:r>")[0];
    expect(canMerge(run1, run2)).toBe(true);
  });

  it("returns false when one has rPr and other does not", () => {
    const run1 = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>a</w:t></w:r>")[0];
    const run2 = parseXml("<w:r><w:t>b</w:t></w:r>")[0];
    expect(canMerge(run1, run2)).toBe(false);
  });

  it("returns false for different rPr", () => {
    const run1 = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>a</w:t></w:r>")[0];
    const run2 = parseXml("<w:r><w:rPr><w:i/></w:rPr><w:t>b</w:t></w:r>")[0];
    expect(canMerge(run1, run2)).toBe(false);
  });

  it("returns false for rPr with different attributes", () => {
    const run1 = parseXml(
      '<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>a</w:t></w:r>'
    )[0];
    const run2 = parseXml(
      '<w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>b</w:t></w:r>'
    )[0];
    expect(canMerge(run1, run2)).toBe(false);
  });
});

describe("getRprString", () => {
  it("returns null when no rPr", () => {
    const run = parseXml("<w:r><w:t>hi</w:t></w:r>")[0];
    expect(getRprString(run)).toBeNull();
  });

  it("returns serialized rPr string", () => {
    const run = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>hi</w:t></w:r>")[0];
    const result = getRprString(run);
    expect(result).toContain("w:rPr");
    expect(result).toContain("w:b");
  });
});

// ── mergeRunContent ──────────────────────────────────────────────────

describe("mergeRunContent", () => {
  it("moves non-rPr children from source to target", () => {
    const target = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>a</w:t></w:r>")[0];
    const source = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>b</w:t></w:r>")[0];
    mergeRunContent(target, source);

    const targetChildren = target["w:r"];
    // Should have rPr + two t elements
    const tCount = targetChildren.filter(
      (c: any) => getTagName(c) === "w:t"
    ).length;
    expect(tCount).toBe(2);
  });

  it("does not duplicate rPr", () => {
    const target = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>a</w:t></w:r>")[0];
    const source = parseXml("<w:r><w:rPr><w:b/></w:rPr><w:t>b</w:t></w:r>")[0];
    mergeRunContent(target, source);

    const rPrCount = target["w:r"].filter(
      (c: any) => tagMatches(getTagName(c), "rPr")
    ).length;
    expect(rPrCount).toBe(1);
  });
});

// ── getTextContent / setTextContent ──────────────────────────────────

describe("getTextContent", () => {
  it("returns text from #text node", () => {
    const tElem = parseXml("<w:t>hello</w:t>")[0];
    expect(getTextContent(tElem)).toBe("hello");
  });

  it("returns empty string for empty element", () => {
    const tElem = parseXml("<w:t/>")[0];
    expect(getTextContent(tElem)).toBe("");
  });

  it("returns empty string for null tag", () => {
    expect(getTextContent({ "#text": "abc" })).toBe("");
  });
});

describe("setTextContent", () => {
  it("sets text content on a w:t element", () => {
    const tElem = parseXml("<w:t>old</w:t>")[0];
    setTextContent(tElem, "new");
    expect(getTextContent(tElem)).toBe("new");
  });
});

// ── consolidateText ──────────────────────────────────────────────────

describe("consolidateText", () => {
  it("merges two adjacent t elements into one", () => {
    const run = parseXml("<w:r><w:t>Hello </w:t><w:t>World</w:t></w:r>")[0];
    consolidateText(run);

    const tElems = run["w:r"].filter(
      (c: any) => tagMatches(getTagName(c), "t")
    );
    expect(tElems).toHaveLength(1);
    expect(getTextContent(tElems[0])).toBe("Hello World");
  });

  it("adds xml:space=preserve when merged text has leading space", () => {
    const run = parseXml("<w:r><w:t> A</w:t><w:t>B</w:t></w:r>")[0];
    consolidateText(run);

    const tElems = run["w:r"].filter(
      (c: any) => tagMatches(getTagName(c), "t")
    );
    expect(tElems).toHaveLength(1);
    expect(tElems[0][":@"]?.["@_xml:space"]).toBe("preserve");
  });

  it("adds xml:space=preserve when merged text has trailing space", () => {
    const run = parseXml("<w:r><w:t>A</w:t><w:t>B </w:t></w:r>")[0];
    consolidateText(run);

    const tElems = run["w:r"].filter(
      (c: any) => tagMatches(getTagName(c), "t")
    );
    expect(tElems[0][":@"]?.["@_xml:space"]).toBe("preserve");
  });

  it("removes xml:space when no leading/trailing spaces", () => {
    const run = parseXml("<w:r><w:t>A</w:t><w:t>B</w:t></w:r>")[0];
    consolidateText(run);

    const tElems = run["w:r"].filter(
      (c: any) => tagMatches(getTagName(c), "t")
    );
    const xmlSpace = tElems[0][":@"]?.["@_xml:space"];
    expect(xmlSpace).toBeUndefined();
  });

  it("does not merge t elements separated by another element", () => {
    const run = parseXml(
      "<w:r><w:t>A</w:t><w:br/><w:t>B</w:t></w:r>"
    )[0];
    consolidateText(run);

    const tElems = run["w:r"].filter(
      (c: any) => tagMatches(getTagName(c), "t")
    );
    expect(tElems).toHaveLength(2);
  });

  it("handles single t element (no-op)", () => {
    const run = parseXml("<w:r><w:t>only</w:t></w:r>")[0];
    consolidateText(run);

    const tElems = run["w:r"].filter(
      (c: any) => tagMatches(getTagName(c), "t")
    );
    expect(tElems).toHaveLength(1);
    expect(getTextContent(tElems[0])).toBe("only");
  });

  it("merges three adjacent t elements", () => {
    const run = parseXml(
      "<w:r><w:t>A</w:t><w:t>B</w:t><w:t>C</w:t></w:r>"
    )[0];
    consolidateText(run);

    const tElems = run["w:r"].filter(
      (c: any) => tagMatches(getTagName(c), "t")
    );
    expect(tElems).toHaveLength(1);
    expect(getTextContent(tElems[0])).toBe("ABC");
  });
});

// ── isWhitespaceText / nextElementIndex ──────────────────────────────

describe("isWhitespaceText", () => {
  it("returns true for whitespace #text", () => {
    expect(isWhitespaceText({ "#text": "  \n  " })).toBe(true);
  });

  it("returns false for non-empty #text", () => {
    expect(isWhitespaceText({ "#text": "hello" })).toBe(false);
  });

  it("returns false for element node", () => {
    expect(isWhitespaceText({ "w:r": [] })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isWhitespaceText(null)).toBe(false);
  });
});

describe("nextElementIndex", () => {
  it("finds next element skipping whitespace", () => {
    const children = [
      { "w:r": [] },
      { "#text": "  " },
      { "w:r": [] },
    ];
    expect(nextElementIndex(children, 1)).toBe(2);
  });

  it("returns -1 when no more elements", () => {
    const children = [
      { "w:r": [] },
      { "#text": "  " },
    ];
    expect(nextElementIndex(children, 1)).toBe(-1);
  });

  it("returns first element at startIdx", () => {
    const children = [
      { "w:r": [] },
      { "w:r": [] },
    ];
    expect(nextElementIndex(children, 0)).toBe(0);
  });
});

// ── mergeRunsInChildren ──────────────────────────────────────────────

describe("mergeRunsInChildren", () => {
  it("merges adjacent identical runs separated by whitespace", () => {
    const xml = `<w:p>
      <w:r><w:t>A</w:t></w:r>
      <w:r><w:t>B</w:t></w:r>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const tag = getTagName(container)!;
    const count = mergeRunsInChildren(container[tag]);
    expect(count).toBe(1);
  });

  it("does not merge runs with different rPr", () => {
    const xml = `<w:p>
      <w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r>
      <w:r><w:t>Normal</w:t></w:r>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const tag = getTagName(container)!;
    const count = mergeRunsInChildren(container[tag]);
    expect(count).toBe(0);
  });

  it("skips non-run elements between runs", () => {
    const xml = `<w:p>
      <w:r><w:t>A</w:t></w:r>
      <w:bookmarkStart/>
      <w:r><w:t>B</w:t></w:r>
    </w:p>`;
    const nodes = parseXml(xml);
    const container = nodes[0];
    const tag = getTagName(container)!;
    const count = mergeRunsInChildren(container[tag]);
    expect(count).toBe(0);
  });
});

// ── traverseAndMerge ─────────────────────────────────────────────────

describe("traverseAndMerge", () => {
  it("merges in nested containers (ins inside p)", () => {
    const xml = `<w:document><w:body>
      <w:p>
        <w:ins w:id="1" w:author="A" w:date="2024-01-01T00:00:00Z">
          <w:r><w:t>X</w:t></w:r>
          <w:r><w:t>Y</w:t></w:r>
        </w:ins>
      </w:p>
    </w:body></w:document>`;
    const nodes = parseXml(xml);
    const count = traverseAndMerge(nodes);
    expect(count).toBe(1);
  });

  it("returns 0 for document with no mergeable runs", () => {
    const xml = `<w:document><w:body>
      <w:p><w:r><w:t>single</w:t></w:r></w:p>
    </w:body></w:document>`;
    const nodes = parseXml(xml);
    const count = traverseAndMerge(nodes);
    expect(count).toBe(0);
  });
});
