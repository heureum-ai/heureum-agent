/**
 * DOCX ToolDefinitions for LLM tool binding.
 * 13 tools covering read, comment, redline, validate, simplify, accept, convert, create,
 * delete-paragraph, review-changes, insert-image, convert-to-images, analyze-style.
 */

interface ToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, any>
  guide?: string
  display_name?: string
}

const DOCX_READ_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_read',
  display_name: 'Read DOCX',
  description:
    'Read a DOCX file and extract its content: paragraphs (with indices), tracked changes, and comments. Use paragraph indices for subsequent add_comment or redline operations.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
    },
    required: ['path'],
  },
}

const DOCX_ADD_COMMENT_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_add_comment',
  display_name: 'Add Comment',
  description:
    'Add a comment to one or more paragraphs in a DOCX file. Use docx_read first to get paragraph indices.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      paragraph_index: {
        type: 'integer',
        description: 'Index of the paragraph to comment on (from docx_read output)',
      },
      paragraph_index_end: {
        type: 'integer',
        description: 'End index for multi-paragraph comments. Defaults to paragraph_index.',
      },
      text: { type: 'string', description: 'Comment text' },
      author: { type: 'string', description: "Comment author name. Defaults to 'Claude'." },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.docx.',
      },
      parent_comment_id: {
        type: 'integer',
        description: 'Parent comment ID for reply comments.',
      },
    },
    required: ['path', 'paragraph_index', 'text'],
  },
}

const DOCX_REDLINE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_redline',
  display_name: 'Redline',
  description:
    'Apply tracked changes (redlines) to a DOCX file. Each change specifies text to find and its replacement. Use docx_read first to see current content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            find: { type: 'string', description: 'Text to find in the document' },
            replace: { type: 'string', description: 'Replacement text (empty string to delete)' },
            paragraph_index: {
              type: 'integer',
              description: 'Optional: restrict search to this paragraph',
            },
          },
          required: ['find', 'replace'],
        },
        description: 'List of find/replace changes to apply as tracked changes',
      },
      author: {
        type: 'string',
        description: "Author name for tracked changes. Defaults to 'Claude'.",
      },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.docx.',
      },
      match_all: {
        type: 'boolean',
        description: 'If true, replace all occurrences. Defaults to false (first match only).',
      },
    },
    required: ['path', 'changes'],
  },
}

const DOCX_VALIDATE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_validate',
  display_name: 'Validate',
  description:
    'Validate a DOCX file for structural integrity: XML validity, tracked change consistency, comment markers, and more. Optionally auto-repairs issues.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      auto_repair: {
        type: 'boolean',
        description: 'Whether to auto-repair found issues. Defaults to true.',
      },
    },
    required: ['path'],
  },
}

const DOCX_SIMPLIFY_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_simplify',
  display_name: 'Simplify',
  description:
    'Simplify a DOCX file by merging adjacent runs with identical formatting and consolidating tracked changes from the same author.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.docx.',
      },
    },
    required: ['path'],
  },
}

const DOCX_ACCEPT_CHANGES_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_accept_changes',
  display_name: 'Accept Changes',
  description:
    'Accept all tracked changes in a DOCX file using LibreOffice, producing a clean document.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.docx.',
      },
    },
    required: ['path'],
  },
}

const DOCX_CONVERT_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_convert',
  display_name: 'Convert',
  description: 'Convert a DOCX file to another format (pdf, html, txt, rtf) using LibreOffice.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      format: {
        type: 'string',
        enum: ['pdf', 'html', 'txt', 'rtf', 'docx'],
        description: 'Target format',
      },
      output_path: {
        type: 'string',
        description: 'Output file path. Defaults to {basename}.{format}.',
      },
    },
    required: ['path', 'format'],
  },
}

const DOCX_CREATE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_create',
  display_name: 'Create DOCX',
  description:
    'Create a new DOCX document from structured content blocks (paragraphs, tables, images, table of contents).',
  parameters: {
    type: 'object',
    properties: {
      output_path: { type: 'string', description: 'Path where the new .docx file will be created (must be within the working directory)' },
      content: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            paragraph: {
              type: 'object',
              description: 'A paragraph block with text and formatting options',
              properties: {
                text: { type: 'string' },
                heading: { type: 'string', enum: ['1', '2', '3'], description: 'Heading level (1, 2, or 3)' },
                bold: { type: 'boolean' },
                italic: { type: 'boolean' },
                underline: { type: 'boolean' },
                strikethrough: { type: 'boolean', description: 'Strikethrough text' },
                color: { type: 'string', description: 'Hex color without # (e.g. "FF0000" for red)' },
                font_size: { type: 'number', description: 'Font size in half-points (e.g. 24 = 12pt)' },
                alignment: { type: 'string', enum: ['left', 'center', 'right'] },
                bullet: { type: 'boolean' },
                numbered: { type: 'boolean' },
                level: { type: 'integer', description: 'Nesting level for lists (0, 1, 2)' },
                page_break: { type: 'boolean' },
                link: { type: 'string' },
                spacing: {
                  type: 'object',
                  description: 'Paragraph spacing in twips',
                  properties: {
                    before: { type: 'number' },
                    after: { type: 'number' },
                  },
                },
                indent: {
                  type: 'object',
                  description: 'Paragraph indentation in twips',
                  properties: {
                    left: { type: 'number' },
                    hanging: { type: 'number' },
                  },
                },
              },
            },
            table: {
              type: 'object',
              description: 'A table block with rows of cell text',
              properties: {
                rows: {
                  type: 'array',
                  items: { type: 'array', items: { type: 'string' } },
                },
                header_row: { type: 'boolean' },
              },
            },
            image: {
              type: 'object',
              description: 'An image block',
              properties: {
                path: { type: 'string' },
                width: { type: 'number' },
                height: { type: 'number' },
              },
              required: ['path', 'width', 'height'],
            },
            toc: {
              type: 'object',
              description: 'A table of contents block',
              properties: {
                heading: { type: 'string' },
              },
            },
          },
        },
        description: 'Ordered list of content blocks to include in the document',
      },
      page_size: {
        type: 'string',
        enum: ['letter', 'a4'],
        description: "Page size. Defaults to 'letter'.",
      },
      landscape: {
        type: 'boolean',
        description: 'Whether to use landscape orientation. Defaults to false.',
      },
      font: { type: 'string', description: "Font family. Defaults to 'Arial'." },
      font_size: { type: 'number', description: 'Default font size in half-points (e.g. 24 = 12pt).' },
      margin: {
        description: 'Page margins in inches. Single number for all sides, or object with top/right/bottom/left.',
      },
      header: { type: 'string', description: 'Optional header text for all pages.' },
      footer: { type: 'string', description: 'Optional footer text with auto page number.' },
    },
    required: ['output_path', 'content'],
  },
}

const DOCX_DELETE_PARAGRAPH_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_delete_paragraph',
  display_name: 'Delete Paragraph',
  description:
    'Delete one or more paragraphs from a DOCX file as tracked deletions. Use docx_read first to get paragraph indices.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      paragraph_indices: {
        type: 'array',
        items: { type: 'integer' },
        description: 'Indices of paragraphs to delete (from docx_read output)',
      },
      author: { type: 'string', description: "Author name for tracked changes. Defaults to 'Claude'." },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.docx.',
      },
    },
    required: ['path', 'paragraph_indices'],
  },
}

const DOCX_REVIEW_CHANGES_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_review_changes',
  display_name: 'Review Changes',
  description:
    'Reject or restore a specific tracked change in a DOCX file. Use docx_read first to see tracked changes with their indices.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      action: {
        type: 'string',
        enum: ['reject', 'restore'],
        description: 'Action to take on the tracked change',
      },
      change_index: {
        type: 'integer',
        description: 'Index of the tracked change to act on (from docx_read output)',
      },
      author: { type: 'string', description: "Author name. Defaults to 'Claude'." },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.docx.',
      },
    },
    required: ['path', 'action', 'change_index'],
  },
}

const DOCX_INSERT_IMAGE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_insert_image',
  display_name: 'Insert Image',
  description:
    'Insert an image into a DOCX file at a specific paragraph position. Use docx_read first to get paragraph indices.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      image_path: { type: 'string', description: 'Path to the image file (must be within the working directory)' },
      paragraph_index: {
        type: 'integer',
        description: 'Index of the paragraph to insert the image before',
      },
      width: { type: 'number', description: 'Image width in inches. Defaults to auto.' },
      height: { type: 'number', description: 'Image height in inches. Defaults to auto.' },
      alt_text: { type: 'string', description: 'Alt text for the image.' },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.docx.',
      },
    },
    required: ['path', 'image_path', 'paragraph_index'],
  },
}

const DOCX_CONVERT_TO_IMAGES_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_convert_to_images',
  display_name: 'Convert to Images',
  description:
    'Convert a DOCX file to a series of page images (JPEG or PNG) using LibreOffice and pdftoppm.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file (must be within the working directory)' },
      format: {
        type: 'string',
        enum: ['jpeg', 'png'],
        description: "Image format. Defaults to 'jpeg'.",
      },
      dpi: { type: 'integer', description: 'DPI resolution. Defaults to 200.' },
      output_dir: {
        type: 'string',
        description: 'Output directory for images within the working directory. Defaults to a directory next to the input file.',
      },
    },
    required: ['path'],
  },
}

const DOCX_ANALYZE_STYLE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'docx_analyze_style',
  display_name: 'Analyze Style',
  description:
    'Analyze the visual style of a DOCX document and return a compact profile: page layout, fonts, colors, heading styles, body text patterns, list/table formatting, and theme details. Use before docx_create to replicate a document\'s look-and-feel.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .docx file to analyze' },
    },
    required: ['path'],
  },
}

export const DOCX_TOOLS: ToolDefinition[] = [
  DOCX_READ_TOOL,
  DOCX_ADD_COMMENT_TOOL,
  DOCX_REDLINE_TOOL,
  DOCX_VALIDATE_TOOL,
  DOCX_SIMPLIFY_TOOL,
  DOCX_ACCEPT_CHANGES_TOOL,
  DOCX_CONVERT_TOOL,
  DOCX_CREATE_TOOL,
  DOCX_DELETE_PARAGRAPH_TOOL,
  DOCX_REVIEW_CHANGES_TOOL,
  DOCX_INSERT_IMAGE_TOOL,
  DOCX_CONVERT_TO_IMAGES_TOOL,
  DOCX_ANALYZE_STYLE_TOOL,
]
