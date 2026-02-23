/**
 * Coding ToolDefinition + handler for LLM tool binding.
 * Includes direct coding tools (read/edit/write/grep/find/ls).
 *
 * working_directory is injected by the frontend at call time,
 * not specified by the LLM. It is hidden from the tool schema.
 */

import {
	CODING_EDIT_TOOL,
	CODING_FIND_TOOL,
	CODING_GREP_TOOL,
	CODING_LS_TOOL,
	CODING_READ_TOOL,
	CODING_WRITE_TOOL,
	handleCodingTool as handleCodingToolImpl,
} from "./tools.js";

interface ToolDefinition {
	type: "function";
	name: string;
	display_name: string;
	description?: string;
	parameters?: Record<string, any>;
	guide?: string;
}

export type CodingToolDefinition = ToolDefinition;

const READ: ToolDefinition = {
	type: "function",
	name: CODING_READ_TOOL,
	display_name: "Read",
	description:
		"Read the contents of a file on the user's local machine. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
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
	name: CODING_EDIT_TOOL,
	display_name: "Edit",
	description:
		"Edit a file on the user's local machine by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
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
	name: CODING_WRITE_TOOL,
	display_name: "Write",
	description:
		"Write content to a file on the user's local machine. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
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
	name: CODING_GREP_TOOL,
	display_name: "Grep",
	description:
		"Search file contents on the user's local machine for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
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
	name: CODING_FIND_TOOL,
	display_name: "Find",
	description:
		"Search for files on the user's local machine by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
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
	name: CODING_LS_TOOL,
	display_name: "List Files",
	description:
		"List directory contents on the user's local machine. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory to list (default: current directory)" },
			limit: { type: "number", description: "Maximum number of entries to return (default: 500)" },
		},
	},
};

export const CODING_TOOLS: CodingToolDefinition[] = [
	READ,
	EDIT,
	WRITE,
	GREP,
	FIND,
	LS,
];

export const handleCodingTool = handleCodingToolImpl;
