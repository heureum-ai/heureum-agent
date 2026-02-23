import { CODING_TOOLS, handleCodingTool, type CodingToolDefinition } from "./tool-schema.js";
import type { ToolResult } from "./types.js";

export interface CodingToolset {
	tools: CodingToolDefinition[];
	toolNames: Set<string>;
	execute: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

export function createCodingToolset(): CodingToolset {
	const tools = CODING_TOOLS.map((tool) => ({ ...tool }));
	const toolNames = new Set(tools.map((tool) => tool.name));
	return {
		tools,
		toolNames,
		execute: (toolName, args) => handleCodingTool(toolName, args),
	};
}

export const codingToolset = createCodingToolset();
