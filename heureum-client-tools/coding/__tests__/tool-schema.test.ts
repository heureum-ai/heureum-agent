import { describe, expect, it } from "vitest";
import { CODING_TOOLS, handleCodingTool } from "../src/tool-schema.js";

describe("CODING_TOOLS", () => {
	it("exports 7 tools", () => {
		expect(CODING_TOOLS).toHaveLength(7);
	});

	it("all tools have required fields", () => {
		for (const tool of CODING_TOOLS) {
			expect(tool.type).toBe("function");
			expect(tool.name).toBeTruthy();
			expect(tool.description).toBeTruthy();
		}
	});

	it("has expected tool names", () => {
		const names = CODING_TOOLS.map((t) => t.name);
		expect(names).toEqual(["bash", "read", "edit", "write", "grep", "find", "ls"]);
	});

	it("all tools with parameters have valid JSON Schema structure", () => {
		for (const tool of CODING_TOOLS) {
			if (tool.parameters) {
				expect(tool.parameters.type).toBe("object");
				expect(tool.parameters.properties).toBeDefined();
			}
		}
	});

	describe("schema parameter types", () => {
		const toolMap = Object.fromEntries(CODING_TOOLS.map((t) => [t.name, t]));

		it("bash: command (required string), timeout (optional number)", () => {
			const p = toolMap.bash.parameters!;
			expect(p.properties.command.type).toBe("string");
			expect(p.properties.timeout.type).toBe("number");
			expect(p.required).toEqual(["command"]);
		});

		it("read: path (required string), offset/limit (optional numbers)", () => {
			const p = toolMap.read.parameters!;
			expect(p.properties.path.type).toBe("string");
			expect(p.properties.offset.type).toBe("number");
			expect(p.properties.limit.type).toBe("number");
			expect(p.required).toEqual(["path"]);
		});

		it("edit: path/oldText/newText (all required strings)", () => {
			const p = toolMap.edit.parameters!;
			expect(p.properties.path.type).toBe("string");
			expect(p.properties.oldText.type).toBe("string");
			expect(p.properties.newText.type).toBe("string");
			expect(p.required).toEqual(["path", "oldText", "newText"]);
		});

		it("write: path/content (all required strings)", () => {
			const p = toolMap.write.parameters!;
			expect(p.properties.path.type).toBe("string");
			expect(p.properties.content.type).toBe("string");
			expect(p.required).toEqual(["path", "content"]);
		});

		it("grep: pattern (required), 6 optional params", () => {
			const p = toolMap.grep.parameters!;
			expect(p.properties.pattern.type).toBe("string");
			expect(p.properties.path.type).toBe("string");
			expect(p.properties.glob.type).toBe("string");
			expect(p.properties.ignoreCase.type).toBe("boolean");
			expect(p.properties.literal.type).toBe("boolean");
			expect(p.properties.context.type).toBe("number");
			expect(p.properties.limit.type).toBe("number");
			expect(p.required).toEqual(["pattern"]);
		});

		it("find: pattern (required), path/limit optional", () => {
			const p = toolMap.find.parameters!;
			expect(p.properties.pattern.type).toBe("string");
			expect(p.properties.path.type).toBe("string");
			expect(p.properties.limit.type).toBe("number");
			expect(p.required).toEqual(["pattern"]);
		});

		it("ls: all optional", () => {
			const p = toolMap.ls.parameters!;
			expect(p.properties.path.type).toBe("string");
			expect(p.properties.limit.type).toBe("number");
			expect(p.required).toBeUndefined();
		});
	});
});

describe("handleCodingTool", () => {
	it("returns error for unknown tool", async () => {
		const result = await handleCodingTool("nonexistent", {});
		expect(result.success).toBe(false);
		expect(result.output).toContain("Unknown coding tool");
	});
});
