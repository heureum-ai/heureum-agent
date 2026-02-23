import { BASH_EXEC_TOOL, BASH_PROCESS_TOOL, handleBashTool as handleBashToolImpl } from "./tools.js";

interface ToolDefinition {
	type: "function";
	name: string;
	display_name: string;
	description?: string;
	parameters?: Record<string, any>;
	guide?: string;
}

const EXEC: ToolDefinition = {
	type: "function",
	name: BASH_EXEC_TOOL,
	display_name: "Bash",
	description:
		"Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. pty is reserved and currently unsupported.",
	guide:
		'<tool_guide name="bash">\n'
		+ "Tool names are case-sensitive. Call tools exactly as listed.\n"
		+ "- exec: run shell commands (supports background via yieldMs/background).\n"
		+ "- process: manage background exec sessions.\n"
		+ "For long waits, avoid rapid poll loops: use exec with enough yieldMs or process(action=poll, timeout=<ms>).\n"
		+ "Use process(list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for lifecycle control.\n"
		+ "</tool_guide>",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to execute" },
			workdir: { type: "string", description: "Working directory (optional, defaults to current workspace)" },
			env: { type: "object", description: "Environment variables to set/override for this command" },
			yieldMs: {
				type: "number",
				description: "Milliseconds to wait before returning running status (default: 10000)",
			},
			background: { type: "boolean", description: "Return immediately with running session status" },
				timeout: { type: "number", description: "Timeout in seconds before process is terminated" },
				pty: {
					type: "boolean",
					description: "Reserved for future PTY support (currently unsupported)",
				},
				host: {
					type: "string",
					enum: ["sandbox", "gateway", "node"],
					description: "Execution host override (must match configured host)",
				},
				security: {
					type: "string",
					enum: ["deny", "allowlist", "full"],
					description: "Execution security mode",
				},
				ask: {
					type: "string",
					enum: ["off", "on-miss", "always"],
					description: "Approval mode when command is not directly allowed",
				},
				safeBins: {
					type: "array",
					items: { type: "string" },
					description: "Optional command allowlist (used with security=allowlist)",
				},
				scopeKey: {
					type: "string",
					description: "Optional session scope key for process isolation",
				},
			},
			required: ["command"],
		},
	};

const PROCESS: ToolDefinition = {
	type: "function",
	name: BASH_PROCESS_TOOL,
	display_name: "Process",
	description:
		"Manage running exec sessions: list, poll, log, write, send-keys, submit, paste, kill, clear, remove.",
	parameters: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: [
					"list",
					"poll",
					"log",
					"write",
					"send-keys",
					"submit",
					"paste",
					"kill",
					"clear",
					"remove",
				],
				description: "Process action",
			},
			sessionId: { type: "string", description: "Session id (required for non-list actions)" },
			data: { type: "string", description: "Input payload for write action" },
			keys: { type: "array", items: { type: "string" }, description: "Key tokens for send-keys" },
			hex: {
				type: "array",
				items: { type: "string" },
				description: "Hex byte tokens for send-keys",
			},
			literal: { type: "string", description: "Literal text for send-keys" },
			text: { type: "string", description: "Text payload for paste" },
			bracketed: { type: "boolean", description: "Wrap paste with bracketed sequence" },
			eof: { type: "boolean", description: "Close stdin after write" },
			offset: { type: "number", description: "Log offset line index" },
			limit: { type: "number", description: "Log line count limit" },
				timeout: { type: "number", description: "Poll wait timeout in milliseconds" },
				scopeKey: { type: "string", description: "Optional session scope key for process isolation" },
			},
			required: ["action"],
		},
	};

export const BASH_TOOLS: ToolDefinition[] = [EXEC, PROCESS];
export const handleBashTool = handleBashToolImpl;
