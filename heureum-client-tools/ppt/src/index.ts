import { PPT_TOOLS } from "./tool-schema";

interface ClientToolDefinition {
  type: string;
  name: string;
  description?: string;
  display_name: string;
  parameters?: Record<string, unknown>;
  guide?: string;
}

export { unpack, type UnpackOptions } from "./unpack";
export { pack, type PackOptions, type InferAuthorFunc } from "./pack";
export { getSofficeEnv, runSoffice } from "./soffice";
export { mergeRuns } from "./helpers/merge-runs";
export {
  simplifyRedlines,
  getTrackedChangeAuthors,
  getAuthorsFromDocx,
  inferAuthor,
} from "./helpers/simplify-redlines";
export { BaseSchemaValidator } from "./validators/base";
export { DOCXSchemaValidator } from "./validators/docx";
export { PPTXSchemaValidator } from "./validators/pptx";
export { RedliningValidator } from "./validators/redlining";
export { validate, type ValidateOptions, type ValidateResult } from "./validate";

export { addSlide, parseSource } from "./add-slide";
export { cleanPptx, cleanUnusedFiles } from "./clean";
export { createPptxThumbnails } from "./thumbnail";
export {
  pptInitTask,
  pptWriteSource,
  pptWriteIntermediate,
  pptPackTask,
  pptUnpackTask,
  pptReadParsed,
  pptReadSource,
  handlePptTool,
  PPT_INIT_TASK_TOOL,
  PPT_WRITE_SOURCE_TOOL,
  PPT_WRITE_INTERMEDIATE_TOOL,
  PPT_PACK_TASK_TOOL,
  PPT_UNPACK_TASK_TOOL,
  PPT_READ_PARSED_TOOL,
  PPT_READ_SOURCE_TOOL,
  PPT_ADD_SLIDE_TOOL,
  PPT_CLEAN_PRESENTATION_TOOL,
  PPT_CREATE_THUMBNAILS_TOOL,
  type ToolResult as PptHandlerResult,
} from "./tools";
export { PPT_DEFAULTS } from "./configs";
export type { TaskContext, PptToolResult } from "./types";
export { PPT_WORKFLOW_PROMPT, buildPptWorkflowPrompt } from "./prompt";
export type { PptPromptOptions } from "./prompt";
export {
  PptPipeline,
  resolvePptWorkDir,
  PPT_STEP_SOURCE,
  PPT_STEP_PARSED,
  PPT_STEP_INTERMEDIATE,
  PPT_STEP_OUTPUT,
} from "./pipeline";

// Tool definitions for LLM binding
export { PPT_TOOLS } from "./tool-schema";
export const toolsList = (): ClientToolDefinition[] => PPT_TOOLS.map((tool) => ({ ...tool }));

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const PPT_SKILLS = loadSkills()
