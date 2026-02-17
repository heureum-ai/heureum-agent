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

export { recalc, type RecalcResult } from "./recalc";

// Tool definitions for LLM binding
export { XLSX_TOOLS, handleXlsxTool, type ToolResult as XlsxHandlerResult } from "./tool-schema";
