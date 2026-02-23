import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingTool } from "../src/tool-schema.js";

describe("read tool", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(path.join(tmpdir(), "coding-test-read-"));
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

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
