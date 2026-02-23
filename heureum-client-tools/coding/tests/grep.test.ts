import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingTool } from "../src/tool-schema.js";

describe("grep tool", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(path.join(tmpdir(), "coding-test-grep-"));
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

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

    it("includes context lines in grep results", async () => {
        writeFileSync(
            path.join(testDir, "context.txt"),
            "line1\nline2\nmatch here\nline4\nline5\n"
        );

        const result = await handleCodingTool("grep", {
            pattern: "match",
            path: testDir,
            context: 1,
            working_directory: testDir,
        });
        expect(result.success).toBe(true);
        expect(result.output).toContain("line2"); // -1 context
        expect(result.output).toContain("match here");
        expect(result.output).toContain("line4"); // +1 context
        expect(result.output).not.toContain("line1");
        expect(result.output).not.toContain("line5");
    });
});
