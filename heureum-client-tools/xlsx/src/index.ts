import { XLSX_TOOLS } from "./tool-schema";

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
export { recalc, type RecalcResult } from "./recalc";
export { XLSX_DEFAULTS } from "./configs";
export type { TaskContext, XlsxToolResult } from "./types";
export {
  XLSX_WORKFLOW_PROMPT,
  buildXlsxWorkflowPrompt,
  XLSX_STYLE_EXTRACTION_PROMPT,
  buildXlsxStyleExtractionPrompt,
  buildXlsxStyleGuidePrompt,
} from "./prompt";
export type {
  XlsxPromptOptions,
  XlsxStyleExtractionPromptOptions,
  XlsxStyleGuidePromptOptions,
} from "./prompt";
export {
  XlsxPipeline,
  resolveXlsxWorkDir,
  XLSX_STEP_SOURCE,
  XLSX_STEP_PARSED,
  XLSX_STEP_INTERMEDIATE,
  XLSX_STEP_OUTPUT,
} from "./pipeline";

// Tool implementations
export {
  xlsxRead,
  xlsxExtractStyles,
  parseTemplateStyle,
  xlsxUpdateCells,
  xlsxInsertRows,
  xlsxDeleteRows,
  xlsxInsertColumns,
  xlsxDeleteColumns,
  xlsxFormatCells,
  xlsxCreate,
  xlsxManageSheets,
  xlsxConvert,
  xlsxMergeCells,
  xlsxSortData,
  xlsxAutoFilter,
  xlsxDataValidation,
  xlsxConditionalFormatting,
  xlsxSetSheetProperties,
  xlsxProtectSheet,
  xlsxAddImage,
  xlsxNamedRanges,
  xlsxRemoveDuplicates,
  xlsxFindReplace,
  xlsxHyperlink,
  xlsxAddChart,
  xlsxPivotSummary,
  // P4/P5
  xlsxTable,
  xlsxComment,
  xlsxPageSetup,
  xlsxHeaderFooter,
  xlsxCsvIo,
  xlsxWorkbookProperties,
  xlsxOutlineGroup,
  xlsxSheetState,
  xlsxRowColVisibility,
  xlsxCellProtection,
  xlsxDuplicateRow,
  xlsxBackgroundImage,
  xlsxFormula,
  xlsxInitTask,
  xlsxWriteSource,
  xlsxWriteIntermediate,
  xlsxPackTask,
  xlsxUnpackTask,
  xlsxReadParsed,
  xlsxReadSource,
  type ToolResult,
} from "./tools";

// Tool definitions for LLM binding
export { XLSX_TOOLS, handleXlsxTool, type ToolResult as XlsxHandlerResult } from "./tool-schema";
export const toolsList = (): ClientToolDefinition[] => XLSX_TOOLS.map((tool) => ({ ...tool }));

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const XLSX_SKILLS = loadSkills()
