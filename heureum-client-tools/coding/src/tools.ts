import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "node:url";
import { BASH_EXEC_TOOL, BASH_PROCESS_TOOL, handleBashTool } from "@heureum/bash";
import { assertPathWithinWorkspace } from "./path-utils.js";
import { isDirectToolName as isRunnerDirectToolName, runDirectTool } from "./runtime/direct-dispatch.js";
import type { ToolResult } from "./types.js";

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.promises.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

export const CODING_READ_TOOL = "read" as const;
export const CODING_EDIT_TOOL = "edit" as const;
export const CODING_WRITE_TOOL = "write" as const;
export const CODING_GREP_TOOL = "grep" as const;
export const CODING_FIND_TOOL = "find" as const;
export const CODING_LS_TOOL = "ls" as const;

const RUNTIME_EXEC_TOOL = BASH_EXEC_TOOL;
const RUNTIME_PROCESS_TOOL = BASH_PROCESS_TOOL;

type DirectCodingToolName =
	| typeof CODING_READ_TOOL
	| typeof CODING_EDIT_TOOL
	| typeof CODING_WRITE_TOOL
	| typeof CODING_GREP_TOOL
	| typeof CODING_FIND_TOOL
	| typeof CODING_LS_TOOL;

export type CodingToolName = DirectCodingToolName;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_DIR = path.resolve(MODULE_DIR, "..");
const DIRECT_RUNNER_RELATIVE_CANDIDATES = [
	// tsup output candidate when nested source entry names are preserved.
	"dist/runtime/direct-runner.js",
	// tsup output candidate when source entry is flattened by basename.
	"dist/direct-runner.js",
] as const;
const RUNTIME_POLL_TIMEOUT_MS = 1000;
const DEFAULT_RUNTIME_TIMEOUT_SEC = 1800;
const MAX_RUNTIME_POLL_ATTEMPTS_CAP = 7200;

let cachedDirectRunnerPath: string | null = null;
let cachedDirectRunnerFileBridgeSupport:
	| {
		path: string;
		supported: boolean;
	}
	| null = null;

const DIRECT_TOOL_NAMES: CodingToolName[] = [
	CODING_READ_TOOL,
	CODING_EDIT_TOOL,
	CODING_WRITE_TOOL,
	CODING_GREP_TOOL,
	CODING_FIND_TOOL,
	CODING_LS_TOOL,
];

const DIRECT_TOOL_NAME_SET = new Set<string>(DIRECT_TOOL_NAMES);

function isDirectCodingToolName(name: string): name is CodingToolName {
	return DIRECT_TOOL_NAME_SET.has(name);
}

function quoteForBash(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

async function resolveDirectRunnerPath(): Promise<string | null> {
	if (cachedDirectRunnerPath && (await pathExists(cachedDirectRunnerPath))) {
		return cachedDirectRunnerPath;
	}

	for (const relativePath of DIRECT_RUNNER_RELATIVE_CANDIDATES) {
		const candidatePath = path.resolve(PACKAGE_ROOT_DIR, relativePath);
		if (await pathExists(candidatePath)) {
			cachedDirectRunnerPath = candidatePath;
			return candidatePath;
		}
	}

	return null;
}

async function supportsDirectRunnerFileBridge(directRunnerPath: string): Promise<boolean> {
	if (
		cachedDirectRunnerFileBridgeSupport
		&& cachedDirectRunnerFileBridgeSupport.path === directRunnerPath
	) {
		return cachedDirectRunnerFileBridgeSupport.supported;
	}

	try {
		const source = await fs.promises.readFile(directRunnerPath, "utf-8");
		const supported = source.includes("--payload-file") && source.includes("--result-file");
		cachedDirectRunnerFileBridgeSupport = {
			path: directRunnerPath,
			supported,
		};
		return supported;
	} catch {
		return false;
	}
}

async function cleanupRuntimeSession(sessionId: string): Promise<void> {
	await handleBashTool(RUNTIME_PROCESS_TOOL, { action: "remove", sessionId }).catch(() => undefined);
}

function resolveRuntimePollAttempts(timeoutSec: number): number {
	const effectiveTimeoutMs = Math.max(1000, Math.floor(timeoutSec * 1000));
	const attempts = Math.ceil((effectiveTimeoutMs + RUNTIME_POLL_TIMEOUT_MS) / RUNTIME_POLL_TIMEOUT_MS);
	return Math.max(1, Math.min(attempts, MAX_RUNTIME_POLL_ATTEMPTS_CAP));
}

async function runCommandViaBashRuntime(
	command: string,
	cwd: string,
	timeoutSec: number = DEFAULT_RUNTIME_TIMEOUT_SEC,
): Promise<ToolResult> {
	const effectiveTimeoutSec =
		Number.isFinite(timeoutSec) && timeoutSec > 0
			? Math.floor(timeoutSec)
			: DEFAULT_RUNTIME_TIMEOUT_SEC;
	const maxRuntimePollAttempts = resolveRuntimePollAttempts(effectiveTimeoutSec);

	const started = await handleBashTool(RUNTIME_EXEC_TOOL, {
		command,
		workdir: cwd,
		background: true,
		pty: false,
		timeout: effectiveTimeoutSec,
	});

	if (!started.success) {
		return started;
	}

	const startedPayload = parseJsonObject(started.output);
	const sessionId = typeof startedPayload?.sessionId === "string" ? startedPayload.sessionId : null;
	if (!sessionId) {
		return { success: false, output: `Invalid exec response: ${started.output}` };
	}

	for (let i = 0; i < maxRuntimePollAttempts; i++) {
		const polled = await handleBashTool(RUNTIME_PROCESS_TOOL, {
			action: "poll",
			sessionId,
			timeout: RUNTIME_POLL_TIMEOUT_MS,
		});

		if (!polled.success) {
			await cleanupRuntimeSession(sessionId);
			return polled;
		}

		const payload = parseJsonObject(polled.output);
		if (!payload) {
			await cleanupRuntimeSession(sessionId);
			return { success: false, output: `Invalid process response: ${polled.output}` };
		}

		const status = String(payload.status ?? "");
		if (status === "running") {
			continue;
		}

		const output = typeof payload.output === "string" ? payload.output : "";
		if (status === "completed") {
			await cleanupRuntimeSession(sessionId);
			return { success: true, output };
		}

		const reason = typeof payload.reason === "string" ? payload.reason : "";
		await cleanupRuntimeSession(sessionId);
		return { success: false, output: output || reason || polled.output };
	}

	await cleanupRuntimeSession(sessionId);
	return {
		success: false,
		output:
			`Timed out waiting for runtime session completion after ${effectiveTimeoutSec}s: `
			+ `${sessionId}`,
	};
}

function parseRunnerPayload(output: string): Record<string, unknown> | null {
	const parsed = parseJsonObject(output);
	if (parsed) {
		return parsed;
	}

	// Fallback: if transport output includes non-JSON noise, parse the last JSON object line.
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const lineParsed = parseJsonObject(lines[i]);
		if (lineParsed) {
			return lineParsed;
		}
	}
	return null;
}

function parseRunnerResult(output: string): ToolResult {
	const parsed = parseRunnerPayload(output);
	if (!parsed) {
		return { success: false, output: `Invalid direct runner output: ${output}` };
	}

	const success = parsed.success === true;
	const message = typeof parsed.output === "string" ? parsed.output : output;
	const outputPath = typeof parsed.outputPath === "string" ? parsed.outputPath : undefined;
	const images = Array.isArray(parsed.images)
		? parsed.images
			.filter((item): item is { data: string; mimeType: string } => (
				typeof item === "object"
				&& item !== null
				&& typeof (item as { data?: unknown }).data === "string"
				&& typeof (item as { mimeType?: unknown }).mimeType === "string"
			))
			.map((item) => ({ data: item.data, mimeType: item.mimeType }))
		: undefined;

	if (!success) {
		return outputPath ? { success: false, output: message, outputPath } : { success: false, output: message };
	}

	if (images && images.length > 0) {
		return outputPath
			? { success: true, output: message, outputPath, images }
			: { success: true, output: message, images };
	}
	return outputPath ? { success: true, output: message, outputPath } : { success: true, output: message };
}

type DirectRunnerBridgePaths = {
	tempDir: string;
	payloadPath: string;
	resultPath: string;
};

async function createDirectRunnerBridgePaths(payload: Record<string, unknown>): Promise<DirectRunnerBridgePaths> {
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "heureum-coding-runner-"));
	const payloadPath = path.join(tempDir, "payload.json");
	const resultPath = path.join(tempDir, "result.json");
	await fs.promises.writeFile(payloadPath, JSON.stringify(payload), "utf-8");
	return { tempDir, payloadPath, resultPath };
}

async function readDirectRunnerResult(resultPath: string): Promise<ToolResult | null> {
	if (!(await pathExists(resultPath))) {
		return null;
	}
	const rawResult = await fs.promises.readFile(resultPath, "utf-8");
	if (!rawResult.trim()) {
		return null;
	}
	return parseRunnerResult(rawResult);
}

async function cleanupDirectRunnerBridge(tempDir: string): Promise<void> {
	await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
}

async function executeDirectCodingToolLegacy(
	directRunnerPath: string,
	payload: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	const encodedPayload = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
	const command = `node ${quoteForBash(directRunnerPath)} ${quoteForBash(encodedPayload)}`;
	const runtimeResult = await runCommandViaBashRuntime(command, cwd, DEFAULT_RUNTIME_TIMEOUT_SEC);
	if (!runtimeResult.success) {
		return runtimeResult;
	}
	return parseRunnerResult(runtimeResult.output);
}

async function executeDirectCodingToolInProcess(
	toolName: CodingToolName,
	args: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	if (!isRunnerDirectToolName(toolName)) {
		return { success: false, output: `Unsupported direct tool for in-process dispatch: ${toolName}` };
	}
	return runDirectTool(toolName, args, cwd);
}

async function assertDirectToolWorkspaceGuard(
	toolName: CodingToolName,
	args: Record<string, unknown>,
	cwd: string,
): Promise<void> {
	const pathArg = args.path;
	if (typeof pathArg !== "string" || pathArg.trim().length === 0) {
		return;
	}

	// Apply workspace root guard before runner dispatch so stale dist artifacts cannot bypass it.
	if (DIRECT_TOOL_NAME_SET.has(toolName)) {
		await assertPathWithinWorkspace(pathArg, cwd, cwd);
	}
}

async function executeDirectCodingTool(
	toolName: CodingToolName,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const cwd = (args.working_directory as string) || process.cwd();
	try {
		await assertDirectToolWorkspaceGuard(toolName, args, cwd);
	} catch (error: any) {
		return { success: false, output: error?.message || String(error) };
	}
	const directRunnerPath = await resolveDirectRunnerPath();
	if (!directRunnerPath) {
		return executeDirectCodingToolInProcess(toolName, args, cwd);
	}

	const payload = { toolName, args, cwd };
	const supportsFileBridge = await supportsDirectRunnerFileBridge(directRunnerPath);
	if (!supportsFileBridge) {
		return executeDirectCodingToolLegacy(directRunnerPath, payload, cwd);
	}

	const bridgePaths = await createDirectRunnerBridgePaths(payload);

	try {
		const command =
			`node ${quoteForBash(directRunnerPath)} `
			+ `--payload-file ${quoteForBash(bridgePaths.payloadPath)} `
			+ `--result-file ${quoteForBash(bridgePaths.resultPath)}`;
		const runtimeResult = await runCommandViaBashRuntime(command, cwd, DEFAULT_RUNTIME_TIMEOUT_SEC);
		const resultFromFile = await readDirectRunnerResult(bridgePaths.resultPath);
		if (resultFromFile) {
			return resultFromFile;
		}
		if (!runtimeResult.success) {
			return runtimeResult;
		}
		return parseRunnerResult(runtimeResult.output);
	} finally {
		await cleanupDirectRunnerBridge(bridgePaths.tempDir);
	}
}

export async function handleCodingTool(
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	if (isDirectCodingToolName(toolName)) {
		return executeDirectCodingTool(toolName, args);
	}
	return { success: false, output: `Unknown coding tool: ${toolName}` };
}

export type { CodingToolResult, ToolResult } from "./types.js";
