import { BASH_TOOLS } from "./tool-schema.js";

interface ClientToolDefinition {
	type: string;
	name: string;
	description?: string;
	display_name: string;
	parameters?: Record<string, unknown>;
	guide?: string;
}

export { BASH_TOOLS, handleBashTool } from "./tool-schema.js";
export const toolsList = (): ClientToolDefinition[] => BASH_TOOLS.map((tool) => ({ ...tool }));

export { BASH_WORKFLOW_PROMPT, buildBashWorkflowPrompt } from "./prompt.js";
export type { BashPromptOptions } from "./prompt.js";

export {
	BASH_EXEC_TOOL,
	BASH_PROCESS_TOOL,
	createExecTool,
	createProcessTool,
	execTool,
	processTool,
	handleBashTool as handleBashToolImpl,
	type BashToolName,
} from "./tools.js";

export type { BashTool, ToolContent, ToolExecuteResult, ToolResult } from "./types.js";

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const BASH_SKILLS = loadSkills()
