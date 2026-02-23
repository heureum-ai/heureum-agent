import { describe, expect, it } from "vitest";
import { CODING_TOOLS, handleCodingTool } from "../src/tool-schema.js";

describe("CODING_TOOLS", () => {
	const toolMap = Object.fromEntries(CODING_TOOLS.map((tool) => [tool.name, tool]));

	it("exports direct tools", () => {
		expect(CODING_TOOLS).toHaveLength(6);
	});

	it("has expected tool names", () => {
		const names = CODING_TOOLS.map((tool) => tool.name);
		expect(names).toEqual(["read", "edit", "write", "grep", "find", "ls"]);
	});

	it("all tools have required fields", () => {
		for (const tool of CODING_TOOLS) {
			expect(tool.type).toBe("function");
			expect(tool.name).toBeTruthy();
			expect(tool.description).toBeTruthy();
			expect(tool.parameters?.type).toBe("object");
			expect(tool.parameters?.properties).toBeDefined();
		}
	});

	it("read schema", () => {
		const parameters = toolMap.read.parameters!;
		expect(parameters.properties.path.type).toBe("string");
		expect(parameters.properties.offset.type).toBe("number");
		expect(parameters.properties.limit.type).toBe("number");
		expect(parameters.required).toEqual(["path"]);
	});

	it("edit schema", () => {
		const parameters = toolMap.edit.parameters!;
		expect(parameters.properties.path.type).toBe("string");
		expect(parameters.properties.oldText.type).toBe("string");
		expect(parameters.properties.newText.type).toBe("string");
		expect(parameters.required).toEqual(["path", "oldText", "newText"]);
	});

	it("write schema", () => {
		const parameters = toolMap.write.parameters!;
		expect(parameters.properties.path.type).toBe("string");
		expect(parameters.properties.content.type).toBe("string");
		expect(parameters.required).toEqual(["path", "content"]);
	});

	it("grep schema", () => {
		const parameters = toolMap.grep.parameters!;
		expect(parameters.properties.pattern.type).toBe("string");
		expect(parameters.properties.path.type).toBe("string");
		expect(parameters.properties.glob.type).toBe("string");
		expect(parameters.properties.ignoreCase.type).toBe("boolean");
		expect(parameters.properties.literal.type).toBe("boolean");
		expect(parameters.properties.context.type).toBe("number");
		expect(parameters.properties.limit.type).toBe("number");
		expect(parameters.required).toEqual(["pattern"]);
	});

	it("find schema", () => {
		const parameters = toolMap.find.parameters!;
		expect(parameters.properties.pattern.type).toBe("string");
		expect(parameters.properties.path.type).toBe("string");
		expect(parameters.properties.limit.type).toBe("number");
		expect(parameters.required).toEqual(["pattern"]);
	});

	it("ls schema", () => {
		const parameters = toolMap.ls.parameters!;
		expect(parameters.properties.path.type).toBe("string");
		expect(parameters.properties.limit.type).toBe("number");
		expect(parameters.required).toBeUndefined();
	});
});

describe("handleCodingTool", () => {
	it("returns error for unknown tool", async () => {
		const result = await handleCodingTool("nonexistent", {});
		expect(result.success).toBe(false);
		expect(result.output).toContain("Unknown coding tool");
	});

	it("blocks direct runtime tool name exec", async () => {
		const result = await handleCodingTool("exec", { command: "echo hello" });
		expect(result.success).toBe(false);
		expect(result.output).toContain("Unknown coding tool");
	});

	it("blocks direct runtime tool name process", async () => {
		const result = await handleCodingTool("process", { action: "list" });
		expect(result.success).toBe(false);
		expect(result.output).toContain("Unknown coding tool");
	});

	it("does not expose removed coding pipeline tools", async () => {
		for (const toolName of [
			"coding_init_task",
			"coding_write_source",
			"coding_write_intermediate",
			"coding_pack_output",
			"coding_unpack_output",
			"coding_read_parsed",
			"coding_read_source",
		]) {
			const result = await handleCodingTool(toolName, {});
			expect(result.success).toBe(false);
			expect(result.output).toContain("Unknown coding tool");
		}
	});
});
