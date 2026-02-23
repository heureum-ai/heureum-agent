import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCodingTool } from "../src/tool-schema.js";

describe("Performance and Non-blocking Tests", () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(path.join(tmpdir(), "coding-perf-test-"));
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("should NOT block the event loop when running find", async () => {
        // Create some files to find
        for (let i = 0; i < 10; i++) {
            writeFileSync(path.join(testDir, `file${i}.txt`), "content");
        }

        let ticks = 0;
        const interval = setInterval(() => {
            ticks++;
        }, 1);

        const startTime = Date.now();
        const result = await handleCodingTool("find", {
            pattern: "*.txt",
            path: testDir,
            working_directory: testDir
        });
        const duration = Date.now() - startTime;

        clearInterval(interval);

        expect(result.success).toBe(true);
        // If it was blocking, ticks would be 0 or very close to it.
        // Even for a fast operation, we expect at least some ticks if it's truly async.
        // For 'fd' execution which is very fast, we might need a longer operation to be sure,
        // but since we switched spawnSync to spawn, it's architecturally non-blocking.
        console.log(`Find duration: ${duration}ms, Event loop ticks: ${ticks}`);
        expect(ticks).toBeGreaterThan(0);
    });

    it("should NOT block the event loop when running grep", async () => {
        for (let i = 0; i < 200; i++) {
            writeFileSync(path.join(testDir, `grep-${i}.txt`), `line-${i}\nneedle\nline-${i}`);
        }

        let ticks = 0;
        const interval = setInterval(() => {
            ticks++;
        }, 10);

        const startTime = Date.now();
        const result = await handleCodingTool("grep", {
            pattern: "needle",
            path: testDir,
            working_directory: testDir,
        });
        const duration = Date.now() - startTime;

        clearInterval(interval);

        expect(result.success).toBe(true);
        console.log(`Grep duration: ${duration}ms, Event loop ticks: ${ticks}`);
        expect(ticks).toBeGreaterThan(0);
    });

    it("should support parallel execution of multiple tool calls", async () => {
        for (let i = 0; i < 200; i++) {
            writeFileSync(path.join(testDir, `parallel-${i}.txt`), `parallel-${i}`);
        }

        const startTime = Date.now();

        // Run 3 independent find calls in parallel
        const promises = [
            handleCodingTool("find", { pattern: "*.txt", path: testDir, working_directory: testDir }),
            handleCodingTool("find", { pattern: "*.txt", path: testDir, working_directory: testDir }),
            handleCodingTool("find", { pattern: "*.txt", path: testDir, working_directory: testDir }),
        ];

        const results = await Promise.all(promises);
        const totalDuration = Date.now() - startTime;

        results.forEach(r => expect(r.success).toBe(true));

        console.log(`Parallel find (3x) total duration: ${totalDuration}ms`);
        expect(totalDuration).toBeLessThan(1200);
    });
});
