import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CODING_DEFAULTS } from "../src/configs.js";
import {
    CODING_STEP_INTERMEDIATE,
    CODING_STEP_OUTPUT,
    CODING_STEP_PARSED,
    CODING_STEP_SOURCE,
    CodingPipeline,
    codingPipelineFromTaskDir,
    resolveCodingWorkDir,
} from "../src/pipeline.js";
import { buildCodingWorkflowPrompt, CODING_WORKFLOW_PROMPT } from "../src/prompt.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "coding-pipeline-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("coding pipeline", () => {
	it("creates step directories and stores meta", async () => {
		const workDir = makeTempDir();
		const pipeline = new CodingPipeline({
			sessionId: "s",
			taskType: "coding",
			taskId: "t",
			workDir,
		});

		await pipeline.ensureStepDirs();
		expect(existsSync(pipeline.stepPath(CODING_STEP_SOURCE))).toBe(true);
		expect(existsSync(pipeline.stepPath(CODING_STEP_PARSED))).toBe(true);
		expect(existsSync(pipeline.stepPath(CODING_STEP_INTERMEDIATE))).toBe(true);
		expect(existsSync(pipeline.stepPath(CODING_STEP_OUTPUT))).toBe(true);

		await pipeline.setMeta({ a: 1 });
		await pipeline.setMeta({ b: 2 });
		const meta = await pipeline.getMeta();
		expect(meta).toMatchObject({ a: 1, b: 2 });
	});

	it("reconstructs pipeline from task_dir", async () => {
		const workDir = makeTempDir();
		const pipeline = new CodingPipeline({
			sessionId: "session-x",
			taskType: "coding",
			taskId: "task-y",
			workDir,
		});
		const cloned = codingPipelineFromTaskDir(pipeline.taskDir);
		expect(cloned.taskDir).toBe(pipeline.taskDir);
	});

	it("resolves default cache dir with configured cache name", () => {
		const resolved = resolveCodingWorkDir();
		expect(resolved).toContain(CODING_DEFAULTS.runtime.cacheDirName);
	});
});

describe("coding prompt", () => {
	it("includes fixed direct tool names and default workflow guidance", () => {
		expect(CODING_WORKFLOW_PROMPT).toContain("read, edit, write, grep, find, ls");
		expect(CODING_WORKFLOW_PROMPT).toContain('<section name="recommended_order">');
	});

	it("supports custom objective", () => {
		const prompt = buildCodingWorkflowPrompt({ objective: "Refactor safely" });
		expect(prompt).toContain("Refactor safely");
		expect(prompt).toContain("Use existing tool names exactly as-is");
	});

	it("is deterministic for default options", () => {
		const p1 = buildCodingWorkflowPrompt();
		const p2 = buildCodingWorkflowPrompt();
		expect(p1).toBe(p2);
	});
});
