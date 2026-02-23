/**
 * DOCX ToolDefinitions + handler for LLM tool binding.
 */

import {
  docxCreateMarkdown,
  docxCreateDocument,
  docxInitTask,
  docxWriteMarkdown,
  docxWriteXml,
  docxPack,
  docxUnpack,
  docxReadXml,
  docxReadMarkdown,
  docxExtractStyles,
  docxSetMetadata,
  docxFindReplace,
  docxInsertText,
  docxMergeDocuments,
  docxSetCharFormat,
  docxSetParaFormat,
  docxSetPageLayout,
  docxEditTableCell,
  docxInsertImage,
  docxSetHeaderFooter,
  docxInsertTable,
  docxAcceptChanges,
  docxValidate,
  type DocxToolResult,
} from './tools.js';
import { DOCX_DEFAULTS, DOCX_PAGE_SIZES, twipsToMm } from './configs.js';

interface ToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  guide?: string;
  display_name: string;
}

const DOCX_CREATE_MARKDOWN: ToolDefinition = {
  type: 'function',
  name: 'docx_create_markdown',
  display_name: 'Create DOCX from Markdown',
  description:
    'Create a new DOCX document from Markdown with rich formatting (Markdown → DOCX). ' +
    'Supports: headings (# to ######), **bold**, *italic*, bullet lists (- item), ' +
    'numbered lists (1. item), horizontal rules (---), Markdown tables (| col | col |), ' +
    'code blocks, and blockquotes (> text). ' +
    'Generates a pure XML-based DOCX file without external dependency.',
  parameters: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: 'Markdown content.',
      },
      output_path: {
        type: 'string',
        description: 'Path where the .docx file will be saved.',
      },
    },
    required: ['markdown', 'output_path'],
  },
};

const DOCX_CREATE_DOCUMENT: ToolDefinition = {
  type: 'function',
  name: 'docx_create_document',
  display_name: 'Create Structured DOCX Document',
  description:
    'Create a richly formatted DOCX document from a structured content array in a single call. ' +
    'Supports paragraphs (with heading levels, bold, italic, underline, color, fontSize, alignment, ' +
    'bullet/numbered lists, line spacing, page breaks), tables (with header row styling and custom ' +
    'column widths), images, standalone page breaks, custom fonts, margins, headers, and footers.',
  parameters: {
    type: 'object',
    properties: {
      output_path: { type: 'string', description: 'Path where the .docx file will be saved.' },
      content: {
        type: 'array',
        description: 'Array of content blocks.',
        items: {
          type: 'object',
          properties: {
            paragraph: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                runs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      bold: { type: 'boolean' },
                      italic: { type: 'boolean' },
                      underline: { type: 'boolean' },
                      color: { type: 'string', description: '"#RRGGBB"' },
                      fontSize: { type: 'number' },
                      fontName: { type: 'string' },
                      lineBreak: { type: 'boolean' },
                    },
                    required: ['text'],
                  },
                },
                heading: { type: 'number', description: 'Heading level (1-6)' },
                bold: { type: 'boolean' },
                italic: { type: 'boolean' },
                underline: { type: 'boolean' },
                color: { type: 'string' },
                fontSize: { type: 'number' },
                fontName: { type: 'string' },
                alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY'] },
                bullet: { type: 'boolean' },
                numbered: { type: 'boolean' },
                lineSpacing: { type: 'number' },
                indent: { type: 'number', description: 'First-line indent in mm' },
                marginLeft: { type: 'number' },
                marginRight: { type: 'number' },
                spacing: {
                  type: 'object',
                  properties: {
                    before: { type: 'number', description: 'mm' },
                    after: { type: 'number', description: 'mm' },
                  },
                },
                pageBreak: { type: 'boolean' },
              },
            },
            table: {
              type: 'object',
              properties: {
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                headerRow: { type: 'boolean' },
                headerBackground: { type: 'string' },
                columnWidths: { type: 'array', items: { type: 'number' }, description: 'mm' },
              },
              required: ['rows'],
            },
            image: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                width_mm: { type: 'number' },
                height_mm: { type: 'number' },
              },
              required: ['path'],
            },
            pageBreak: { type: 'boolean' },
          },
        },
      },
      page_size: { type: 'string', enum: ['a4', 'b5', 'letter'] },
      font: { type: 'string' },
      font_size: { type: 'number' },
      margin: {
        type: 'object',
        properties: {
          top: { type: 'number' },
          bottom: { type: 'number' },
          left: { type: 'number' },
          right: { type: 'number' },
        },
      },
      header: { type: 'string' },
      footer: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['output_path', 'content'],
  },
};

const DOCX_INIT_TASK: ToolDefinition = {
  type: 'function',
  name: 'docx_init_task',
  display_name: 'Initialize DOCX Task',
  description: 'Initialize a new DOCX pipeline task. Creates the folder structure.',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      task_id: { type: 'string' },
      work_dir: { type: 'string' },
    },
    required: ['session_id', 'task_id'],
  },
};

const DOCX_WRITE_MARKDOWN: ToolDefinition = {
  type: 'function',
  name: 'docx_write_markdown',
  display_name: 'Write Markdown to DOCX Pipeline',
  description: 'Save markdown content and parse it into AST.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string' },
      markdown: { type: 'string' },
    },
    required: ['task_dir', 'markdown'],
  },
};

const DOCX_WRITE_XML: ToolDefinition = {
  type: 'function',
  name: 'docx_write_xml',
  display_name: 'Generate DOCX XML',
  description: 'Generate DOCX XML files from previously parsed AST.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string' },
      page_width: { type: 'number', description: `Page width in mm (default A4: ${twipsToMm(DOCX_PAGE_SIZES.a4.width)})` },
      page_height: { type: 'number', description: `Page height in mm (default A4: ${twipsToMm(DOCX_PAGE_SIZES.a4.height)})` },
      margin_top: { type: 'number' },
      margin_bottom: { type: 'number' },
      margin_left: { type: 'number' },
      margin_right: { type: 'number' },
    },
    required: ['task_dir'],
  },
};

const DOCX_PACK: ToolDefinition = {
  type: 'function',
  name: 'docx_pack_document',
  display_name: 'Pack DOCX Archive',
  description: 'Pack the intermediate DOCX folder into a .docx ZIP archive.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string' },
    },
    required: ['task_dir'],
  },
};

const DOCX_UNPACK: ToolDefinition = {
  type: 'function',
  name: 'docx_unpack_document',
  display_name: 'Unpack DOCX Archive',
  description: 'Unpack an existing .docx file for inspection or modification.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string' },
      input_path: { type: 'string' },
    },
    required: ['task_dir', 'input_path'],
  },
};

const DOCX_READ_XML: ToolDefinition = {
  type: 'function',
  name: 'docx_read_xml',
  display_name: 'Read DOCX XML to AST',
  description: 'Parse DOCX document XML into a remark AST.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string' },
    },
    required: ['task_dir'],
  },
};

const DOCX_READ_MARKDOWN: ToolDefinition = {
  type: 'function',
  name: 'docx_read_markdown',
  display_name: 'Convert AST to Markdown',
  description: 'Convert the AST back to markdown.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string' },
    },
    required: ['task_dir'],
  },
};

const DOCX_EXTRACT_STYLES: ToolDefinition = {
  type: 'function',
  name: 'docx_extract_styles',
  display_name: 'Extract DOCX Styles',
  description: 'Extract style metadata from a DOCX document as JSON.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
    required: ['path'],
  },
};

const DOCX_SET_METADATA: ToolDefinition = {
  type: 'function',
  name: 'docx_set_metadata',
  display_name: 'Set DOCX Metadata',
  description: 'Update metadata (title, author, subject, keywords) of an existing DOCX.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      title: { type: 'string' },
      author: { type: 'string' },
      subject: { type: 'string' },
      keywords: { type: 'string' },
      output_path: { type: 'string' },
    },
    required: ['path'],
  },
};

const DOCX_FIND_REPLACE: ToolDefinition = {
  type: 'function',
  name: 'docx_find_replace',
  display_name: 'Find & Replace in DOCX',
  description: 'Find and replace text in an existing DOCX document.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      find: { type: 'string' },
      replace: { type: 'string' },
      output_path: { type: 'string' },
      case_sensitive: { type: 'boolean' },
    },
    required: ['path', 'find', 'replace'],
  },
};

const DOCX_INSERT_TEXT: ToolDefinition = {
  type: 'function',
  name: 'docx_insert_text',
  display_name: 'Insert Text into DOCX',
  description: 'Append text paragraphs to an existing DOCX document.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      text: { type: 'string' },
      output_path: { type: 'string' },
    },
    required: ['path', 'text'],
  },
};

const DOCX_MERGE_DOCUMENTS: ToolDefinition = {
  type: 'function',
  name: 'docx_merge_documents',
  display_name: 'Merge DOCX Documents',
  description: 'Merge multiple DOCX documents into a single document.',
  parameters: {
    type: 'object',
    properties: {
      input_paths: { type: 'array', items: { type: 'string' } },
      output_path: { type: 'string' },
    },
    required: ['input_paths', 'output_path'],
  },
};

const DOCX_SET_CHAR_FORMAT: ToolDefinition = {
  type: 'function',
  name: 'docx_set_char_format',
  display_name: 'Set Character Format in DOCX',
  description: 'Apply character formatting to runs in an existing DOCX.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      target_text: { type: 'string' },
      paragraph_index: { type: 'number' },
      bold: { type: 'boolean' },
      italic: { type: 'boolean' },
      underline: { type: 'boolean' },
      font_size: { type: 'number' },
      text_color: { type: 'string' },
      font_name: { type: 'string' },
      output_path: { type: 'string' },
    },
    required: ['path'],
  },
};

const DOCX_SET_PARA_FORMAT: ToolDefinition = {
  type: 'function',
  name: 'docx_set_para_format',
  display_name: 'Set Paragraph Format in DOCX',
  description: 'Apply paragraph formatting to paragraphs in an existing DOCX.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      target_text: { type: 'string' },
      paragraph_index: { type: 'number' },
      alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY'] },
      line_spacing: { type: 'number' },
      indent: { type: 'number' },
      margin_left: { type: 'number' },
      margin_right: { type: 'number' },
      space_before: { type: 'number' },
      space_after: { type: 'number' },
      output_path: { type: 'string' },
    },
    required: ['path'],
  },
};

const DOCX_SET_PAGE_LAYOUT: ToolDefinition = {
  type: 'function',
  name: 'docx_set_page_layout',
  display_name: 'Set Page Layout in DOCX',
  description: 'Set page dimensions and margins in an existing DOCX document. All values in mm.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      page_width: { type: 'number' },
      page_height: { type: 'number' },
      margin_top: { type: 'number' },
      margin_bottom: { type: 'number' },
      margin_left: { type: 'number' },
      margin_right: { type: 'number' },
      margin_header: { type: 'number' },
      margin_footer: { type: 'number' },
      output_path: { type: 'string' },
    },
    required: ['path'],
  },
};

const DOCX_EDIT_TABLE_CELL: ToolDefinition = {
  type: 'function',
  name: 'docx_edit_table_cell',
  display_name: 'Edit Table Cell in DOCX',
  description: 'Edit a specific cell in a table within a DOCX document.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      table_index: { type: 'number' },
      row: { type: 'number' },
      col: { type: 'number' },
      text: { type: 'string' },
      background_color: { type: 'string' },
      bold: { type: 'boolean' },
      output_path: { type: 'string' },
    },
    required: ['path', 'row', 'col'],
  },
};

const DOCX_INSERT_IMAGE: ToolDefinition = {
  type: 'function',
  name: 'docx_insert_image',
  display_name: 'Insert Image into DOCX',
  description: 'Insert an image file (PNG, JPG, etc.) into an existing DOCX document.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      image_path: { type: 'string' },
      width_mm: { type: 'number' },
      height_mm: { type: 'number' },
      output_path: { type: 'string' },
    },
    required: ['path', 'image_path'],
  },
};

const DOCX_SET_HEADER_FOOTER: ToolDefinition = {
  type: 'function',
  name: 'docx_set_header_footer',
  display_name: 'Set Header/Footer in DOCX',
  description: 'Set or replace the header or footer in an existing DOCX document.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      type: { type: 'string', enum: ['header', 'footer'] },
      text: { type: 'string' },
      alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT'] },
      output_path: { type: 'string' },
    },
    required: ['path', 'type', 'text'],
  },
};

const DOCX_INSERT_TABLE: ToolDefinition = {
  type: 'function',
  name: 'docx_insert_table',
  display_name: 'Insert Table into DOCX',
  description: 'Insert a new table into an existing DOCX document.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      rows: { type: 'number' },
      cols: { type: 'number' },
      headers: { type: 'array', items: { type: 'string' } },
      data: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      output_path: { type: 'string' },
    },
    required: ['path', 'rows', 'cols'],
  },
};

const DOCX_ACCEPT_CHANGES: ToolDefinition = {
  type: 'function',
  name: 'docx_accept_changes',
  display_name: 'Accept Tracked Changes in DOCX',
  description:
    'Accept all tracked changes (insertions, deletions, formatting changes) in a DOCX document. ' +
    'Pure XML-based, no soffice dependency required.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .docx file' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
    },
    required: ['path'],
  },
};

const DOCX_VALIDATE: ToolDefinition = {
  type: 'function',
  name: 'docx_validate',
  display_name: 'Validate DOCX File',
  description:
    'Validate DOCX file structure and OOXML spec compliance. ' +
    'Checks ZIP structure, Content-Types, relationships, XML well-formedness, ' +
    'namespaces, body structure, and media references.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to .docx file' },
    },
    required: ['path'],
  },
};

export const DOCX_TOOLS: ToolDefinition[] = [
  DOCX_CREATE_MARKDOWN,
  DOCX_CREATE_DOCUMENT,
  DOCX_INIT_TASK,
  DOCX_WRITE_MARKDOWN,
  DOCX_WRITE_XML,
  DOCX_PACK,
  DOCX_UNPACK,
  DOCX_READ_XML,
  DOCX_READ_MARKDOWN,
  DOCX_EXTRACT_STYLES,
  DOCX_SET_METADATA,
  DOCX_FIND_REPLACE,
  DOCX_INSERT_TEXT,
  DOCX_MERGE_DOCUMENTS,
  DOCX_SET_CHAR_FORMAT,
  DOCX_SET_PARA_FORMAT,
  DOCX_SET_PAGE_LAYOUT,
  DOCX_EDIT_TABLE_CELL,
  DOCX_INSERT_IMAGE,
  DOCX_SET_HEADER_FOOTER,
  DOCX_INSERT_TABLE,
  DOCX_ACCEPT_CHANGES,
  DOCX_VALIDATE,
];

export async function handleDocxTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<DocxToolResult> {
  switch (toolName) {
    case 'docx_create_markdown':
      return docxCreateMarkdown(args as any);
    case 'docx_create_document':
      return docxCreateDocument(args as any);
    case 'docx_init_task':
      return docxInitTask(args as any);
    case 'docx_write_markdown':
      return docxWriteMarkdown(args as any);
    case 'docx_write_xml':
      return docxWriteXml(args as any);
    case 'docx_pack_document':
      return docxPack(args as any);
    case 'docx_unpack_document':
      return docxUnpack(args as any);
    case 'docx_read_xml':
      return docxReadXml(args as any);
    case 'docx_read_markdown':
      return docxReadMarkdown(args as any);
    case 'docx_extract_styles':
      return docxExtractStyles(args as any);
    case 'docx_set_metadata':
      return docxSetMetadata(args as any);
    case 'docx_find_replace':
      return docxFindReplace(args as any);
    case 'docx_insert_text':
      return docxInsertText(args as any);
    case 'docx_merge_documents':
      return docxMergeDocuments(args as any);
    case 'docx_set_char_format':
      return docxSetCharFormat(args as any);
    case 'docx_set_para_format':
      return docxSetParaFormat(args as any);
    case 'docx_set_page_layout':
      return docxSetPageLayout(args as any);
    case 'docx_edit_table_cell':
      return docxEditTableCell(args as any);
    case 'docx_insert_image':
      return docxInsertImage(args as any);
    case 'docx_set_header_footer':
      return docxSetHeaderFooter(args as any);
    case 'docx_insert_table':
      return docxInsertTable(args as any);
    case 'docx_accept_changes':
      return docxAcceptChanges(args as any);
    case 'docx_validate':
      return docxValidate(args as any);
    default:
      return { success: false, output: `Unknown DOCX tool: ${toolName}` };
  }
}
