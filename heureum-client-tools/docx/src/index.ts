import { DOCX_TOOLS } from './tool-schema.js';

interface ClientToolDefinition {
  type: string;
  name: string;
  description?: string;
  display_name: string;
  parameters?: Record<string, unknown>;
  guide?: string;
}

export { createDocx } from './writer.js';
export { createDocument } from './create-document.js';
export { DOCX_DEFAULTS, DOCX_PAGE_SIZES } from './configs.js';
export {
  mmToTwips,
  twipsToMm,
  mmToEmu,
  emuToMm,
  ptToHalfPt,
  halfPtToPt,
} from './configs.js';
export type { DocxPageSizeKey } from './configs.js';
export type {
  DocxTextRun,
  DocxParagraph,
  DocxTable,
  DocxImage,
  DocxContentBlock,
  DocxCreateDocumentParams,
} from './create-document.js';
export type {
  DocxDocumentOptions,
  DocxToolResult,
  TaskContext,
  DocxXmlMap,
  DocxMetadata,
  PipelineStepOptions,
} from './types.js';
export { DOCX_TOOLS, handleDocxTool } from './tool-schema.js';
export const toolsList = (): ClientToolDefinition[] => DOCX_TOOLS.map((tool) => ({ ...tool }));
export { DocxPipeline, resolveWorkDir } from './pipeline.js';
export { parseDocumentXml, parseCoreXml, unescapeXml } from './reader.js';
export { acceptTrackedChanges, acceptChangesInXml } from './tracked-changes.js';
export {
  DOCX_WORKFLOW_PROMPT,
  buildDocxWorkflowPrompt,
  DOCX_SKILL_PROMPT,
  buildDocxSkillPrompt,
} from './prompt.js';
export type { DocxPromptOptions } from './prompt.js';
export {
  docxExtractStyles,
  docxCreateMarkdown,
  docxCreateDocument,
  docxValidate,
} from './tools.js';
export { validateDocx } from './validate.js';
export type { DocxValidationResult } from './validate.js';

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const DOCX_SKILLS = loadSkills()
