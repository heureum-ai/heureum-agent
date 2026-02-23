import * as fs from "node:fs/promises";
import type { ToolResult } from "../types.js";
import { isDirectToolName, runDirectTool } from "./direct-dispatch.js";

type RunnerPayload = {
	toolName?: unknown;
	args?: unknown;
	cwd?: unknown;
};

type RunnerCliArgs = {
	encodedPayload?: string;
	payloadFile?: string;
	resultFile?: string;
};

function parseCliArgs(argv: string[]): RunnerCliArgs {
	const cliArgs: RunnerCliArgs = {};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--payload-file") {
			const value = argv[i + 1];
			if (typeof value === "string" && value.trim().length > 0) {
				cliArgs.payloadFile = value;
				i += 1;
			}
			continue;
		}
		if (token === "--result-file") {
			const value = argv[i + 1];
			if (typeof value === "string" && value.trim().length > 0) {
				cliArgs.resultFile = value;
				i += 1;
			}
			continue;
		}
		if (!cliArgs.encodedPayload) {
			cliArgs.encodedPayload = token;
		}
	}
	return cliArgs;
}

async function parsePayload(cliArgs: RunnerCliArgs): Promise<RunnerPayload> {
	if (cliArgs.payloadFile) {
		const raw = await fs.readFile(cliArgs.payloadFile, "utf-8");
		return JSON.parse(raw) as RunnerPayload;
	}
	if (cliArgs.encodedPayload) {
		const decodedPayload = Buffer.from(cliArgs.encodedPayload, "base64url").toString("utf-8");
		return JSON.parse(decodedPayload) as RunnerPayload;
	}
	throw new Error("Missing payload argument for direct runner.");
}

async function writePayload(payload: ToolResult, resultFile?: string): Promise<void> {
	const encoded = JSON.stringify(payload);
	if (resultFile && resultFile.trim().length > 0) {
		await fs.writeFile(resultFile, encoded, "utf-8");
	}
	process.stdout.write(encoded);
}

async function fail(message: string, resultFile?: string): Promise<void> {
	await writePayload({ success: false, output: message }, resultFile);
}

function toObjectRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

async function main(): Promise<void> {
	const cliArgs = parseCliArgs(process.argv.slice(2));
	try {
		const payload = await parsePayload(cliArgs);

		const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
		if (!isDirectToolName(toolName)) {
			await fail(`Unsupported direct tool: ${toolName || "(empty)"}`, cliArgs.resultFile);
			return;
		}

		const args = toObjectRecord(payload.args);
		const cwd = typeof payload.cwd === "string" && payload.cwd.trim().length > 0
			? payload.cwd
			: process.cwd();

		await writePayload(await runDirectTool(toolName, args, cwd), cliArgs.resultFile);
	} catch (error) {
		await fail(error instanceof Error ? error.message : String(error), cliArgs.resultFile);
	}
}

await main();
