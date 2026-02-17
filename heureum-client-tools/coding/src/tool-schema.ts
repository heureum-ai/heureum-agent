/**
 * Coding ToolDefinition + handler for LLM tool binding.
 * 7 tools: bash, read, edit, write, grep, find, ls.
 *
 * working_directory is injected by the frontend at call time,
 * not specified by the LLM. It is hidden from the tool schema.
 */

import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import type { ToolResult } from "./types.js";
import { createWriteTool } from "./write.js";

interface ToolDefinition {
	type: "function";
	name: string;
	description?: string;
	parameters?: Record<string, any>;
	guide?: string;
}

const BASH: ToolDefinition = {
	type: "function",
	name: "bash",
	description:
		"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
	guide:
		'<tool_guide name="coding">\n'
		+ "Prefer grep/find/ls over bash for file exploration (faster, respects .gitignore).\n"
		+ "Use read to examine files before editing.\n"
		+ "Use edit for precise changes (old text must match exactly).\n"
		+ "Use write only for new files or complete rewrites.\n"
		+ "</tool_guide>",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Bash command to execute" },
			timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
		},
		required: ["command"],
	},
};

const READ: ToolDefinition = {
	type: "function",
	name: "read",
	description:
		"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to read (relative or absolute)" },
			offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
			limit: { type: "number", description: "Maximum number of lines to read" },
		},
		required: ["path"],
	},
};

const EDIT: ToolDefinition = {
	type: "function",
	name: "edit",
	description:
		"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
			oldText: { type: "string", description: "Exact text to find and replace (must match exactly)" },
			newText: { type: "string", description: "New text to replace the old text with" },
		},
		required: ["path", "oldText", "newText"],
	},
};

const WRITE: ToolDefinition = {
	type: "function",
	name: "write",
	description:
		"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to write (relative or absolute)" },
			content: { type: "string", description: "Content to write to the file" },
		},
		required: ["path", "content"],
	},
};

const GREP: ToolDefinition = {
	type: "function",
	name: "grep",
	description:
		"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Search pattern (regex or literal string)" },
			path: { type: "string", description: "Directory or file to search (default: current directory)" },
			glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
			ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
			literal: {
				type: "boolean",
				description: "Treat pattern as literal string instead of regex (default: false)",
			},
			context: {
				type: "number",
				description: "Number of lines to show before and after each match (default: 0)",
			},
			limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
		},
		required: ["pattern"],
	},
};

const FIND: ToolDefinition = {
	type: "function",
	name: "find",
	description:
		"Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
	parameters: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
			},
			path: { type: "string", description: "Directory to search in (default: current directory)" },
			limit: { type: "number", description: "Maximum number of results (default: 1000)" },
		},
		required: ["pattern"],
	},
};

const LS: ToolDefinition = {
	type: "function",
	name: "ls",
	description:
		"List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory to list (default: current directory)" },
			limit: { type: "number", description: "Maximum number of entries to return (default: 500)" },
		},
	},
};

export const CODING_TOOLS: ToolDefinition[] = [BASH, READ, EDIT, WRITE, GREP, FIND, LS];

export async function handleCodingTool(
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	const cwd = (args.working_directory as string) || process.cwd();

	const toolFactories: Record<string, () => ReturnType<typeof createBashTool>> = {
		bash: () => createBashTool(cwd),
		read: () => createReadTool(cwd),
		edit: () => createEditTool(cwd),
		write: () => createWriteTool(cwd),
		grep: () => createGrepTool(cwd),
		find: () => createFindTool(cwd),
		ls: () => createLsTool(cwd),
	};

	const factory = toolFactories[toolName];
	if (!factory) {
		return { success: false, output: `Unknown coding tool: ${toolName}` };
	}

	const tool = factory();

	try {
		const result = await tool.execute("", args);
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
		return images.length > 0
			? { success: true, output, images }
			: { success: true, output };
	} catch (err: any) {
		return { success: false, output: err.message || String(err) };
	}
}
