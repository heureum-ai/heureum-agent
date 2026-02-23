import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingTool } from "../src/tool-schema.js";

describe("ls tool", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(path.join(tmpdir(), "coding-test-ls-"));
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

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

    it("identifies directories with trailing slashes", async () => {
        mkdirSync(path.join(testDir, "dir1"));
        mkdirSync(path.join(testDir, "dir2"));
        writeFileSync(path.join(testDir, "file.txt"), "");

        const result = await handleCodingTool("ls", {
            path: testDir,
            working_directory: testDir,
        });
        expect(result.success).toBe(true);
        expect(result.output).toContain("dir1/");
        expect(result.output).toContain("dir2/");
        expect(result.output).toContain("file.txt");
        expect(result.output).not.toContain("file.txt/");
    });
});
