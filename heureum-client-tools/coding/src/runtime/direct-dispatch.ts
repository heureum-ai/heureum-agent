import { createEditTool } from "../edit.js";
import { createFindTool } from "../find.js";
import { createGrepTool } from "../grep.js";
import { createLsTool } from "../ls.js";
import { assertPathWithinWorkspace } from "../path-utils.js";
import { createReadTool } from "../read.js";
import type { CodingTool, ToolExecuteResult, ToolResult } from "../types.js";
import { createWriteTool } from "../write.js";

export const DIRECT_TOOL_NAMES = ["read", "edit", "write", "grep", "find", "ls"] as const;
export type DirectToolName = typeof DIRECT_TOOL_NAMES[number];

type ToolFactory = () => CodingTool;

const DIRECT_TOOL_NAME_SET = new Set<string>(DIRECT_TOOL_NAMES);
const WORKSPACE_GUARD_TOOL_SET = new Set<DirectToolName>(["read", "edit", "write", "grep", "find", "ls"]);

export function isDirectToolName(name: string): name is DirectToolName {
	return DIRECT_TOOL_NAME_SET.has(name);
}

function buildToolFactories(cwd: string): Record<DirectToolName, ToolFactory> {
	return {
		read: () => createReadTool(cwd),
		edit: () => createEditTool(cwd),
		write: () => createWriteTool(cwd),
		grep: () => createGrepTool(cwd),
		find: () => createFindTool(cwd),
		ls: () => createLsTool(cwd),
	};
}

function normalizeResult(result: ToolExecuteResult): ToolResult {
	const textParts: string[] = [];
	const images: Array<{ data: string; mimeType: string }> = [];

	for (const item of result.content) {
		if (item.type === "text" && "text" in item) {
			textParts.push(item.text);
		} else if (item.type === "image" && "data" in item) {
			images.push({ data: item.data, mimeType: item.mimeType });
		}
	}

	const output = textParts.join("\n");
	return images.length > 0 ? { success: true, output, images } : { success: true, output };
}

function readPathArg(args: Record<string, unknown>): string | null {
	const pathValue = args.path;
	if (typeof pathValue !== "string") {
		return null;
	}
	const trimmed = pathValue.trim();
	return trimmed.length > 0 ? trimmed : null;
}

async function assertToolWorkspaceGuard(
	toolName: DirectToolName,
	args: Record<string, unknown>,
	cwd: string,
): Promise<void> {
	// Direct coding tools expose path-like access through the "path" argument.
	// Enforce workspace containment before dispatching to concrete tool handlers.
	if (!WORKSPACE_GUARD_TOOL_SET.has(toolName)) {
		return;
	}

	const targetPath = readPathArg(args);
	if (!targetPath) {
		return;
	}

	await assertPathWithinWorkspace(targetPath, cwd, cwd);
}

export async function runDirectTool(
	toolName: DirectToolName,
	args: Record<string, unknown>,
	cwd: string,
): Promise<ToolResult> {
	const factories = buildToolFactories(cwd);
	const tool = factories[toolName]();
	try {
		await assertToolWorkspaceGuard(toolName, args, cwd);
		const result = await tool.execute("", args);
		return normalizeResult(result);
	} catch (err: any) {
		return { success: false, output: err?.message || String(err) };
	}
}
