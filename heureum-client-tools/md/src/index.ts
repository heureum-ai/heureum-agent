import { MD_TOOLS } from "./tool-schema";

interface ClientToolDefinition {
  type: string;
  name: string;
  description?: string;
  display_name: string;
  parameters?: Record<string, unknown>;
  guide?: string;
}

// Tool implementations
export {
  mdInitTask,
  mdWriteSource,
  mdWriteIntermediate,
  mdPackTask,
  mdUnpackTask,
  mdReadParsed,
  mdReadSource,
  markdownCreate,
  markdownRead,
  markdownExtractOutline,
  markdownExtractStyleProfile,
  parseTemplateStyle,
  markdownGenerateToc,
  markdownAppendContent,
  markdownUpdateSection,
  markdownTransformDocument,
  markdownFormatDocument,
  markdownManageFrontmatter,
  markdownValidateDocument,
  markdownDiffDocument,
  type ToolResult,
  type Frontmatter,
  type FrontmatterScalar,
  type FrontmatterValue,
  type HeadingSelector,
  type MarkdownInlineRun,
  type MarkdownListItemInput,
  type MarkdownContentBlock,
} from "./tools";

// Tool definitions for LLM binding
export { MD_TOOLS, handleMdTool } from "./tool-schema";
export const toolsList = (): ClientToolDefinition[] => MD_TOOLS.map((tool) => ({ ...tool }));
export { MD_DEFAULTS } from "./configs";
export type { TaskContext, MdToolResult } from "./types";
export { MD_WORKFLOW_PROMPT, buildMdWorkflowPrompt } from "./prompt";
export type { MdPromptOptions } from "./prompt";

export {
  MdPipeline,
  resolveMdWorkDir,
  MD_STEP_SOURCE,
  MD_STEP_PARSED,
  MD_STEP_INTERMEDIATE,
  MD_STEP_OUTPUT,
} from "./pipeline";

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const MD_SKILLS = loadSkills()
