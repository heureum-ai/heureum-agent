// Tool definitions for LLM binding
export { CODING_TOOLS, handleCodingTool } from "./tool-schema.js";

// Types
export type {
	CodingTool,
	ImageContent,
	TextContent,
	ToolContent,
	ToolExecuteResult,
	ToolResult,
} from "./types.js";

// Tool factories (for direct usage)
export { createBashTool, type BashOperations, type BashSpawnContext, type BashSpawnHook, type BashToolDetails, type BashToolOptions } from "./bash.js";
export { createReadTool, type ReadOperations, type ReadToolDetails, type ReadToolOptions } from "./read.js";
export { createEditTool, type EditOperations, type EditToolDetails, type EditToolOptions } from "./edit.js";
export { createWriteTool, type WriteOperations, type WriteToolOptions } from "./write.js";
export { createGrepTool, type GrepOperations, type GrepToolDetails, type GrepToolOptions } from "./grep.js";
export { createFindTool, type FindOperations, type FindToolDetails, type FindToolOptions } from "./find.js";
export { createLsTool, type LsOperations, type LsToolDetails, type LsToolOptions } from "./ls.js";

// Utilities
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export { expandPath, resolveReadPath, resolveToCwd } from "./path-utils.js";
