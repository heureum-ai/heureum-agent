import { homedir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { assertPathWithinWorkspace, expandPath, resolveToCwd } from "../src/path-utils.js";

describe("expandPath", () => {
	it("expands ~ to home directory", () => {
		expect(expandPath("~")).toBe(homedir());
	});

	it("expands ~/path", () => {
		expect(expandPath("~/foo/bar")).toBe(path.join(homedir(), "foo/bar"));
	});

	it("strips @ prefix", () => {
		expect(expandPath("@/foo/bar")).toBe("/foo/bar");
	});

	it("normalizes unicode spaces", () => {
		// U+00A0 (non-breaking space) → regular space
		expect(expandPath("foo\u00A0bar")).toBe("foo bar");
	});

	it("returns absolute paths unchanged", () => {
		expect(expandPath("/usr/local/bin")).toBe("/usr/local/bin");
	});
});

describe("resolveToCwd", () => {
	it("resolves relative path to cwd", () => {
		expect(resolveToCwd("foo.ts", "/project")).toBe("/project/foo.ts");
	});

	it("resolves nested relative path", () => {
		expect(resolveToCwd("src/index.ts", "/project")).toBe("/project/src/index.ts");
	});

	it("keeps absolute paths", () => {
		expect(resolveToCwd("/tmp/file.txt", "/project")).toBe("/tmp/file.txt");
	});

	it("expands ~ before resolving", () => {
		const result = resolveToCwd("~/file.txt", "/project");
		expect(result).toBe(path.join(homedir(), "file.txt"));
	});
});

describe("assertPathWithinWorkspace", () => {
	it("allows paths inside workspace", async () => {
		const workspace = mkdtempSync(path.join(tmpdir(), "coding-path-utils-"));
		try {
			const resolved = await assertPathWithinWorkspace("src/index.ts", workspace, workspace);
			expect(resolved).toBe(path.join(workspace, "src/index.ts"));
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("rejects paths outside workspace", async () => {
		const workspace = mkdtempSync(path.join(tmpdir(), "coding-path-utils-"));
		try {
			await expect(assertPathWithinWorkspace("../outside.ts", workspace, workspace)).rejects.toThrow(
				"Path escapes working directory",
			);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
