import * as path from "node:path";
import { type BashTool, type ToolExecuteResult, type ToolResult } from "./types.js";
import {
	clearFinishedSession,
	deleteSession,
	getFinishedSession,
	getRunningSession,
	killSession,
	listFinishedSessions,
	listRunningSessions,
	markBackgrounded,
	setCleanupMs,
	startExecProcess,
	waitForSessionUpdate,
	writeSessionInput,
} from "./runtime.js";

export const BASH_EXEC_TOOL = "exec" as const;
export const BASH_PROCESS_TOOL = "process" as const;

export type BashToolName = typeof BASH_EXEC_TOOL | typeof BASH_PROCESS_TOOL;
export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";

const DEFAULT_MAX_OUTPUT = 200_000;
const DEFAULT_PENDING_MAX_OUTPUT = 30_000;
const DEFAULT_BACKGROUND_MS = 10_000;
const DEFAULT_TIMEOUT_SEC = 1800;
const DEFAULT_CLEANUP_MS = 30 * 60 * 1000;
const DEFAULT_LOG_TAIL_LINES = 200;
const MAX_POLL_WAIT_MS = 120_000;
const DEFAULT_SAFE_BINS = [
	"bash",
	"sh",
	"zsh",
	"node",
	"npm",
	"pnpm",
	"npx",
	"python",
	"python3",
	"pip",
	"pip3",
	"git",
	"rg",
	"fd",
	"ls",
	"cat",
	"echo",
	"sed",
	"awk",
	"grep",
	"find",
	"cp",
	"mv",
	"mkdir",
	"touch",
	"tsc",
] as const;

setCleanupMs(DEFAULT_CLEANUP_MS);

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function normalizeHost(value: unknown): ExecHost | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return normalized === "sandbox" || normalized === "gateway" || normalized === "node"
		? normalized
		: null;
}

function normalizeSecurity(value: unknown): ExecSecurity | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return normalized === "deny" || normalized === "allowlist" || normalized === "full"
		? normalized
		: null;
}

function normalizeAsk(value: unknown): ExecAsk | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return normalized === "off" || normalized === "on-miss" || normalized === "always"
		? normalized
		: null;
}

function securityRank(value: ExecSecurity): number {
	if (value === "deny") return 0;
	if (value === "allowlist") return 1;
	return 2;
}

function minSecurity(left: ExecSecurity, right: ExecSecurity): ExecSecurity {
	return securityRank(left) <= securityRank(right) ? left : right;
}

function askRank(value: ExecAsk): number {
	if (value === "off") return 0;
	if (value === "on-miss") return 1;
	return 2;
}

function maxAsk(left: ExecAsk, right: ExecAsk): ExecAsk {
	return askRank(left) >= askRank(right) ? left : right;
}

function normalizeBinToken(value: string): string {
	return path.basename(value.trim().toLowerCase()).replace(/\.exe$/, "");
}

function parseCommandHead(command: string): string | null {
	const trimmed = command.trim();
	if (!trimmed) return null;
	if (/^[`$({]/.test(trimmed)) return null;
	let token = "";
	let quote: "'" | "\"" | null = null;
	for (let i = 0; i < trimmed.length; i += 1) {
		const ch = trimmed[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
				continue;
			}
			token += ch;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			if (token.length === 0) {
				quote = ch;
				continue;
			}
			break;
		}
		if (/\s/.test(ch) || ch === "|" || ch === ";" || ch === "&" || ch === "<" || ch === ">") {
			break;
		}
		token += ch;
	}
	return token.trim() ? token.trim() : null;
}

function resolveCommandBin(command: string): string | null {
	const head = parseCommandHead(command);
	if (!head) return null;
	return normalizeBinToken(head);
}

function splitTopLevelCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let segmentStart = 0;
	let quote: "'" | "\"" | null = null;
	let escaped = false;

	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (ch === quote) {
				quote = null;
			}
			continue;
		}

		if (ch === "'" || ch === "\"") {
			quote = ch;
			continue;
		}

		if (ch === ";" || ch === "\n") {
			segments.push(command.slice(segmentStart, i));
			segmentStart = i + 1;
			continue;
		}

		if (ch === "&") {
			segments.push(command.slice(segmentStart, i));
			if (command[i + 1] === "&") {
				i += 1;
			}
			segmentStart = i + 1;
			continue;
		}

		if (ch === "|") {
			segments.push(command.slice(segmentStart, i));
			if (command[i + 1] === "|") {
				i += 1;
			}
			segmentStart = i + 1;
		}
	}

	segments.push(command.slice(segmentStart));
	return segments
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

function resolveCommandBins(command: string): string[] {
	const bins: string[] = [];
	for (const segment of splitTopLevelCommandSegments(command)) {
		const bin = resolveCommandBin(segment);
		if (!bin) {
			continue;
		}
		bins.push(bin);
	}
	return bins;
}

function resolveSafeBinSet(args: Record<string, unknown>, defaults?: readonly string[]): Set<string> {
	const configured =
		Array.isArray(defaults) && defaults.length > 0
			? defaults
			: Array.isArray(args.safeBins) && args.safeBins.length > 0
				? (args.safeBins as string[])
				: DEFAULT_SAFE_BINS;
	const safeBinValues: string[] = [];
	for (const value of configured) {
		if (typeof value === "string" && value.trim().length > 0) {
			safeBinValues.push(value);
		}
	}
	if (safeBinValues.length === 0) {
		for (const value of DEFAULT_SAFE_BINS) {
			safeBinValues.push(value);
		}
	}
	return new Set(
		safeBinValues
			.map((value) => normalizeBinToken(value))
			.filter((value) => value.length > 0),
	);
}

function resolveScopeKey(args: Record<string, unknown>, defaults?: string): string | undefined {
	const value = typeof args.scopeKey === "string" ? args.scopeKey : defaults;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isInScope(session: { scopeKey?: string } | undefined, scopeKey?: string): boolean {
	if (!scopeKey) return true;
	return session?.scopeKey === scopeKey;
}

function resolveWorkdir(args: Record<string, unknown>): string {
	const base =
		typeof args.working_directory === "string" && args.working_directory.trim().length > 0
			? args.working_directory
			: process.cwd();
	const raw =
		typeof args.workdir === "string" && args.workdir.trim().length > 0
			? args.workdir
			: undefined;
	if (!raw) {
		return base;
	}
	if (path.isAbsolute(raw)) {
		return raw;
	}
	return path.resolve(base, raw);
}

function sliceLogLines(output: string, offset?: number, limit?: number): { lines: string[]; total: number } {
	const lines = output.split(/\r?\n/);
	const total = lines.length;
	const start =
		typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
	const end =
		typeof limit === "number" && Number.isFinite(limit)
			? Math.min(total, start + Math.max(0, Math.floor(limit)))
			: total;
	return { lines: lines.slice(start, end), total };
}

function parsePollTimeout(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return clamp(Math.floor(value), 0, MAX_POLL_WAIT_MS);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed)) {
			return clamp(parsed, 0, MAX_POLL_WAIT_MS);
		}
	}
	return 0;
}

function encodeKeyToken(token: string): string {
	const normalized = token.trim().toLowerCase();
	switch (normalized) {
		case "enter":
		case "return":
			return "\r";
		case "tab":
			return "\t";
		case "esc":
		case "escape":
			return "\u001b";
		case "up":
			return "\u001b[A";
		case "down":
			return "\u001b[B";
		case "right":
			return "\u001b[C";
		case "left":
			return "\u001b[D";
		case "backspace":
			return "\u007f";
		case "ctrl_c":
			return "\u0003";
		case "ctrl_d":
			return "\u0004";
		default:
			return token;
	}
}

function encodeHexBytes(hex?: string[]): string {
	if (!Array.isArray(hex) || hex.length === 0) {
		return "";
	}
	const bytes: number[] = [];
	for (const token of hex) {
		const normalized = token.trim().toLowerCase().replace(/^0x/, "");
		if (!normalized) {
			continue;
		}
		const value = Number.parseInt(normalized, 16);
		if (!Number.isFinite(value) || value < 0 || value > 255) {
			continue;
		}
		bytes.push(value);
	}
	if (bytes.length === 0) {
		return "";
	}
	return Buffer.from(bytes).toString("latin1");
}

function parseText(result: ToolExecuteResult): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function okText(text: string, details?: unknown): ToolExecuteResult {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function toToolResult(result: ToolExecuteResult): ToolResult {
	return {
		success: true,
		output: parseText(result),
	};
}

function fail(output: string): ToolResult {
	return { success: false, output };
}

function sessionSummary(session: {
	id: string;
	status: string;
	command: string;
	scopeKey?: string;
	cwd: string;
	startedAt: number;
	endedAt?: number;
	pid?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | number | null;
	truncated: boolean;
	tail: string;
}): Record<string, unknown> {
	return {
		sessionId: session.id,
		status: session.status,
		command: session.command,
		scopeKey: session.scopeKey,
		cwd: session.cwd,
		pid: session.pid,
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		exitCode: session.exitCode,
		exitSignal: session.exitSignal,
		truncated: session.truncated,
		tail: session.tail,
	};
}

export function createExecTool(defaults?: {
	cwd?: string;
	backgroundMs?: number;
	timeoutSec?: number;
	cleanupMs?: number;
	host?: ExecHost;
	security?: ExecSecurity;
	ask?: ExecAsk;
	safeBins?: string[];
	scopeKey?: string;
}): BashTool {
	if (typeof defaults?.cleanupMs === "number" && defaults.cleanupMs > 0) {
		setCleanupMs(defaults.cleanupMs);
	}

	const defaultBackgroundMs =
		typeof defaults?.backgroundMs === "number" && defaults.backgroundMs >= 0
			? clamp(Math.floor(defaults.backgroundMs), 0, 120_000)
			: DEFAULT_BACKGROUND_MS;
	const defaultTimeoutSec =
		typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
			? Math.floor(defaults.timeoutSec)
			: DEFAULT_TIMEOUT_SEC;

	return {
		name: BASH_EXEC_TOOL,
		label: BASH_EXEC_TOOL,
		description:
			"Execute shell commands with optional background continuation. Use process tool to poll/log/write/kill running sessions.",
			execute: async (_toolCallId, rawArgs) => {
				const args = (rawArgs ?? {}) as Record<string, unknown>;
				const command = typeof args.command === "string" ? args.command.trim() : "";
				if (!command) {
					throw new Error("Provide a command to execute.");
				}
				const configuredHost = defaults?.host ?? "gateway";
				const requestedHost = normalizeHost(args.host);
				if (requestedHost && requestedHost !== configuredHost) {
					throw new Error(
						`exec host not allowed (requested ${requestedHost}; configured host is ${configuredHost}).`,
					);
				}
				const host = requestedHost ?? configuredHost;

				const configuredSecurity = defaults?.security ?? "full";
				const requestedSecurity = normalizeSecurity(args.security);
				const security = requestedSecurity
					? minSecurity(configuredSecurity, requestedSecurity)
					: configuredSecurity;

				const configuredAsk = defaults?.ask ?? "off";
				const requestedAsk = normalizeAsk(args.ask);
				const ask = requestedAsk ? maxAsk(configuredAsk, requestedAsk) : configuredAsk;
				const scopeKey = resolveScopeKey(args, defaults?.scopeKey);
				const safeBins = resolveSafeBinSet(args, defaults?.safeBins);
				const commandBins = resolveCommandBins(command);

				if (security === "deny") {
					throw new Error("exec blocked by security policy (security=deny).");
				}
				if (ask === "always") {
					throw new Error("exec requires approval (ask=always), but approval flow is not available.");
				}
				if (security === "allowlist") {
					if (commandBins.length === 0) {
						throw new Error("Could not resolve command binaries for allowlist validation.");
					}

					const firstDisallowedBin = commandBins.find((bin) => !safeBins.has(bin));
					if (firstDisallowedBin) {
						if (ask === "on-miss") {
							throw new Error(
								`exec approval required for non-allowlisted command (${firstDisallowedBin}), `
								+ "but approval flow is not available.",
							);
						}
						throw new Error(
							`Command "${firstDisallowedBin}" is not in safeBins allowlist (security=allowlist).`,
						);
					}
				}
				if (args.pty === true) {
					throw new Error("pty=true is not supported in this runtime.");
				}

				const workdir =
					typeof defaults?.cwd === "string" && defaults.cwd.trim().length > 0
						? resolveWorkdir({ ...args, working_directory: defaults.cwd })
						: resolveWorkdir(args);

			const env =
				typeof args.env === "object" && args.env !== null
					? (args.env as Record<string, string>)
					: undefined;
			const timeoutSec =
				typeof args.timeout === "number" && Number.isFinite(args.timeout) && args.timeout > 0
					? Math.floor(args.timeout)
					: defaultTimeoutSec;

			const background = args.background === true;
			const yieldMs =
				typeof args.yieldMs === "number" && Number.isFinite(args.yieldMs)
					? clamp(Math.floor(args.yieldMs), 0, 120_000)
					: defaultBackgroundMs;

					const run = await startExecProcess({
						command,
						scopeKey,
						cwd: workdir,
						env,
						pty: false,
						timeoutSec,
					maxOutputChars: DEFAULT_MAX_OUTPUT,
					pendingOutputChars: DEFAULT_PENDING_MAX_OUTPUT,
				});

			const runningPayload = {
				status: "running",
				sessionId: run.session.id,
				pid: run.session.pid,
				startedAt: run.session.startedAt,
					cwd: run.session.cwd,
					tail: run.session.tail,
					warnings: run.warnings,
					host,
					security,
					ask,
					scopeKey,
				};

			if (background || yieldMs === 0) {
				markBackgrounded(run.session.id);
				return okText(JSON.stringify(runningPayload), runningPayload);
			}

			const waitResult = await Promise.race([
				run.completion,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), yieldMs)),
			]);

			if (waitResult === null) {
				markBackgrounded(run.session.id);
				return okText(JSON.stringify(runningPayload), runningPayload);
			}

			const outcome = waitResult;
			const payload = {
				status: outcome.status,
				sessionId: run.session.id,
				exitCode: outcome.exitCode,
				exitSignal: outcome.exitSignal,
				durationMs: outcome.durationMs,
				cwd: run.session.cwd,
				output: outcome.aggregated,
				timedOut: outcome.timedOut,
					reason: outcome.reason,
					warnings: run.warnings,
					host,
					security,
					ask,
					scopeKey,
				};

			if (outcome.status === "failed") {
				throw new Error(JSON.stringify(payload));
			}

			return okText(JSON.stringify(payload), payload);
		},
	};
}

export function createProcessTool(defaults?: { cleanupMs?: number; scopeKey?: string }): BashTool {
	if (typeof defaults?.cleanupMs === "number" && defaults.cleanupMs > 0) {
		setCleanupMs(defaults.cleanupMs);
	}

	return {
		name: BASH_PROCESS_TOOL,
		label: BASH_PROCESS_TOOL,
		description:
			"Manage running exec sessions: list, poll, log, write, send-keys, submit, paste, kill, clear, remove.",
		execute: async (_toolCallId, rawArgs) => {
				const args = (rawArgs ?? {}) as {
					action?: string;
					sessionId?: string;
					scopeKey?: string;
					data?: string;
					keys?: string[];
					hex?: string[];
				literal?: string;
				text?: string;
				bracketed?: boolean;
				eof?: boolean;
				offset?: number;
				limit?: number;
				timeout?: unknown;
			};
				const action = String(args.action ?? "").trim().toLowerCase();
				if (!action) {
					throw new Error("action is required.");
				}
				const scopeKey = resolveScopeKey(args as Record<string, unknown>, defaults?.scopeKey);

				if (action === "list") {
					const running = listRunningSessions()
						.filter((session) => isInScope(session, scopeKey))
						.map((session) => sessionSummary(session));
					const finished = listFinishedSessions()
						.filter((session) => isInScope(session, scopeKey))
						.map((session) => sessionSummary(session));
					return okText(
						JSON.stringify({
							status: "completed",
						running,
						finished,
					}),
				);
			}

			if (!args.sessionId) {
				throw new Error("sessionId is required for this action.");
			}

				const requireBackgroundRunningSession = () => {
					const running = getRunningSession(args.sessionId!);
					if (!running || !isInScope(running, scopeKey)) {
						throw new Error(`No running session found for ${args.sessionId}`);
					}
					if (!running.backgrounded) {
					throw new Error(`Session ${args.sessionId} is not backgrounded.`);
				}
				return running;
			};

				if (action === "poll") {
					const waitMs = parsePollTimeout(args.timeout);
					const runningBeforeWait = getRunningSession(args.sessionId);
					if (waitMs > 0 && runningBeforeWait && isInScope(runningBeforeWait, scopeKey)) {
						await waitForSessionUpdate(args.sessionId, waitMs, runningBeforeWait.updateSeq);
					}

					const running = getRunningSession(args.sessionId);
					if (running && isInScope(running, scopeKey)) {
						if (!running.backgrounded) {
							throw new Error(`Session ${args.sessionId} is not backgrounded.`);
						}
					const payload = {
						status: "running",
						...sessionSummary(running),
						};
						return okText(JSON.stringify(payload), payload);
					}
					const finished = getFinishedSession(args.sessionId);
					if (finished && isInScope(finished, scopeKey)) {
						const payload = {
							status: finished.status,
							...sessionSummary(finished),
						output: finished.output,
					};
					return okText(JSON.stringify(payload), payload);
				}
				throw new Error(`No session found for ${args.sessionId}`);
			}

				if (action === "log") {
					const running = getRunningSession(args.sessionId);
					const finished = getFinishedSession(args.sessionId);
					const session = isInScope(running, scopeKey)
						? running
						: isInScope(finished, scopeKey)
							? finished
							: undefined;
					if (!session) {
						throw new Error(`No session found for ${args.sessionId}`);
					}
				if (!session.backgrounded) {
					throw new Error(`Session ${args.sessionId} is not backgrounded.`);
				}
				const fallbackLimit =
					args.offset === undefined && args.limit === undefined ? DEFAULT_LOG_TAIL_LINES : undefined;
				const { lines, total } = sliceLogLines(session.output, args.offset, args.limit ?? fallbackLimit);
				const payload = {
					status: session.status,
					sessionId: session.id,
					totalLines: total,
					offset:
						typeof args.offset === "number" && Number.isFinite(args.offset)
							? Math.max(0, Math.floor(args.offset))
							: 0,
					limit:
						typeof args.limit === "number" && Number.isFinite(args.limit)
							? Math.max(0, Math.floor(args.limit))
							: fallbackLimit,
					lines,
				};
				return okText(JSON.stringify(payload), payload);
			}

			if (action === "write") {
				const data = typeof args.data === "string" ? args.data : "";
				if (!data) {
					throw new Error("data is required for write action.");
				}
				requireBackgroundRunningSession();
				const result = writeSessionInput(args.sessionId, data, args.eof === true);
				if (!result.ok) {
					throw new Error(result.reason ?? "failed to write stdin");
				}
				return okText(JSON.stringify({ status: "completed", sessionId: args.sessionId, action }));
			}

			if (action === "send-keys") {
				const keys = Array.isArray(args.keys) ? args.keys.map((token) => encodeKeyToken(String(token))) : [];
				const literal = typeof args.literal === "string" ? args.literal : "";
				const hexPayload = encodeHexBytes(args.hex);
				const payload = `${keys.join("")}${hexPayload}${literal}`;
				if (!payload) {
					throw new Error("keys, hex, or literal is required for send-keys action.");
				}
				requireBackgroundRunningSession();
				const result = writeSessionInput(args.sessionId, payload, false);
				if (!result.ok) {
					throw new Error(result.reason ?? "failed to write key sequence");
				}
				return okText(JSON.stringify({ status: "completed", sessionId: args.sessionId, action }));
			}

			if (action === "submit") {
				requireBackgroundRunningSession();
				const result = writeSessionInput(args.sessionId, "\r", false);
				if (!result.ok) {
					throw new Error(result.reason ?? "failed to submit");
				}
				return okText(JSON.stringify({ status: "completed", sessionId: args.sessionId, action }));
			}

			if (action === "paste") {
				const text = typeof args.text === "string" ? args.text : "";
				if (!text) {
					throw new Error("text is required for paste action.");
				}
				requireBackgroundRunningSession();
				const payload = args.bracketed === true ? `\u001b[200~${text}\u001b[201~` : text;
				const result = writeSessionInput(args.sessionId, payload, false);
				if (!result.ok) {
					throw new Error(result.reason ?? "failed to paste");
				}
				return okText(JSON.stringify({ status: "completed", sessionId: args.sessionId, action }));
			}

				if (action === "kill") {
					const running = requireBackgroundRunningSession();
					const ok = killSession(args.sessionId);
					if (!ok) {
						throw new Error(`No running session found for ${args.sessionId}`);
					}
					return okText(
						JSON.stringify({
							status: "completed",
							sessionId: args.sessionId,
							action,
							scopeKey: running.scopeKey,
						}),
					);
				}

				if (action === "clear") {
					const finished = getFinishedSession(args.sessionId);
					if (!finished || !isInScope(finished, scopeKey)) {
						throw new Error(`No finished session found for ${args.sessionId}`);
					}
					const ok = clearFinishedSession(args.sessionId);
					if (!ok) {
						throw new Error(`No finished session found for ${args.sessionId}`);
					}
					return okText(JSON.stringify({ status: "completed", sessionId: args.sessionId, action }));
				}

				if (action === "remove") {
					const running = getRunningSession(args.sessionId);
					const finished = getFinishedSession(args.sessionId);
					if (running && !isInScope(running, scopeKey)) {
						throw new Error(`No session found for ${args.sessionId}`);
					}
					if (!running && finished && !isInScope(finished, scopeKey)) {
						throw new Error(`No session found for ${args.sessionId}`);
					}
					if (running) {
						killSession(args.sessionId);
					}
					const ok = deleteSession(args.sessionId);
				if (!ok) {
					throw new Error(`No session found for ${args.sessionId}`);
				}
				return okText(JSON.stringify({ status: "completed", sessionId: args.sessionId, action }));
			}

			throw new Error(`Unknown action ${action}`);
		},
	};
}

export const execTool = createExecTool();
export const processTool = createProcessTool();

export async function handleBashTool(
	toolName: string,
	args: Record<string, unknown>,
): Promise<ToolResult> {
	try {
		if (toolName === BASH_EXEC_TOOL) {
			return toToolResult(await execTool.execute("", args));
		}
		if (toolName === BASH_PROCESS_TOOL) {
			return toToolResult(await processTool.execute("", args));
		}
		return fail(`Unknown bash tool: ${toolName}`);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}
