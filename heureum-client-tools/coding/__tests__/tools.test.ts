import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingTool } from "../src/tool-schema.js";

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(path.join(tmpdir(), "coding-test-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe("bash tool", () => {
	it("executes a command and returns output", async () => {
		const result = await handleCodingTool("bash", {
			command: "echo hello",
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output.trim()).toBe("hello");
	});

	it("returns error for failing command", async () => {
		const result = await handleCodingTool("bash", {
			command: "exit 1",
			working_directory: testDir,
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("Command exited with code 1");
	});

	it("captures stderr", async () => {
		const result = await handleCodingTool("bash", {
			command: "echo error >&2 && exit 0",
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("error");
	});

	it("respects timeout", async () => {
		const result = await handleCodingTool("bash", {
			command: "sleep 10",
			timeout: 1,
			working_directory: testDir,
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("timed out");
	}, 10000);
});

describe("read tool", () => {
	it("reads a text file", async () => {
		const filePath = path.join(testDir, "test.txt");
		writeFileSync(filePath, "line1\nline2\nline3\n");

		const result = await handleCodingTool("read", {
			path: filePath,
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("line1");
		expect(result.output).toContain("line2");
		expect(result.output).toContain("line3");
	});

	it("reads with offset and limit", async () => {
		const filePath = path.join(testDir, "test.txt");
		writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\n");

		const result = await handleCodingTool("read", {
			path: filePath,
			offset: 2,
			limit: 2,
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("line2");
		expect(result.output).toContain("line3");
		expect(result.output).not.toContain("line1");
	});

	it("returns error for non-existent file", async () => {
		const result = await handleCodingTool("read", {
			path: path.join(testDir, "nonexistent.txt"),
			working_directory: testDir,
		});
		expect(result.success).toBe(false);
	});
});

describe("write tool", () => {
	it("creates a new file", async () => {
		const filePath = path.join(testDir, "new.txt");

		const result = await handleCodingTool("write", {
			path: filePath,
			content: "hello world",
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("Successfully wrote");

		// Verify by reading back
		const readResult = await handleCodingTool("read", {
			path: filePath,
			working_directory: testDir,
		});
		expect(readResult.output).toContain("hello world");
	});

	it("creates parent directories", async () => {
		const filePath = path.join(testDir, "a", "b", "c.txt");

		const result = await handleCodingTool("write", {
			path: filePath,
			content: "nested",
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
	});
});

describe("edit tool", () => {
	it("replaces text in a file", async () => {
		const filePath = path.join(testDir, "edit.txt");
		writeFileSync(filePath, "hello world\nfoo bar\n");

		const result = await handleCodingTool("edit", {
			path: filePath,
			oldText: "foo bar",
			newText: "baz qux",
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("Successfully replaced");

		const readResult = await handleCodingTool("read", {
			path: filePath,
			working_directory: testDir,
		});
		expect(readResult.output).toContain("baz qux");
		expect(readResult.output).not.toContain("foo bar");
	});

	it("returns error when text not found", async () => {
		const filePath = path.join(testDir, "edit.txt");
		writeFileSync(filePath, "hello world\n");

		const result = await handleCodingTool("edit", {
			path: filePath,
			oldText: "nonexistent",
			newText: "replaced",
			working_directory: testDir,
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("Could not find");
	});

	it("returns error for non-existent file", async () => {
		const result = await handleCodingTool("edit", {
			path: path.join(testDir, "nope.txt"),
			oldText: "a",
			newText: "b",
			working_directory: testDir,
		});
		expect(result.success).toBe(false);
	});
});

describe("ls tool", () => {
	it("lists directory contents", async () => {
		writeFileSync(path.join(testDir, "a.txt"), "");
		writeFileSync(path.join(testDir, "b.txt"), "");
		mkdirSync(path.join(testDir, "subdir"));

		const result = await handleCodingTool("ls", {
			path: testDir,
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("a.txt");
		expect(result.output).toContain("b.txt");
		expect(result.output).toContain("subdir/");
	});

	it("lists current directory by default", async () => {
		writeFileSync(path.join(testDir, "file.txt"), "");

		const result = await handleCodingTool("ls", {
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("file.txt");
	});

	it("returns error for non-existent path", async () => {
		const result = await handleCodingTool("ls", {
			path: path.join(testDir, "nonexistent"),
			working_directory: testDir,
		});
		expect(result.success).toBe(false);
	});
});

describe("grep tool", () => {
	it("finds pattern in files", async () => {
		writeFileSync(path.join(testDir, "search.txt"), "hello world\nfoo bar\nhello again\n");

		const result = await handleCodingTool("grep", {
			pattern: "hello",
			path: testDir,
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("hello world");
		expect(result.output).toContain("hello again");
	});

	it("supports case-insensitive search", async () => {
		writeFileSync(path.join(testDir, "case.txt"), "Hello World\nhello world\n");

		const result = await handleCodingTool("grep", {
			pattern: "HELLO",
			path: testDir,
			ignoreCase: true,
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("Hello World");
		expect(result.output).toContain("hello world");
	});

	it("returns no matches message", async () => {
		writeFileSync(path.join(testDir, "empty.txt"), "nothing here\n");

		const result = await handleCodingTool("grep", {
			pattern: "nonexistent_pattern_xyz",
			path: testDir,
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("No matches found");
	});

	it("filters by glob pattern", async () => {
		writeFileSync(path.join(testDir, "file.ts"), "const x = 1;\n");
		writeFileSync(path.join(testDir, "file.js"), "const x = 2;\n");

		const result = await handleCodingTool("grep", {
			pattern: "const",
			path: testDir,
			glob: "*.ts",
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("file.ts");
		expect(result.output).not.toContain("file.js");
	});
});

describe("find tool", () => {
	it("finds files by glob pattern", async () => {
		writeFileSync(path.join(testDir, "a.ts"), "");
		writeFileSync(path.join(testDir, "b.ts"), "");
		writeFileSync(path.join(testDir, "c.js"), "");

		const result = await handleCodingTool("find", {
			pattern: "*.ts",
			path: testDir,
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("a.ts");
		expect(result.output).toContain("b.ts");
		expect(result.output).not.toContain("c.js");
	});

	it("returns no files message when no matches", async () => {
		const result = await handleCodingTool("find", {
			pattern: "*.xyz",
			path: testDir,
			working_directory: testDir,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("No files found");
	});
});
