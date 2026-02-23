import { describe, expect, it } from "vitest";
import { createCodingToolset } from "../src/toolset.js";

describe("coding toolset", () => {
	it("exposes direct coding tool names", () => {
		const toolset = createCodingToolset();
		expect(toolset.tools.map((tool) => tool.name)).toEqual(["read", "edit", "write", "grep", "find", "ls"]);
		expect(Array.from(toolset.toolNames).sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
	});

	it("routes execute calls through coding handler", async () => {
		const toolset = createCodingToolset();
		const unknown = await toolset.execute("nonexistent", {});
		expect(unknown.success).toBe(false);
		expect(unknown.output).toContain("Unknown coding tool");

		const exec = await toolset.execute("exec", { command: "echo hi" });
		expect(exec.success).toBe(false);
		expect(exec.output).toContain("Unknown coding tool");
	});
});
