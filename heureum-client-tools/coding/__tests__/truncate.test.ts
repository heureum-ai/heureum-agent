import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	GREP_MAX_LINE_LENGTH,
	formatSize,
	truncateHead,
	truncateLine,
	truncateTail,
} from "../src/truncate.js";

describe("formatSize", () => {
	it("formats bytes", () => {
		expect(formatSize(500)).toBe("500B");
	});

	it("formats kilobytes", () => {
		expect(formatSize(1024)).toBe("1.0KB");
		expect(formatSize(2560)).toBe("2.5KB");
	});

	it("formats megabytes", () => {
		expect(formatSize(1024 * 1024)).toBe("1.0MB");
		expect(formatSize(5.5 * 1024 * 1024)).toBe("5.5MB");
	});
});

describe("truncateHead", () => {
	it("returns full content when under limits", () => {
		const content = "line1\nline2\nline3";
		const result = truncateHead(content);
		expect(result.truncated).toBe(false);
		expect(result.content).toBe(content);
		expect(result.totalLines).toBe(3);
	});

	it("truncates by line limit", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		const content = lines.join("\n");
		const result = truncateHead(content, { maxLines: 5 });
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("lines");
		expect(result.outputLines).toBe(5);
		expect(result.content).toBe("line1\nline2\nline3\nline4\nline5");
	});

	it("truncates by byte limit", () => {
		const line = "a".repeat(100);
		const content = Array.from({ length: 10 }, () => line).join("\n");
		const result = truncateHead(content, { maxBytes: 350 });
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.outputLines).toBeLessThan(10);
	});

	it("handles first line exceeding byte limit", () => {
		const content = "a".repeat(200);
		const result = truncateHead(content, { maxBytes: 100 });
		expect(result.truncated).toBe(true);
		expect(result.firstLineExceedsLimit).toBe(true);
		expect(result.content).toBe("");
	});

	it("uses default limits", () => {
		const result = truncateHead("short");
		expect(result.maxLines).toBe(DEFAULT_MAX_LINES);
		expect(result.maxBytes).toBe(DEFAULT_MAX_BYTES);
	});
});

describe("truncateTail", () => {
	it("returns full content when under limits", () => {
		const content = "line1\nline2\nline3";
		const result = truncateTail(content);
		expect(result.truncated).toBe(false);
		expect(result.content).toBe(content);
	});

	it("keeps last N lines", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		const content = lines.join("\n");
		const result = truncateTail(content, { maxLines: 3 });
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("lines");
		expect(result.outputLines).toBe(3);
		expect(result.content).toBe("line8\nline9\nline10");
	});

	it("truncates by byte limit keeping tail", () => {
		const line = "a".repeat(100);
		const content = Array.from({ length: 10 }, () => line).join("\n");
		const result = truncateTail(content, { maxBytes: 350 });
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		// Should keep the last lines
		expect(result.content).toContain("a".repeat(100));
	});

	it("handles partial last line when it exceeds byte limit", () => {
		const content = "x".repeat(200);
		const result = truncateTail(content, { maxBytes: 50 });
		expect(result.truncated).toBe(true);
		expect(result.lastLinePartial).toBe(true);
	});
});

describe("truncateLine", () => {
	it("returns short lines unchanged", () => {
		const { text, wasTruncated } = truncateLine("hello world");
		expect(text).toBe("hello world");
		expect(wasTruncated).toBe(false);
	});

	it("truncates long lines", () => {
		const long = "a".repeat(GREP_MAX_LINE_LENGTH + 100);
		const { text, wasTruncated } = truncateLine(long);
		expect(wasTruncated).toBe(true);
		expect(text).toContain("[truncated]");
		expect(text.length).toBeLessThan(long.length);
	});

	it("respects custom maxChars", () => {
		const { text, wasTruncated } = truncateLine("abcdefghij", 5);
		expect(wasTruncated).toBe(true);
		expect(text).toBe("abcde... [truncated]");
	});
});
