import { HWPX_TOOLS } from './tool-schema.js';

interface ClientToolDefinition {
  type: string;
  name: string;
  description?: string;
  display_name: string;
  parameters?: Record<string, unknown>;
  guide?: string;
}

export { createHwpx } from './writer.js';
export { createDocument } from './create-document.js';
export { HWPX_DEFAULTS, HWPX_PAGE_SIZES } from './configs.js';
export type { HwpxPageSizeKey } from './configs.js';
export type {
  HwpxTextRun,
  HwpxParagraph,
  HwpxTable,
  HwpxImage,
  HwpxContentBlock,
  HwpxCreateDocumentParams,
} from './create-document.js';
export type {
  HwpxDocumentOptions,
  HwpxToolResult,
  TaskContext,
  HwpxXmlMap,
  HwpxMetadata,
  PipelineStepOptions,
} from './types.js';
export { HWPX_TOOLS, handleHwpxTool } from './tool-schema.js';
export const toolsList = (): ClientToolDefinition[] => HWPX_TOOLS.map((tool) => ({ ...tool }));
export { HwpxPipeline, resolveWorkDir } from './pipeline.js';
export { parseSectionXml, parseContentHpf, unescapeXml } from './reader.js';
export {
  OFFICIAL_HWPX_WORKFLOW_PROMPT,
  buildOfficialHwpxWorkflowPrompt,
  OFFICIAL_HWPX_SKILL_PROMPT,
  buildOfficialHwpxSkillPrompt,
  HWPX_STYLE_EXTRACTION_PROMPT,
  buildHwpxStyleExtractionPrompt,
  buildHwpxStyleGuidePrompt,
} from './prompt.js';
export type {
  HwpxPromptOptions,
  HwpxStyleExtractionPromptOptions,
  HwpxStyleGuidePromptOptions,
} from './prompt.js';
export { recreateOfficialDocument } from './official-recreate.js';
export type {
  RecreateOfficialArgs,
  RecreateOfficialResult,
} from './official-recreate.js';
export { hwpxExtractStyles, parseTemplateStyle } from './tools.js';

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const HWPX_SKILLS = loadSkills()
