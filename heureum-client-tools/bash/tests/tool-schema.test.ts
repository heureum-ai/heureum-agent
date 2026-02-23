import { describe, expect, it } from "vitest";
import { BASH_TOOLS } from "../src/tool-schema.js";

describe("BASH_TOOLS", () => {
	it("exposes exec/process only", () => {
		expect(BASH_TOOLS).toHaveLength(2);
		expect(BASH_TOOLS.map((tool) => tool.name)).toEqual(["exec", "process"]);
	});

	it("defines JSON-schema-like object parameters", () => {
		for (const tool of BASH_TOOLS) {
			expect(tool.type).toBe("function");
			expect(tool.parameters?.type).toBe("object");
		}
	});
});
