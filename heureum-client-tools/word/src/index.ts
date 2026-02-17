// Core operations
export { unpack, type UnpackOptions } from "./unpack";
export { pack, type PackOptions, type InferAuthorFunc } from "./pack";
export { addComment } from "./comment";
export { acceptChanges } from "./accept-changes";

// LibreOffice integration
export { getSofficeEnv, runSoffice } from "./soffice";

// Helpers
export { mergeRuns } from "./helpers/merge-runs";
export {
  simplifyRedlines,
  getTrackedChangeAuthors,
  getAuthorsFromDocx,
  inferAuthor,
} from "./helpers/simplify-redlines";

// Validators
export { BaseSchemaValidator } from "./validators/base";
export { DOCXSchemaValidator } from "./validators/docx";
export { PPTXSchemaValidator } from "./validators/pptx";
export { RedliningValidator } from "./validators/redlining";

// Validation convenience function
export { validate, type ValidateOptions, type ValidateResult } from "./validate";

// Comment templates
export { COMMENT_MARKER_TEMPLATE, REPLY_MARKER_TEMPLATE } from "./comment";

// High-level tool wrappers
export {
  docxRead,
  docxAddComment,
  docxRedline,
  docxValidate,
  docxSimplify,
  docxAcceptChanges,
  docxConvert,
  docxCreate,
  docxDeleteParagraph,
  docxReviewChanges,
  docxInsertImage,
  docxConvertToImages,
  handleDocxTool,
  type ToolResult,
  type CreateParagraph,
  type CreateTable,
  type CreateImage,
  type CreateContentBlock,
} from "./tools";

// Tool definitions for LLM binding
export { DOCX_TOOLS } from "./tool-schema";
