import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingTool } from "../src/tool-schema.js";

describe("write tool", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(path.join(tmpdir(), "coding-test-write-"));
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

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
