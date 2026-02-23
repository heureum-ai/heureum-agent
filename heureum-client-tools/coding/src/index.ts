import { CODING_TOOLS } from "./tool-schema.js";

interface ClientToolDefinition {
	type: string;
	name: string;
	description?: string;
	display_name: string;
	parameters?: Record<string, unknown>;
	guide?: string;
}

// Tool definitions for LLM binding
export { CODING_TOOLS, handleCodingTool } from "./tool-schema.js";
export { createCodingToolset, codingToolset, type CodingToolset } from "./toolset.js";
export const toolsList = (): ClientToolDefinition[] => CODING_TOOLS.map((tool) => ({ ...tool }));
export { CODING_DEFAULTS } from "./configs.js";
export { CODING_WORKFLOW_PROMPT, buildCodingWorkflowPrompt } from "./prompt.js";
export type { CodingPromptOptions } from "./prompt.js";
export {
	CodingPipeline,
	resolveCodingWorkDir,
	codingPipelineFromTaskDir,
	CODING_STEP_SOURCE,
	CODING_STEP_PARSED,
	CODING_STEP_INTERMEDIATE,
	CODING_STEP_OUTPUT,
} from "./pipeline.js";
export {
	CODING_READ_TOOL,
	CODING_EDIT_TOOL,
	CODING_WRITE_TOOL,
	CODING_GREP_TOOL,
	CODING_FIND_TOOL,
	CODING_LS_TOOL,
	type CodingToolName,
} from "./tools.js";

// Types
export type {
	CodingTool,
	CodingToolResult,
	ImageContent,
	TaskContext,
	TextContent,
	ToolContent,
	ToolExecuteResult,
	ToolResult,
} from "./types.js";

// Tool factories (for direct usage)
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

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const CODING_SKILLS = loadSkills()
