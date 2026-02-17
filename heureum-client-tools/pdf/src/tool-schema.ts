/**
 * PDF ToolDefinitions for LLM tool binding.
 * 8 tools covering form inspection, filling, structure extraction, and image conversion.
 */

interface ToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, any>
  guide?: string
}

const PDF_CHECK_FILLABLE_FIELDS: ToolDefinition = {
  type: 'function',
  name: 'pdf_check_fillable_fields',
  description: 'Check whether a PDF has fillable form fields.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file (must be within the working directory)' },
    },
    required: ['path'],
  },
}

const PDF_EXTRACT_FORM_FIELDS: ToolDefinition = {
  type: 'function',
  name: 'pdf_extract_form_fields',
  description: 'Extract form field information from a fillable PDF and write it to a JSON file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file (must be within the working directory)' },
      output_json_path: { type: 'string', description: 'Path where the field info JSON will be written (must be within the working directory)' },
    },
    required: ['path', 'output_json_path'],
  },
}

const PDF_FILL_FIELDS: ToolDefinition = {
  type: 'function',
  name: 'pdf_fill_fields',
  description: 'Fill fillable form fields in a PDF using values from a JSON file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file (must be within the working directory)' },
      field_values_json_path: { type: 'string', description: 'Path to JSON file containing field values (must be within the working directory)' },
      output_path: { type: 'string', description: 'Path where the filled PDF will be saved (must be within the working directory)' },
    },
    required: ['path', 'field_values_json_path', 'output_path'],
  },
}

const PDF_FILL_ANNOTATIONS: ToolDefinition = {
  type: 'function',
  name: 'pdf_fill_annotations',
  description: 'Fill a non-fillable PDF form by adding text annotations at specified bounding boxes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the input PDF file (must be within the working directory)' },
      fields_json_path: { type: 'string', description: 'Path to JSON file with field positions and text (must be within the working directory)' },
      output_path: { type: 'string', description: 'Path where the annotated PDF will be saved (must be within the working directory)' },
    },
    required: ['path', 'fields_json_path', 'output_path'],
  },
}

const PDF_EXTRACT_FORM_STRUCTURE: ToolDefinition = {
  type: 'function',
  name: 'pdf_extract_form_structure',
  description: 'Extract visual form structure (labels, lines, checkboxes, row boundaries) from a PDF.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file (must be within the working directory)' },
      output_json_path: { type: 'string', description: 'Path where the structure JSON will be written (must be within the working directory)' },
    },
    required: ['path', 'output_json_path'],
  },
}

const PDF_CHECK_BOUNDING_BOXES: ToolDefinition = {
  type: 'function',
  name: 'pdf_check_bounding_boxes',
  description: 'Validate that bounding boxes in a form fields JSON do not overlap and are properly sized.',
  parameters: {
    type: 'object',
    properties: {
      fields_json_path: { type: 'string', description: 'Path to the form fields JSON file (must be within the working directory)' },
    },
    required: ['fields_json_path'],
  },
}

const PDF_CREATE_VALIDATION_IMAGE: ToolDefinition = {
  type: 'function',
  name: 'pdf_create_validation_image',
  description: 'Draw bounding box outlines on a page image to visually verify field positions.',
  parameters: {
    type: 'object',
    properties: {
      page_number: { type: 'integer', description: 'Page number (1-based) to validate' },
      fields_json_path: { type: 'string', description: 'Path to the form fields JSON file (must be within the working directory)' },
      input_image_path: { type: 'string', description: 'Path to the page image (PNG, JPG, or BMP, must be within the working directory)' },
      output_image_path: { type: 'string', description: 'Path where the annotated image will be saved (must be within the working directory)' },
    },
    required: ['page_number', 'fields_json_path', 'input_image_path', 'output_image_path'],
  },
}

const PDF_CONVERT_TO_IMAGES: ToolDefinition = {
  type: 'function',
  name: 'pdf_convert_to_images',
  description: 'Convert a PDF to a series of PNG page images using pdftoppm.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the PDF file (must be within the working directory)' },
      output_directory: { type: 'string', description: 'Directory where page images will be saved (must be within the working directory)' },
      max_dim: { type: 'integer', description: 'Maximum dimension (width or height) in pixels. Defaults to 1000.' },
    },
    required: ['path', 'output_directory'],
  },
}

export const PDF_TOOLS: ToolDefinition[] = [
  PDF_CHECK_FILLABLE_FIELDS,
  PDF_EXTRACT_FORM_FIELDS,
  PDF_FILL_FIELDS,
  PDF_FILL_ANNOTATIONS,
  PDF_EXTRACT_FORM_STRUCTURE,
  PDF_CHECK_BOUNDING_BOXES,
  PDF_CREATE_VALIDATION_IMAGE,
  PDF_CONVERT_TO_IMAGES,
]
