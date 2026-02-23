/**
 * PDF ToolDefinitions for LLM tool binding.
 * Includes core PDF manipulation tools plus step-based pipeline tools (init/write/pack/unpack/read).
 */

interface ToolDefinition {
  type: 'function'
  name: string
  display_name: string
  description?: string
  parameters?: Record<string, any>
  guide?: string
}

const PDF_INIT_TASK: ToolDefinition = {
  type: "function",
  name: "pdf_init_task",
  display_name: "Init PDF Pipeline Task",
  description:
    "Initialize a persisted PDF pipeline task with step folders (01_source, 02_parsed, 03_intermediate, 04_output).",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session identifier" },
      task_id: { type: "string", description: "Task identifier" },
      work_dir: { type: "string", description: "Optional base working directory" },
    },
    required: ["session_id", "task_id"],
  },
}

const PDF_WRITE_SOURCE: ToolDefinition = {
  type: "function",
  name: "pdf_write_source",
  display_name: "Write PDF Source",
  description: "Write source PDF into 01_source/input.pdf for pipeline processing.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from pdf_init_task" },
      input_path: { type: "string", description: "Path to input PDF" },
    },
    required: ["task_dir", "input_path"],
  },
}

const PDF_WRITE_INTERMEDIATE: ToolDefinition = {
  type: "function",
  name: "pdf_write_intermediate",
  display_name: "Build PDF Intermediate",
  description:
    "Copy source PDF into 03_intermediate/working.pdf (optionally from input_path directly).",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from pdf_init_task" },
      input_path: { type: "string", description: "Optional input PDF path (also updates source)" },
    },
    required: ["task_dir"],
  },
}

const PDF_PACK: ToolDefinition = {
  type: "function",
  name: "pdf_pack_document",
  display_name: "Pack PDF Output",
  description:
    "Finalize pipeline output by copying working/source PDF into output (defaults to 04_output/result.pdf).",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from pdf_init_task" },
      output_path: { type: "string", description: "Optional output PDF path" },
    },
    required: ["task_dir"],
  },
}

const PDF_UNPACK: ToolDefinition = {
  type: "function",
  name: "pdf_unpack_document",
  display_name: "Unpack PDF Into Pipeline",
  description:
    "Load an existing PDF into pipeline source/intermediate locations for subsequent processing.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from pdf_init_task" },
      input_path: { type: "string", description: "Path to input PDF" },
    },
    required: ["task_dir", "input_path"],
  },
}

const PDF_READ_PARSED: ToolDefinition = {
  type: "function",
  name: "pdf_read_parsed",
  display_name: "Read PDF Parsed Data",
  description:
    "Extract metadata/text from working PDF and store combined parsed output in 02_parsed/parsed.json.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from pdf_init_task" },
      pages: { type: "array", items: { type: "integer" }, description: "Optional page list (1-based) for text extraction" },
    },
    required: ["task_dir"],
  },
}

const PDF_READ_SOURCE: ToolDefinition = {
  type: "function",
  name: "pdf_read_source",
  display_name: "Read PDF Source Metadata",
  description:
    "Read and return source PDF metadata from 01_source/input.pdf, including page count, per-page dimensions/rotation, and document-level fields such as title, author, subject, creator, and timestamps.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from pdf_init_task" },
    },
    required: ["task_dir"],
  },
}

const PDF_CHECK_FILLABLE_FIELDS: ToolDefinition = {
  type: 'function',
  name: 'pdf_check_fillablefields',
  display_name: 'Check Fillable Fields',
  description:
    'Check whether a PDF has fillable form fields. Returns a message indicating if the PDF contains fillable fields or not. Use this before pdf_extract_formfields to determine if the PDF supports direct form filling.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file' },
    },
    required: ['path'],
  },
}

const PDF_EXTRACT_FORM_FIELDS: ToolDefinition = {
  type: 'function',
  name: 'pdf_extract_formfields',
  display_name: 'Extract Form Fields',
  description:
    'Extract form field information (field IDs, types, positions, options) from a fillable PDF and write it to a JSON file. Use pdf_check_fillablefields first to confirm the PDF has fillable fields.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file' },
      output_json_path: { type: 'string', description: 'Path where the field info JSON will be written' },
    },
    required: ['path', 'output_json_path'],
  },
}

const PDF_FILL_FIELDS: ToolDefinition = {
  type: 'function',
  name: 'pdf_fill_formfields',
  display_name: 'Fill Form Fields',
  description:
    'Fill fillable form fields in a PDF using values from a JSON file. The JSON should contain an array of objects with field_id, page, and value. Use pdf_extract_formfields first to get available field IDs and types.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      field_values_json_path: { type: 'string', description: 'Path to JSON file containing field values (array of {field_id, page, value})' },
      output_path: { type: 'string', description: 'Path where the filled PDF will be saved' },
    },
    required: ['path', 'field_values_json_path', 'output_path'],
  },
}

const PDF_FILL_ANNOTATIONS: ToolDefinition = {
  type: 'function',
  name: 'pdf_fill_annotations',
  display_name: 'Fill Annotations',
  description:
    'Fill a non-fillable PDF form by adding text annotations at specified bounding boxes. Use this for PDFs without fillable fields. Use pdf_extract_formstructure first to get field positions and bounding boxes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      fields_json_path: { type: 'string', description: 'Path to JSON file with field positions and text (from pdf_extract_formstructure output)' },
      output_path: { type: 'string', description: 'Path where the annotated PDF will be saved' },
      font_path: { type: 'string', description: 'Path to a .ttf/.otf font file for CJK/non-ASCII text rendering. Required when text contains non-ASCII characters.' },
    },
    required: ['path', 'fields_json_path', 'output_path'],
  },
}

const PDF_EXTRACT_FORM_STRUCTURE: ToolDefinition = {
  type: 'function',
  name: 'pdf_extract_formstructure',
  display_name: 'Extract Form Structure',
  description:
    'Extract visual form structure (labels, lines, checkboxes, row boundaries, bounding boxes) from a PDF and write it to a JSON file. Use this for non-fillable PDFs to get field positions before using pdf_fill_annotations.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file' },
      output_json_path: { type: 'string', description: 'Path where the structure JSON will be written' },
    },
    required: ['path', 'output_json_path'],
  },
}

const PDF_CHECK_BOUNDING_BOXES: ToolDefinition = {
  type: 'function',
  name: 'pdf_check_boundingboxes',
  display_name: 'Check Bounding Boxes',
  description:
    'Validate that bounding boxes in a form fields JSON do not overlap and are properly sized. Use after pdf_extract_formstructure to verify field positions before filling with pdf_fill_annotations.',
  parameters: {
    type: 'object',
    properties: {
      fields_json_path: { type: 'string', description: 'Path to the form fields JSON file (from pdf_extract_formstructure output)' },
    },
    required: ['fields_json_path'],
  },
}

const PDF_CREATE_VALIDATION_IMAGE: ToolDefinition = {
  type: 'function',
  name: 'pdf_create_validationimage',
  display_name: 'Create Validation Image',
  description:
    'Draw bounding box outlines on a page image to visually verify field positions. Use pdf_convert_images first to generate page images, then use this to overlay bounding boxes for visual inspection.',
  parameters: {
    type: 'object',
    properties: {
      page_number: { type: 'integer', description: 'Page number (1-based) to validate' },
      fields_json_path: { type: 'string', description: 'Path to the form fields JSON file (from pdf_extract_formstructure output)' },
      input_image_path: { type: 'string', description: 'Path to the page image (PNG, JPG, or BMP; from pdf_convert_images output)' },
      output_image_path: { type: 'string', description: 'Path where the annotated image will be saved' },
    },
    required: ['page_number', 'fields_json_path', 'input_image_path', 'output_image_path'],
  },
}

const PDF_CONVERT_TO_IMAGES: ToolDefinition = {
  type: 'function',
  name: 'pdf_convert_images',
  display_name: 'Convert to Images',
  description:
    'Convert a PDF to a series of PNG page images. Each page is saved as a separate image file in the output directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file' },
      output_directory: { type: 'string', description: 'Directory where page images will be saved' },
      max_dim: { type: 'integer', description: 'Maximum dimension (width or height) in pixels. Defaults to 1000.' },
    },
    required: ['path', 'output_directory'],
  },
}

const PDF_GET_PAGE_COUNT: ToolDefinition = {
  type: 'function',
  name: 'pdf_get_pagecount',
  display_name: 'Get Page Count',
  description:
    'Get the number of pages in a PDF file. Returns JSON with page_count.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file' },
    },
    required: ['path'],
  },
}

const PDF_GET_METADATA: ToolDefinition = {
  type: 'function',
  name: 'pdf_get_metadata',
  display_name: 'Get Metadata',
  description:
    'Extract metadata from a PDF file. Returns JSON with page_count, per-page sizes and rotation, title, author, subject, creator, producer, and creation/modification dates.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file' },
    },
    required: ['path'],
  },
}

const PDF_EXTRACT_TEXT: ToolDefinition = {
  type: 'function',
  name: 'pdf_extract_text',
  display_name: 'Extract Text',
  description:
    'Extract text content from a PDF file. Can extract from specific pages or all pages. Text is returned directly or saved to a file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file' },
      output_text_path: { type: 'string', description: 'Optional path to save extracted text. If omitted, text is returned directly.' },
      pages: { type: 'array', items: { type: 'integer' }, description: 'Optional list of page numbers (1-based) to extract. If omitted, all pages are extracted.' },
    },
    required: ['path'],
  },
}

const PDF_EXTRACT_STYLES: ToolDefinition = {
  type: 'function',
  name: 'pdf_extract_styles',
  display_name: 'Extract Styles',
  description:
    'Extract a structured style profile from PDF text content: per-page text runs with bbox/font/size/rotation (and color when available), plus line grouping summaries.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file' },
      pages: { type: 'array', items: { type: 'integer' }, description: 'Optional list of page numbers (1-based). If omitted, all pages are analyzed.' },
      include_runs: { type: 'boolean', description: 'Include run-level array per page. Defaults to true.' },
      max_runs_per_page: { type: 'integer', description: 'Maximum run entries returned per page. Defaults to 5000.' },
    },
    required: ['path'],
  },
}

const PDF_MERGE: ToolDefinition = {
  type: 'function',
  name: 'pdf_merge_documents',
  display_name: 'Merge Documents',
  description:
    'Merge multiple PDF files into a single PDF. Files are combined in the order provided.',
  parameters: {
    type: 'object',
    properties: {
      input_paths: { type: 'array', items: { type: 'string' }, description: 'Array of paths to PDF files to merge, in order' },
      output_path: { type: 'string', description: 'Path where the merged PDF will be saved' },
    },
    required: ['input_paths', 'output_path'],
  },
}

const PDF_SPLIT: ToolDefinition = {
  type: 'function',
  name: 'pdf_split_document',
  display_name: 'Split Document',
  description:
    'Split a PDF into multiple files based on page ranges. Each range produces a separate output file. Use pdf_get_pagecount first to determine the total number of pages.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      page_ranges: { type: 'array', items: { type: 'string' }, description: 'Array of page range strings (e.g., ["1-3", "4,5", "6-10"])' },
      output_directory: { type: 'string', description: 'Directory where split PDF files will be saved' },
    },
    required: ['path', 'page_ranges', 'output_directory'],
  },
}

const PDF_ROTATE_PAGES: ToolDefinition = {
  type: 'function',
  name: 'pdf_rotate_pages',
  display_name: 'Rotate Pages',
  description:
    'Rotate pages in a PDF by a specified angle. Rotation is additive to existing page rotation. Can rotate specific pages or all pages.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      rotation: { type: 'integer', description: 'Rotation angle in degrees (90, 180, 270, or -90, -180, -270)' },
      pages: { type: 'array', items: { type: 'integer' }, description: 'Optional list of page numbers (1-based) to rotate. If omitted, all pages are rotated.' },
      output_path: { type: 'string', description: 'Optional output path. If omitted, the input file is overwritten.' },
    },
    required: ['path', 'rotation'],
  },
}

const PDF_REMOVE_PAGES: ToolDefinition = {
  type: 'function',
  name: 'pdf_remove_pages',
  display_name: 'Remove Pages',
  description:
    'Remove specific pages from a PDF and save the result. Use pdf_get_pagecount first to determine the total number of pages.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      page_numbers: { type: 'array', items: { type: 'integer' }, description: 'List of page numbers (1-based) to remove' },
      output_path: { type: 'string', description: 'Path where the resulting PDF will be saved' },
    },
    required: ['path', 'page_numbers', 'output_path'],
  },
}

const PDF_FLATTEN_FORM: ToolDefinition = {
  type: 'function',
  name: 'pdf_flatten_form',
  display_name: 'Flatten Form',
  description:
    'Flatten all form fields in a PDF, making them non-editable and part of the page content. Use after pdf_fill_formfields to lock in filled values.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      output_path: { type: 'string', description: 'Path where the flattened PDF will be saved' },
    },
    required: ['path', 'output_path'],
  },
}

const PDF_ADD_WATERMARK: ToolDefinition = {
  type: 'function',
  name: 'pdf_add_watermark',
  display_name: 'Add Watermark',
  description:
    'Add a text watermark to PDF pages. The watermark is rendered diagonally across the center of each page with configurable font size, opacity, rotation, and color.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      output_path: { type: 'string', description: 'Path where the watermarked PDF will be saved' },
      text: { type: 'string', description: 'Watermark text to display (e.g., "CONFIDENTIAL", "DRAFT")' },
      font_path: { type: 'string', description: 'Path to a .ttf/.otf font file for CJK/non-ASCII watermark text.' },
      font_size: { type: 'number', description: 'Font size for watermark text. Defaults to 50.' },
      opacity: { type: 'number', description: 'Opacity of the watermark (0-1). Defaults to 0.3.' },
      rotation: { type: 'number', description: 'Rotation angle in degrees. Defaults to -45.' },
      color: { type: 'string', description: 'Hex color code (without #) for watermark text. Defaults to "888888".' },
      pages: { type: 'array', items: { type: 'integer' }, description: 'Optional list of page numbers (1-based). If omitted, watermark is added to all pages.' },
    },
    required: ['path', 'output_path', 'text'],
  },
}

const PDF_ADD_HIGHLIGHT: ToolDefinition = {
  type: 'function',
  name: 'pdf_add_highlight',
  display_name: 'Add Highlight',
  description:
    'Add highlight annotations to a PDF at specified rectangles. Each annotation specifies a page, bounding box, and optional color.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      annotations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            page_number: { type: 'integer', description: 'Page number (1-based)' },
            rect: { type: 'array', items: { type: 'number' }, description: 'Bounding box [x1, y1, x2, y2] in PDF coordinates' },
            color: { type: 'string', description: 'Hex color code (without #). Defaults to "FFFF00" (yellow).' },
          },
          required: ['page_number', 'rect'],
        },
        description: 'Array of highlight annotations to add',
      },
      output_path: { type: 'string', description: 'Path where the annotated PDF will be saved' },
    },
    required: ['path', 'annotations', 'output_path'],
  },
}

const PDF_ADD_STAMP: ToolDefinition = {
  type: 'function',
  name: 'pdf_add_stamp',
  display_name: 'Add Stamp',
  description:
    'Add stamp annotations to a PDF. Supports 14 standard stamp types: Approved, Experimental, NotApproved, AsIs, Expired, NotForPublicRelease, Confidential, Final, Sold, Departmental, ForComment, TopSecret, Draft, ForPublicRelease.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file' },
      stamps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            page_number: { type: 'integer', description: 'Page number (1-based)' },
            rect: { type: 'array', items: { type: 'number' }, description: 'Bounding box [x1, y1, x2, y2] in PDF coordinates' },
            stamp_name: { type: 'string', description: 'Standard stamp name: Approved, Experimental, NotApproved, AsIs, Expired, NotForPublicRelease, Confidential, Final, Sold, Departmental, ForComment, TopSecret, Draft, ForPublicRelease' },
          },
          required: ['page_number', 'rect', 'stamp_name'],
        },
        description: 'Array of stamp annotations to add',
      },
      output_path: { type: 'string', description: 'Path where the stamped PDF will be saved' },
    },
    required: ['path', 'stamps', 'output_path'],
  },
}

export const PDF_TOOLS: ToolDefinition[] = [
  PDF_INIT_TASK,
  PDF_WRITE_SOURCE,
  PDF_WRITE_INTERMEDIATE,
  PDF_PACK,
  PDF_UNPACK,
  PDF_READ_PARSED,
  PDF_READ_SOURCE,
  PDF_CHECK_FILLABLE_FIELDS,
  PDF_EXTRACT_FORM_FIELDS,
  PDF_FILL_FIELDS,
  PDF_FILL_ANNOTATIONS,
  PDF_EXTRACT_FORM_STRUCTURE,
  PDF_CHECK_BOUNDING_BOXES,
  PDF_CREATE_VALIDATION_IMAGE,
  PDF_CONVERT_TO_IMAGES,
  PDF_GET_PAGE_COUNT,
  PDF_GET_METADATA,
  PDF_EXTRACT_TEXT,
  PDF_EXTRACT_STYLES,
  PDF_MERGE,
  PDF_SPLIT,
  PDF_ROTATE_PAGES,
  PDF_REMOVE_PAGES,
  PDF_FLATTEN_FORM,
  PDF_ADD_WATERMARK,
  PDF_ADD_HIGHLIGHT,
  PDF_ADD_STAMP,
]
