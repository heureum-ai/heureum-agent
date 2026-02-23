import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingTool } from "../src/tool-schema.js";

describe("find tool", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(path.join(tmpdir(), "coding-test-find-"));
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

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
