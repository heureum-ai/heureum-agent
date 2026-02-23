import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingTool } from "../src/tool-schema.js";

describe("edit tool", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(path.join(tmpdir(), "coding-test-edit-"));
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

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
