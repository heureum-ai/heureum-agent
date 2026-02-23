import { PDF_TOOLS } from "./tool-schema";

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
  checkFillableFields,
  extractFormFieldInfo,
  getFieldInfo,
  fillFillableFields,
  fillPdfFormWithAnnotations,
  extractFormStructure,
  checkBoundingBoxes,
  createValidationImage,
  convertPdfToImages,
  getPageCount,
  getMetadata,
  extractStyles,
  parseTemplateStyle,
  extractText,
  mergePdfs,
  splitPdf,
  rotatePdfPages,
  removePages,
  flattenForm,
  addWatermark,
  addHighlightAnnotation,
  addStampAnnotation,
  pdfInitTask,
  pdfWriteSource,
  pdfWriteIntermediate,
  pdfPackTask,
  pdfUnpackTask,
  pdfReadParsed,
  pdfReadSource,
  handlePdfTool,
  type PdfToolResult,
  type PdfHandlerResult,
  type FieldInfo,
} from "./tools";

// Tool definitions for LLM binding
export { PDF_TOOLS } from "./tool-schema";
export const toolsList = (): ClientToolDefinition[] => PDF_TOOLS.map((tool) => ({ ...tool }));
export { PDF_DEFAULTS } from "./configs";
export type { TaskContext } from "./types";
export {
  PDF_WORKFLOW_PROMPT,
  buildPdfWorkflowPrompt,
  PDF_STYLE_EXTRACTION_PROMPT,
  buildPdfStyleExtractionPrompt,
  buildPdfStyleGuidePrompt,
} from "./prompt";
export type {
  PdfPromptOptions,
  PdfStyleExtractionPromptOptions,
  PdfStyleGuidePromptOptions,
} from "./prompt";

export {
  PdfPipeline,
  resolvePdfWorkDir,
  PDF_STEP_SOURCE,
  PDF_STEP_PARSED,
  PDF_STEP_INTERMEDIATE,
  PDF_STEP_OUTPUT,
} from "./pipeline";

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const PDF_SKILLS = loadSkills()
