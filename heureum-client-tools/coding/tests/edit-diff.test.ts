import { describe, expect, it } from "vitest";
import {
	detectLineEnding,
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "../src/edit-diff.js";

describe("detectLineEnding", () => {
	it("detects LF", () => {
		expect(detectLineEnding("foo\nbar")).toBe("\n");
	});

	it("detects CRLF", () => {
		expect(detectLineEnding("foo\r\nbar")).toBe("\r\n");
	});

	it("defaults to LF when no newlines", () => {
		expect(detectLineEnding("foobar")).toBe("\n");
	});
});

describe("normalizeToLF", () => {
	it("converts CRLF to LF", () => {
		expect(normalizeToLF("foo\r\nbar\r\n")).toBe("foo\nbar\n");
	});

	it("converts lone CR to LF", () => {
		expect(normalizeToLF("foo\rbar")).toBe("foo\nbar");
	});

	it("preserves LF", () => {
		expect(normalizeToLF("foo\nbar")).toBe("foo\nbar");
	});
});

describe("restoreLineEndings", () => {
	it("restores CRLF", () => {
		expect(restoreLineEndings("foo\nbar", "\r\n")).toBe("foo\r\nbar");
	});

	it("no-ops for LF", () => {
		expect(restoreLineEndings("foo\nbar", "\n")).toBe("foo\nbar");
	});
});

describe("stripBom", () => {
	it("strips UTF-8 BOM", () => {
		const result = stripBom("\uFEFFhello");
		expect(result.bom).toBe("\uFEFF");
		expect(result.text).toBe("hello");
	});

	it("returns empty bom when no BOM", () => {
		const result = stripBom("hello");
		expect(result.bom).toBe("");
		expect(result.text).toBe("hello");
	});
});

describe("normalizeForFuzzyMatch", () => {
	it("strips trailing whitespace", () => {
		expect(normalizeForFuzzyMatch("foo   \nbar  ")).toBe("foo\nbar");
	});

	it("normalizes smart quotes to ASCII", () => {
		expect(normalizeForFuzzyMatch("\u201Chello\u201D")).toBe('"hello"');
		expect(normalizeForFuzzyMatch("\u2018world\u2019")).toBe("'world'");
	});

	it("normalizes dashes", () => {
		expect(normalizeForFuzzyMatch("a\u2014b")).toBe("a-b"); // em-dash
		expect(normalizeForFuzzyMatch("a\u2013b")).toBe("a-b"); // en-dash
	});

	it("normalizes special spaces", () => {
		expect(normalizeForFuzzyMatch("a\u00A0b")).toBe("a b"); // NBSP
	});
});

describe("fuzzyFindText", () => {
	it("finds exact match", () => {
		const result = fuzzyFindText("hello world", "world");
		expect(result.found).toBe(true);
		expect(result.index).toBe(6);
		expect(result.usedFuzzyMatch).toBe(false);
	});

	it("falls back to fuzzy match with trailing whitespace", () => {
		const content = "hello   \nworld";
		const oldText = "hello\nworld";
		const result = fuzzyFindText(content, oldText);
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});

	it("returns not found when text is absent", () => {
		const result = fuzzyFindText("hello world", "missing");
		expect(result.found).toBe(false);
	});

	it("matches with smart quote normalization", () => {
		const content = 'say \u201Chello\u201D';
		const oldText = 'say "hello"';
		const result = fuzzyFindText(content, oldText);
		expect(result.found).toBe(true);
		expect(result.usedFuzzyMatch).toBe(true);
	});
});

describe("generateDiffString", () => {
	it("generates diff for simple change", () => {
		const old = "line1\nline2\nline3";
		const new_ = "line1\nmodified\nline3";
		const { diff, firstChangedLine } = generateDiffString(old, new_);
		expect(diff).toContain("-");
		expect(diff).toContain("+");
		expect(diff).toContain("line2");
		expect(diff).toContain("modified");
		expect(firstChangedLine).toBe(2);
	});

	it("handles addition", () => {
		const old = "line1\nline3";
		const new_ = "line1\nline2\nline3";
		const { diff } = generateDiffString(old, new_);
		expect(diff).toContain("+");
		expect(diff).toContain("line2");
	});

	it("handles deletion", () => {
		const old = "line1\nline2\nline3";
		const new_ = "line1\nline3";
		const { diff } = generateDiffString(old, new_);
		expect(diff).toContain("-");
		expect(diff).toContain("line2");
	});
});
