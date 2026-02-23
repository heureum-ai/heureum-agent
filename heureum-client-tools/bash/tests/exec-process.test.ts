import { describe, expect, it } from "vitest";
import { handleBashTool } from "../src/tool-schema.js";

function parseJsonOutput(output: string) {
	return JSON.parse(output) as Record<string, unknown>;
}

describe("exec/process", () => {
	it("runs a synchronous command", async () => {
		const result = await handleBashTool("exec", {
			command: "echo hello-bash-toolkit",
		});

		expect(result.success).toBe(true);
		const payload = parseJsonOutput(result.output);
		expect(payload.status).toBe("completed");
		expect(String(payload.output ?? "")).toContain("hello-bash-toolkit");
	});

	it("supports background and poll", async () => {
		const started = await handleBashTool("exec", {
			command: "node -e \"setTimeout(() => console.log('done-bg'), 150)\"",
			background: true,
		});
		expect(started.success).toBe(true);

		const startPayload = parseJsonOutput(started.output);
		expect(startPayload.status).toBe("running");
		const sessionId = String(startPayload.sessionId ?? "");
		expect(sessionId.length).toBeGreaterThan(0);

		const polled = await handleBashTool("process", {
			action: "poll",
			sessionId,
			timeout: 2000,
		});
		expect(polled.success).toBe(true);

		const pollPayload = parseJsonOutput(polled.output);
		expect(["running", "completed", "failed"]).toContain(String(pollPayload.status));
	});

	it("blocks non-allowlisted commands when security=allowlist", async () => {
		const result = await handleBashTool("exec", {
			command: "node -e \"console.log('blocked')\"",
			security: "allowlist",
			safeBins: ["echo"],
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("safeBins allowlist");
	});

	it("blocks allowlist bypass through command chaining", async () => {
		const result = await handleBashTool("exec", {
			command: "echo ok; node -e \"console.log('blocked')\"",
			security: "allowlist",
			safeBins: ["echo"],
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("safeBins allowlist");
	});

	it("rejects pty=true because PTY runtime is unsupported", async () => {
		const result = await handleBashTool("exec", {
			command: "echo pty",
			pty: true,
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("pty=true is not supported");
	});

	it("isolates sessions by scopeKey", async () => {
		const started = await handleBashTool("exec", {
			command: "node -e \"setTimeout(() => console.log('scope-run'), 200)\"",
			background: true,
			scopeKey: "scope-a",
		});
		expect(started.success).toBe(true);
		const sessionId = String(parseJsonOutput(started.output).sessionId ?? "");
		expect(sessionId.length).toBeGreaterThan(0);

		const outOfScopePoll = await handleBashTool("process", {
			action: "poll",
			sessionId,
			timeout: 50,
			scopeKey: "scope-b",
		});
		expect(outOfScopePoll.success).toBe(false);
		expect(outOfScopePoll.output).toContain("No session found");

		const inScopePoll = await handleBashTool("process", {
			action: "poll",
			sessionId,
			timeout: 2000,
			scopeKey: "scope-a",
		});
		expect(inScopePoll.success).toBe(true);

		const outOfScopeList = await handleBashTool("process", {
			action: "list",
			scopeKey: "scope-b",
		});
		expect(outOfScopeList.success).toBe(true);
		const outOfScopePayload = parseJsonOutput(outOfScopeList.output) as {
			running?: Array<{ sessionId?: string }>;
			finished?: Array<{ sessionId?: string }>;
		};
		expect((outOfScopePayload.running ?? []).some((entry) => entry.sessionId === sessionId)).toBe(false);
		expect((outOfScopePayload.finished ?? []).some((entry) => entry.sessionId === sessionId)).toBe(false);

		const removed = await handleBashTool("process", {
			action: "remove",
			sessionId,
			scopeKey: "scope-a",
		});
		expect(removed.success).toBe(true);
	});

	it("lists sessions", async () => {
		const listed = await handleBashTool("process", { action: "list" });
		expect(listed.success).toBe(true);
		const payload = parseJsonOutput(listed.output);
		expect(payload.status).toBe("completed");
		expect(Array.isArray(payload.running)).toBe(true);
		expect(Array.isArray(payload.finished)).toBe(true);
	});

	it("does not retain non-background sessions in process history", async () => {
		const result = await handleBashTool("exec", {
			command: "echo no-background-history",
		});
		expect(result.success).toBe(true);
		const sessionId = String(parseJsonOutput(result.output).sessionId ?? "");
		expect(sessionId.length).toBeGreaterThan(0);

		const listed = await handleBashTool("process", { action: "list" });
		expect(listed.success).toBe(true);
		const payload = parseJsonOutput(listed.output) as {
			running?: Array<{ sessionId?: string }>;
			finished?: Array<{ sessionId?: string }>;
		};
		expect((payload.running ?? []).some((entry) => entry.sessionId === sessionId)).toBe(false);
		expect((payload.finished ?? []).some((entry) => entry.sessionId === sessionId)).toBe(false);
	});

	it("does not re-add removed running sessions to finished list", async () => {
		const started = await handleBashTool("exec", {
			command: "node -e \"setTimeout(() => console.log('late-remove'), 300)\"",
			background: true,
		});
		expect(started.success).toBe(true);
		const sessionId = String(parseJsonOutput(started.output).sessionId ?? "");
		expect(sessionId.length).toBeGreaterThan(0);

		const removed = await handleBashTool("process", {
			action: "remove",
			sessionId,
		});
		expect(removed.success).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 700));

		const listed = await handleBashTool("process", { action: "list" });
		expect(listed.success).toBe(true);
		const payload = parseJsonOutput(listed.output) as {
			running?: Array<{ sessionId?: string }>;
			finished?: Array<{ sessionId?: string }>;
		};
		expect((payload.running ?? []).some((entry) => entry.sessionId === sessionId)).toBe(false);
		expect((payload.finished ?? []).some((entry) => entry.sessionId === sessionId)).toBe(false);
	});

	it("handles many concurrent poll waiters without listener warnings", async () => {
		const warnings: string[] = [];
		const onWarning = (warning: Error) => {
			const message = `${warning.name}: ${warning.message}`;
			if (message.includes("MaxListenersExceededWarning")) {
				warnings.push(message);
			}
		};
		process.on("warning", onWarning);
		try {
			const started = await handleBashTool("exec", {
				command: "node -e \"setTimeout(() => console.log('poll-many'), 250)\"",
				background: true,
			});
			expect(started.success).toBe(true);
			const sessionId = String(parseJsonOutput(started.output).sessionId ?? "");
			expect(sessionId.length).toBeGreaterThan(0);

			const polls = await Promise.all(
				Array.from({ length: 32 }, () =>
					handleBashTool("process", {
						action: "poll",
						sessionId,
						timeout: 1000,
					}),
				),
			);
			expect(polls.every((item) => item.success)).toBe(true);
			expect(warnings).toHaveLength(0);
		} finally {
			process.off("warning", onWarning);
		}
	});

	it("clears finished sessions only", async () => {
		const started = await handleBashTool("exec", {
			command: "node -e \"setTimeout(() => console.log('clear-me'), 120)\"",
			background: true,
		});
		expect(started.success).toBe(true);
		const sessionId = String(parseJsonOutput(started.output).sessionId ?? "");
		expect(sessionId.length).toBeGreaterThan(0);

		const polled = await handleBashTool("process", {
			action: "poll",
			sessionId,
			timeout: 2000,
		});
		expect(polled.success).toBe(true);
		const pollPayload = parseJsonOutput(polled.output);
		if (pollPayload.status === "running") {
			const polledAgain = await handleBashTool("process", {
				action: "poll",
				sessionId,
				timeout: 2000,
			});
			expect(polledAgain.success).toBe(true);
		}

		const cleared = await handleBashTool("process", {
			action: "clear",
			sessionId,
		});
		expect(cleared.success).toBe(true);

		const listed = await handleBashTool("process", { action: "list" });
		expect(listed.success).toBe(true);
		const payload = parseJsonOutput(listed.output) as {
			running?: Array<{ sessionId?: string }>;
			finished?: Array<{ sessionId?: string }>;
		};
		expect((payload.running ?? []).some((entry) => entry.sessionId === sessionId)).toBe(false);
		expect((payload.finished ?? []).some((entry) => entry.sessionId === sessionId)).toBe(false);
	});
});
