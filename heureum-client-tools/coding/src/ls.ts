import { constants } from "fs";
import { access, readdir } from "fs/promises";
import { resolveToCwd } from "./path-utils.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from "./truncate.js";
import type { CodingTool } from "./types.js";


const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (e.g., SSH).
 */
export interface LsOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean>;
	/** Read directory entries with type information */
	readdirWithTypes: (absolutePath: string) => Promise<Array<{ name: string; isDirectory: () => boolean }>>;
}

const defaultLsOperations: LsOperations = {
	exists: async (p) => {
		try {
			await access(p, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	},
	readdirWithTypes: (p) => readdir(p, { withFileTypes: true }),
};

export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem */
	operations?: LsOperations;
}

export function createLsTool(cwd: string, options?: LsToolOptions): CodingTool {
	const ops = options?.operations ?? defaultLsOperations;

	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		execute: async (
			_toolCallId: string,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
		) => {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// Check if path exists
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}

						// Read directory entries with types (no individual stat calls needed)
						let entries: Array<{ name: string; isDirectory: () => boolean }>;
						try {
							entries = await ops.readdirWithTypes(dirPath);
						} catch (e: any) {
							reject(new Error(`Cannot read directory: ${e.message}`));
							return;
						}

						// Sort alphabetically (case-insensitive)
						entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

						// Format entries with directory indicators
						const results: string[] = [];
						let entryLimitReached = false;

						for (const entry of entries) {
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const suffix = entry.isDirectory() ? "/" : "";
							results.push(entry.name + suffix);
						}

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							return;
						}

						// Apply byte truncation (no line limit since we already have entry limit)
						const rawOutput = results.join("\n");
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

						let output = truncation.content;
						const details: LsToolDetails = {};

						// Build notices
						const notices: string[] = [];

						if (entryLimitReached) {
							notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
							details.entryLimitReached = effectiveLimit;
						}

						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}

						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
	};
}

