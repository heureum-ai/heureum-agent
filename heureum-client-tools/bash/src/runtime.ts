import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { getShellConfig, getShellEnv, killProcessTree } from "./helpers/shell.js";

export type SessionStatus = "running" | "completed" | "failed";

export interface ExecSession {
	id: string;
	command: string;
	scopeKey?: string;
	cwd: string;
	startedAt: number;
	endedAt?: number;
	status: SessionStatus;
	backgrounded: boolean;
	pid?: number;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | number | null;
	output: string;
	tail: string;
	truncated: boolean;
	child?: ChildProcessWithoutNullStreams;
	stdin?: NodeJS.WritableStream;
	removed?: boolean;
	updateSeq: number;
}

export interface ExecOutcome {
	status: "completed" | "failed";
	exitCode: number | null;
	exitSignal: NodeJS.Signals | number | null;
	durationMs: number;
	aggregated: string;
	timedOut: boolean;
	reason?: string;
}

export interface StartExecOptions {
	command: string;
	scopeKey?: string;
	cwd: string;
	env?: Record<string, string>;
	pty?: boolean;
	timeoutSec: number;
	maxOutputChars: number;
	pendingOutputChars: number;
}

const DEFAULT_CLEANUP_MS = 30 * 60 * 1000;
let cleanupMs = DEFAULT_CLEANUP_MS;

const runningSessions = new Map<string, ExecSession>();
const finishedSessions = new Map<string, ExecSession>();
const sessionEvents = new Map<string, EventEmitter>();

function createSessionId() {
	return randomBytes(8).toString("hex");
}

function getEmitter(sessionId: string): EventEmitter {
	const existing = sessionEvents.get(sessionId);
	if (existing) {
		return existing;
	}
	const emitter = new EventEmitter();
	// process(action=poll) can attach many concurrent listeners for the same session.
	// Disable EventEmitter's low default cap to avoid false-positive leak warnings.
	emitter.setMaxListeners(0);
	sessionEvents.set(sessionId, emitter);
	return emitter;
}

function findSession(sessionId: string): ExecSession | undefined {
	return runningSessions.get(sessionId) ?? finishedSessions.get(sessionId);
}

function notifySessionUpdate(sessionOrId: ExecSession | string): void {
	const sessionId = typeof sessionOrId === "string" ? sessionOrId : sessionOrId.id;
	const session = typeof sessionOrId === "string" ? findSession(sessionId) : sessionOrId;
	if (session) {
		session.updateSeq += 1;
	}
	getEmitter(sessionId).emit("update");
}

function truncateTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return text.slice(-maxChars);
}

function appendOutput(session: ExecSession, chunk: string, maxOutputChars: number, pendingOutputChars: number) {
	session.output += chunk;
	if (session.output.length > maxOutputChars) {
		session.output = session.output.slice(-maxOutputChars);
		session.truncated = true;
	}
	// Keep tail updates bounded by pendingOutputChars to avoid rescanning full output on each chunk.
	session.tail = truncateTail(`${session.tail}${chunk}`, pendingOutputChars);
	notifySessionUpdate(session);
}

function normalizeSignal(
	signal: NodeJS.Signals | number | null | undefined,
): NodeJS.Signals | number | null {
	if (signal == null) {
		return null;
	}
	return signal;
}

function sweepFinishedSessions(now = Date.now()) {
	for (const [id, session] of finishedSessions.entries()) {
		const endedAt = session.endedAt ?? session.startedAt;
		if (now - endedAt >= cleanupMs) {
			finishedSessions.delete(id);
			sessionEvents.delete(id);
		}
	}
}

export function setCleanupMs(value?: number) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		cleanupMs = Math.floor(value);
	}
}

export function listRunningSessions(): ExecSession[] {
	sweepFinishedSessions();
	return [...runningSessions.values()]
		.filter((session) => session.backgrounded)
		.map((session) => ({ ...session }));
}

export function listFinishedSessions(): ExecSession[] {
	sweepFinishedSessions();
	return [...finishedSessions.values()].map((session) => ({ ...session }));
}

export function getRunningSession(sessionId: string): ExecSession | undefined {
	return runningSessions.get(sessionId);
}

export function getFinishedSession(sessionId: string): ExecSession | undefined {
	sweepFinishedSessions();
	return finishedSessions.get(sessionId);
}

export function deleteSession(sessionId: string): boolean {
	const running = runningSessions.get(sessionId);
	if (running) {
		running.removed = true;
	}
	const removedRunning = runningSessions.delete(sessionId);
	const removedFinished = finishedSessions.delete(sessionId);
	if (removedRunning || removedFinished) {
		// Wake poll waiters promptly before dropping the emitter reference.
		sessionEvents.get(sessionId)?.emit("update");
		sessionEvents.delete(sessionId);
	}
	return removedRunning || removedFinished;
}

export function markBackgrounded(sessionId: string): void {
	const session = runningSessions.get(sessionId);
	if (!session) {
		return;
	}
	session.backgrounded = true;
	notifySessionUpdate(session);
}

export function clearFinishedSession(sessionId: string): boolean {
	const removed = finishedSessions.delete(sessionId);
	if (!removed) {
		return false;
	}
	sessionEvents.get(sessionId)?.emit("update");
	sessionEvents.delete(sessionId);
	return true;
}

export function killSession(sessionId: string): boolean {
	const session = runningSessions.get(sessionId);
	if (!session) {
		return false;
	}
	const pid = session.pid;
	if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
		killProcessTree(pid);
		return true;
	}
	if (session.child && session.child.pid) {
		killProcessTree(session.child.pid);
		return true;
	}
	return false;
}

export function writeSessionInput(sessionId: string, data: string, eof = false): { ok: boolean; reason?: string } {
	const session = runningSessions.get(sessionId);
	if (!session) {
		return { ok: false, reason: "No running session found." };
	}
	const stdin = session.stdin;
	if (!stdin || typeof (stdin as NodeJS.WritableStream).write !== "function") {
		return { ok: false, reason: "Session has no writable stdin." };
	}
	try {
		(stdin as NodeJS.WritableStream).write(data);
		if (eof) {
			(stdin as NodeJS.WritableStream).end();
		}
		notifySessionUpdate(session);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export async function waitForSessionUpdate(
	sessionId: string,
	timeoutMs: number,
	sinceSeq?: number,
): Promise<boolean> {
	if (timeoutMs <= 0) {
		return false;
	}
	const existing = findSession(sessionId);
	if (!existing) {
		return false;
	}
	if (typeof sinceSeq === "number" && existing.updateSeq !== sinceSeq) {
		return true;
	}
	const emitter = getEmitter(sessionId);
	return await new Promise<boolean>((resolve) => {
		let timer: NodeJS.Timeout | null = null;
		const done = (updated: boolean) => {
			if (timer) {
				clearTimeout(timer);
			}
			emitter.off("update", onUpdate);
			resolve(updated);
		};
		const onUpdate = () => done(true);
		emitter.once("update", onUpdate);

		const latest = findSession(sessionId);
		if (typeof sinceSeq === "number" && latest && latest.updateSeq !== sinceSeq) {
			done(true);
			return;
		}

		timer = setTimeout(() => done(false), timeoutMs);
		timer.unref?.();
	});
}

export async function startExecProcess(opts: StartExecOptions): Promise<{
	session: ExecSession;
	completion: Promise<ExecOutcome>;
	warnings: string[];
}> {
	sweepFinishedSessions();
	const warnings: string[] = [];
	const startedAt = Date.now();
	const sessionId = createSessionId();

	if (opts.pty) {
		throw new Error("pty=true is not supported in this runtime.");
	}

	const { shell, args } = await getShellConfig();
	const env = {
		...getShellEnv(),
		...(opts.env ?? {}),
	};

	const child = spawn(shell, [...args, opts.command], {
		cwd: opts.cwd,
		detached: true,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const session: ExecSession = {
		id: sessionId,
		command: opts.command,
		scopeKey: opts.scopeKey,
		cwd: opts.cwd,
		startedAt,
		status: "running",
		backgrounded: false,
		pid: child.pid,
		output: "",
		tail: "",
		truncated: false,
		child,
		stdin: child.stdin,
		updateSeq: 0,
	};

	runningSessions.set(sessionId, session);
	getEmitter(sessionId);

	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | null = null;
	if (opts.timeoutSec > 0) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			if (child.pid) {
				killProcessTree(child.pid);
			}
		}, opts.timeoutSec * 1000);
		timeoutHandle.unref?.();
	}

	child.stdout.on("data", (chunk: Buffer | string) => {
		appendOutput(
			session,
			typeof chunk === "string" ? chunk : chunk.toString("utf-8"),
			opts.maxOutputChars,
			opts.pendingOutputChars,
		);
	});

	child.stderr.on("data", (chunk: Buffer | string) => {
		appendOutput(
			session,
			typeof chunk === "string" ? chunk : chunk.toString("utf-8"),
			opts.maxOutputChars,
			opts.pendingOutputChars,
		);
	});

	const completion = new Promise<ExecOutcome>((resolve) => {
		child.on("error", (error) => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			runningSessions.delete(sessionId);
			session.status = "failed";
			session.endedAt = Date.now();
			session.exitCode = null;
			session.exitSignal = null;
			if (session.removed) {
				sessionEvents.delete(sessionId);
				resolve({
					status: "failed",
					exitCode: null,
					exitSignal: null,
					durationMs: session.endedAt - startedAt,
					aggregated: session.output,
					timedOut: false,
					reason: error.message,
				});
				return;
			}
			if (session.backgrounded) {
				finishedSessions.set(sessionId, session);
				notifySessionUpdate(session);
			} else {
				sessionEvents.delete(sessionId);
			}
			resolve({
				status: "failed",
				exitCode: null,
				exitSignal: null,
				durationMs: session.endedAt - startedAt,
				aggregated: session.output,
				timedOut: false,
				reason: error.message,
			});
		});

		child.on("close", (code, signal) => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			runningSessions.delete(sessionId);
			session.endedAt = Date.now();
			session.exitCode = code;
			session.exitSignal = normalizeSignal(signal);
			const failed = timedOut || (code ?? 0) !== 0;
			session.status = failed ? "failed" : "completed";
			const durationMs = (session.endedAt ?? Date.now()) - startedAt;

			if (session.removed) {
				finishedSessions.delete(sessionId);
				sessionEvents.delete(sessionId);
				if (failed) {
					resolve({
						status: "failed",
						exitCode: code,
						exitSignal: normalizeSignal(signal),
						durationMs,
						aggregated: session.output,
						timedOut,
						reason: timedOut
							? `Command timed out after ${opts.timeoutSec} seconds`
							: `Command exited with code ${code ?? "unknown"}`,
					});
					return;
				}
				resolve({
					status: "completed",
					exitCode: code,
					exitSignal: normalizeSignal(signal),
					durationMs,
					aggregated: session.output,
					timedOut,
				});
				return;
			}

			if (session.backgrounded) {
				finishedSessions.set(sessionId, session);
				notifySessionUpdate(session);
			} else {
				sessionEvents.delete(sessionId);
			}
			if (failed) {
				resolve({
					status: "failed",
					exitCode: code,
					exitSignal: normalizeSignal(signal),
					durationMs,
					aggregated: session.output,
					timedOut,
					reason: timedOut
						? `Command timed out after ${opts.timeoutSec} seconds`
						: `Command exited with code ${code ?? "unknown"}`,
				});
				return;
			}

			resolve({
				status: "completed",
				exitCode: code,
				exitSignal: normalizeSignal(signal),
				durationMs,
				aggregated: session.output,
				timedOut,
			});
		});
	});

	return {
		session,
		completion,
		warnings,
	};
}
