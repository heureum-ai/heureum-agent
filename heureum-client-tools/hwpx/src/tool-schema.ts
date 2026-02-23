/**
 * HWPX ToolDefinitions + handler for LLM tool binding.
 */

import {
  hwpxInitTask,
  hwpxWriteMarkdown,
  hwpxWriteXml,
  hwpxPack,
  hwpxUnpack,
  hwpxReadXml,
  hwpxReadMarkdown,
  hwpxExtractStyles,
  parseTemplateStyle,
  hwpxSetMetadata,
  hwpxFindReplace,
  hwpxInsertText,
  hwpxMergeDocuments,
  hwpxSetCharFormat,
  hwpxSetParaFormat,
  hwpxSetPageLayout,
  hwpxEditTableCell,
  hwpxInsertImage,
  hwpxSetHeaderFooter,
  hwpxInsertTable,
  type HwpxToolResult,
} from './tools.js';
import { HWPX_DEFAULTS, HWPX_PAGE_SIZES } from './configs.js';
import { hwpUnitToMm } from './formatter.js';

interface ToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  guide?: string;
  display_name: string;
}

const HWPX_CREATE_DOCUMENT: ToolDefinition = {
  type: 'function',
  name: 'hwpx_create_document',
  display_name: 'Create Structured HWPX Document',
  description:
    'Create a richly formatted HWPX document from a structured content array in a single call. ' +
    'Supports paragraphs (with heading levels, bold, italic, underline, color, fontSize, alignment, ' +
    'bullet/numbered lists, line spacing, page breaks), tables (with header row styling and custom ' +
    'column widths), images, standalone page breaks, custom fonts, margins, headers, and footers. ' +
    'This is the recommended tool for creating well-formatted documents without multiple editing calls.',
  parameters: {
    type: 'object',
    properties: {
      output_path: {
        type: 'string',
        description: 'Path where the .hwpx file will be saved.',
      },
      content: {
        type: 'array',
        description: 'Array of content blocks. Each block has exactly one of: paragraph, table, image, or pageBreak.',
        items: {
          type: 'object',
          properties: {
            paragraph: {
              type: 'object',
              description: 'A text paragraph with optional formatting.',
              properties: {
                text: { type: 'string', description: 'Paragraph text content' },
                runs: {
                  type: 'array',
                  description: 'Inline runs for mixed formatting in one paragraph. Use instead of text for precise formatting.',
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string', description: 'Run text' },
                      bold: { type: 'boolean', description: 'Run-level bold' },
                      italic: { type: 'boolean', description: 'Run-level italic' },
                      underline: { type: 'boolean', description: 'Run-level underline' },
                      color: { type: 'string', description: 'Run-level color as "#RRGGBB"' },
                      fontSize: { type: 'number', description: 'Run-level font size in pt' },
                      fontName: { type: 'string', description: 'Run-level font name' },
                      lineBreak: { type: 'boolean', description: 'Append a line break after this run (<hp:lineBreak/>)' },
                    },
                    required: ['text'],
                  },
                },
                heading: { type: 'number', description: 'Heading level (1-6). Sets appropriate font size and bold.' },
                bold: { type: 'boolean', description: 'Bold text' },
                italic: { type: 'boolean', description: 'Italic text' },
                underline: { type: 'boolean', description: 'Underline text' },
                color: { type: 'string', description: 'Text color as "#RRGGBB"' },
                fontSize: { type: 'number', description: 'Font size in pt (e.g., 10, 16, 26)' },
                fontName: { type: 'string', description: 'Paragraph font name (overrides default document font)' },
                alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY'], description: 'Paragraph alignment' },
                bullet: { type: 'boolean', description: 'Bullet list item (adds "• " prefix)' },
                numbered: { type: 'boolean', description: 'Numbered list item (adds "N. " prefix, auto-incremented)' },
                lineSpacing: { type: 'number', description: 'Line spacing percentage (e.g., 160)' },
                indent: { type: 'number', description: 'First-line indent in mm. Negative values create hanging indents.' },
                marginLeft: { type: 'number', description: 'Left margin in mm' },
                marginRight: { type: 'number', description: 'Right margin in mm' },
                spacing: {
                  type: 'object',
                  properties: {
                    before: { type: 'number', description: 'Space before in mm' },
                    after: { type: 'number', description: 'Space after in mm' },
                  },
                },
                pageBreak: { type: 'boolean', description: 'Insert page break before this paragraph' },
                lineBreak: { type: 'boolean', description: 'Append a line break at the end of this paragraph content' },
              },
            },
            table: {
              type: 'object',
              description: 'A table with rows of text cells.',
              properties: {
                rows: {
                  type: 'array',
                  items: { type: 'array', items: { type: 'string' } },
                  description: 'Array of rows, each row is an array of cell text strings.',
                },
                headerRow: { type: 'boolean', description: 'Style first row as header (bold, optional background)' },
                headerBackground: { type: 'string', description: 'Header row background color as "#RRGGBB"' },
                columnWidths: {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Column widths in mm. Omit for equal distribution.',
                },
                cellBorder: {
                  type: 'object',
                  description: 'Per-side border types for table cells.',
                  properties: {
                    topBorderType: { type: 'string', enum: ['NONE', 'SOLID', 'DOTTED', 'DASHED'] },
                    bottomBorderType: { type: 'string', enum: ['NONE', 'SOLID', 'DOTTED', 'DASHED'] },
                    leftBorderType: { type: 'string', enum: ['NONE', 'SOLID', 'DOTTED', 'DASHED'] },
                    rightBorderType: { type: 'string', enum: ['NONE', 'SOLID', 'DOTTED', 'DASHED'] },
                  },
                },
                cellCharFormat: {
                  type: 'object',
                  description: 'Default character format for data cells.',
                  properties: {
                    fontSize: { type: 'number', description: 'Cell font size in pt' },
                    fontName: { type: 'string', description: 'Cell font name' },
                    color: { type: 'string', description: 'Cell text color as "#RRGGBB"' },
                    alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY'], description: 'Reserved for future cell paragraph alignment' },
                  },
                },
              },
              required: ['rows'],
            },
            image: {
              type: 'object',
              description: 'An embedded image.',
              properties: {
                path: { type: 'string', description: 'Path to the image file (PNG, JPG, etc.)' },
                width_mm: { type: 'number', description: `Image width in mm (default: ${HWPX_DEFAULTS.image.widthMm})` },
                height_mm: { type: 'number', description: `Image height in mm (default: ${HWPX_DEFAULTS.image.heightMm})` },
                text_wrap: {
                  type: 'string',
                  enum: ['TOP_AND_BOTTOM', 'SQUARE', 'BEHIND_TEXT'],
                  description: `Image wrapping mode (default: ${HWPX_DEFAULTS.image.textWrap})`,
                },
              },
              required: ['path'],
            },
            pageBreak: { type: 'boolean', description: 'Standalone page break (true to insert)' },
          },
        },
      },
      page_size: { type: 'string', enum: ['a4', 'b5', 'letter'], description: `Page size (default: ${HWPX_DEFAULTS.document.pageSize})` },
      font: { type: 'string', description: `Default font name (default: "${HWPX_DEFAULTS.document.fontName}")` },
      font_size: { type: 'number', description: `Default font size in pt (default: ${HWPX_DEFAULTS.document.fontSizePt})` },
      margin: {
        type: 'object',
        description: `Page margins in mm. Defaults come from HWPX_DEFAULTS.page (top=${Math.round(HWPX_DEFAULTS.page.marginTop / 283.46)}mm, bottom=${Math.round(HWPX_DEFAULTS.page.marginBottom / 283.46)}mm, left=${Math.round(HWPX_DEFAULTS.page.marginLeft / 283.46)}mm, right=${Math.round(HWPX_DEFAULTS.page.marginRight / 283.46)}mm).`,
        properties: {
          top: { type: 'number', description: 'Top margin in mm' },
          bottom: { type: 'number', description: 'Bottom margin in mm' },
          left: { type: 'number', description: 'Left margin in mm' },
          right: { type: 'number', description: 'Right margin in mm' },
        },
      },
      header: {
        oneOf: [
          { type: 'string', description: 'Header text' },
          {
            type: 'object',
            description: 'Structured header content (text/table/auto page number)',
            properties: {
              text: { type: 'string', description: 'Header text. Supports {{PAGE}} and {{TOTAL_PAGE}} placeholders.' },
              autoPageNum: { type: 'boolean', description: 'Append current page number field' },
              autoTotalPages: { type: 'boolean', description: 'Append total pages field' },
              auto_page_num: { type: 'boolean', description: 'Alias of autoPageNum' },
              auto_total_pages: { type: 'boolean', description: 'Alias of autoTotalPages' },
              table: {
                type: 'object',
                properties: {
                  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                  columnWidths: { type: 'array', items: { type: 'number' } },
                },
                required: ['rows'],
              },
            },
          },
        ],
      },
      footer: {
        oneOf: [
          { type: 'string', description: 'Footer text' },
          {
            type: 'object',
            description: 'Structured footer content (text/table/auto page number)',
            properties: {
              text: { type: 'string', description: 'Footer text. Supports {{PAGE}} and {{TOTAL_PAGE}} placeholders.' },
              autoPageNum: { type: 'boolean', description: 'Append current page number field' },
              autoTotalPages: { type: 'boolean', description: 'Append total pages field' },
              auto_page_num: { type: 'boolean', description: 'Alias of autoPageNum' },
              auto_total_pages: { type: 'boolean', description: 'Alias of autoTotalPages' },
              table: {
                type: 'object',
                properties: {
                  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                  columnWidths: { type: 'array', items: { type: 'number' } },
                },
                required: ['rows'],
              },
            },
          },
        ],
      },
      title: { type: 'string', description: 'Document title (metadata)' },
    },
    required: ['output_path', 'content'],
  },
};

const HWPX_INIT_TASK: ToolDefinition = {
  type: 'function',
  name: 'hwpx_init_task',
  display_name: 'Initialize HWPX Task',
  description:
    'Initialize a new HWPX pipeline task. Creates the folder structure for step-by-step ' +
    'document creation or reading. Returns the task_dir path for subsequent steps.',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session identifier' },
      task_id: { type: 'string', description: 'Task identifier' },
      work_dir: { type: 'string', description: 'Optional base working directory' },
    },
    required: ['session_id', 'task_id'],
  },
  guide:
    '<tool_guide name="hwpx">\n'
    + 'Mandatory preflight: before generation, read style guide file heureum-client-tools/hwpx/assets/style-guide-prompt.md.\n'
    + 'If that path does not exist, locate style-guide-prompt.md in workspace and load the HWPX style guide first.\n'
    + 'Do not generate when style guide is unreadable; return STYLE_GUIDE_NOT_LOADED with attempted paths.\n'
    + 'Create a style_lock checklist (page/margins, typography, header/footer, table style, Korean tone) and apply it throughout generation.\n'
    + 'Persistence policy: do not save intermediate markdown/ast/xml unless explicitly needed for editing/debugging.\n'
    + 'Use markdown-first pipeline for final generation: init_task -> write_markdown -> write_xml -> pack_document.\n'
    + 'Write Korean administrative documents with stable markdown blocks (headings, paragraphs, lists, tables).\n'
    + 'Avoid raw HTML and avoid leaving markdown artifacts as literal output text.\n'
    + 'When style fidelity matters, run hwpx_extract_styles on a reference and mirror its layout/tone in markdown.\n'
    + '</tool_guide>',
};

const HWPX_WRITE_MARKDOWN: ToolDefinition = {
  type: 'function',
  name: 'hwpx_write_markdown',
  display_name: 'Write Markdown to HWPX Pipeline',
  description:
    'Parse markdown into AST. ' +
    'By default keeps intermediate state in memory only (no file save). ' +
    'Set persist_intermediate=true to additionally write output/input.md and output/ast.json.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from hwpx_init_task' },
      markdown: { type: 'string', description: 'Markdown content to process' },
      persist_intermediate: { type: 'boolean', description: 'If true, persist intermediate markdown/AST files to disk (default: false).' },
    },
    required: ['task_dir', 'markdown'],
  },
};

const HWPX_WRITE_XML: ToolDefinition = {
  type: 'function',
  name: 'hwpx_write_xml',
  display_name: 'Generate HWPX XML',
  description:
    'Generate HWPX XML from previously parsed AST. ' +
    'By default keeps XML in memory only (no file save). ' +
    'Set persist_intermediate=true to read/write output/ast.json and output/hwpx/.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from hwpx_init_task' },
      page_width: { type: 'number', description: `Page width in mm (default A4: ${hwpUnitToMm(HWPX_PAGE_SIZES.a4.width)})` },
      page_height: { type: 'number', description: `Page height in mm (default A4: ${hwpUnitToMm(HWPX_PAGE_SIZES.a4.height)})` },
      margin_top: { type: 'number', description: `Top margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginTop)})` },
      margin_bottom: { type: 'number', description: `Bottom margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginBottom)})` },
      margin_left: { type: 'number', description: `Left margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginLeft)})` },
      margin_right: { type: 'number', description: `Right margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginRight)})` },
      persist_intermediate: { type: 'boolean', description: 'If true, persist intermediate XML files to disk (default: false).' },
    },
    required: ['task_dir'],
  },
};

const HWPX_PACK: ToolDefinition = {
  type: 'function',
  name: 'hwpx_pack_document',
  display_name: 'Pack HWPX Archive',
  description:
    'Pack to output/result.hwpx. ' +
    'By default packs from in-memory XML state (no intermediate files). ' +
    'Set persist_intermediate=true to pack from output/hwpx/.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from hwpx_init_task' },
      persist_intermediate: { type: 'boolean', description: 'If true, pack using persisted output/hwpx files (default: false).' },
    },
    required: ['task_dir'],
  },
};

const HWPX_UNPACK: ToolDefinition = {
  type: 'function',
  name: 'hwpx_unpack_document',
  display_name: 'Unpack HWPX Archive',
  description:
    'Unpack an existing .hwpx file into output/hwpx/ for inspection or modification.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from hwpx_init_task' },
      input_path: { type: 'string', description: 'Path to the .hwpx file to unpack' },
    },
    required: ['task_dir', 'input_path'],
  },
};

const HWPX_READ_XML: ToolDefinition = {
  type: 'function',
  name: 'hwpx_read_xml',
  display_name: 'Read HWPX XML to AST',
  description:
    'Parse HWPX section XML from output/ into a remark AST. ' +
    'Writes the result to output/ast.json.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from hwpx_init_task' },
    },
    required: ['task_dir'],
  },
};

const HWPX_READ_MARKDOWN: ToolDefinition = {
  type: 'function',
  name: 'hwpx_read_markdown',
  display_name: 'Convert AST to Markdown',
  description:
    'Convert the AST in output/ast.json back to markdown. ' +
    'Writes to output/input.md and returns the markdown text.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from hwpx_init_task' },
    },
    required: ['task_dir'],
  },
};

const HWPX_EXTRACT_STYLES: ToolDefinition = {
  type: 'function',
  name: 'hwpx_extract_styles',
  display_name: 'Extract HWPX Styles',
  description:
    'Extract style metadata from an HWPX document as JSON: document metadata, fonts, char/para properties, border fills, style definitions, page layout, and header/footer content. This is a style-centric path (separate from markdown AST conversion tools).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 to include all sections. Default: 0' },
      include_all_sections: { type: 'boolean', description: 'If true and section_index is omitted, include all sections (same as section_index=-1).' },
    },
    required: ['path'],
  },
};

const HWPX_SET_METADATA: ToolDefinition = {
  type: 'function',
  name: 'hwpx_set_metadata',
  display_name: 'Set HWPX Metadata',
  description:
    'Update metadata (title, author, subject, keywords) of an existing HWPX document. ' +
    'Modifies Contents/content.hpf in-place via ZIP manipulation.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      title: { type: 'string', description: 'New document title' },
      author: { type: 'string', description: 'New author (also sets lastsaveby)' },
      subject: { type: 'string', description: 'New subject' },
      keywords: { type: 'string', description: 'New keywords' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
    },
    required: ['path'],
  },
};

const HWPX_FIND_REPLACE: ToolDefinition = {
  type: 'function',
  name: 'hwpx_find_replace',
  display_name: 'Find & Replace in HWPX',
  description:
    'Find and replace text in an existing HWPX document. ' +
    'Supports both single-run and cross-run matching (text split across multiple runs). ' +
    'Handles XML-escaped content transparently.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      find: { type: 'string', description: 'Text to search for (literal, not regex)' },
      replace: { type: 'string', description: 'Replacement text' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default: true)' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 for all sections. Default: 0' },
    },
    required: ['path', 'find', 'replace'],
  },
};

const HWPX_INSERT_TEXT: ToolDefinition = {
  type: 'function',
  name: 'hwpx_insert_text',
  display_name: 'Insert Text into HWPX',
  description:
    'Append text paragraphs to an existing HWPX document. ' +
    'Each line (\\n-separated) becomes a new <hp:p> paragraph. ' +
    'Inserted before the trailing empty paragraph.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      text: { type: 'string', description: 'Text to insert (\\n for multiple paragraphs)' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 for all sections. Default: 0' },
    },
    required: ['path', 'text'],
  },
};

const HWPX_MERGE_DOCUMENTS: ToolDefinition = {
  type: 'function',
  name: 'hwpx_merge_documents',
  display_name: 'Merge HWPX Documents',
  description:
    'Merge multiple HWPX documents into a single document. ' +
    'Extracts content paragraphs from each input, combines them in order, ' +
    're-numbers IDs, and builds a new HWPX archive.',
  parameters: {
    type: 'object',
    properties: {
      input_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of paths to .hwpx files to merge',
      },
      output_path: { type: 'string', description: 'Path for the merged .hwpx output' },
    },
    required: ['input_paths', 'output_path'],
  },
};

const HWPX_SET_CHAR_FORMAT: ToolDefinition = {
  type: 'function',
  name: 'hwpx_set_char_format',
  display_name: 'Set Character Format in HWPX',
  description:
    'Apply character formatting (bold, italic, underline, font size, text color, font) to runs in an existing HWPX document. ' +
    'Inherits existing charPr properties and only overrides specified attributes. ' +
    'Can target specific text or paragraphs.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      target_text: { type: 'string', description: 'Apply to runs containing this text. Omit for all runs.' },
      paragraph_index: { type: 'number', description: 'Apply to this paragraph only (0-based, excludes secPr paragraph)' },
      bold: { type: 'boolean', description: 'Bold text' },
      italic: { type: 'boolean', description: 'Italic text' },
      underline: { type: 'boolean', description: 'Underline text' },
      font_size: { type: 'number', description: 'Font size in pt (e.g., 11.5)' },
      text_color: { type: 'string', description: 'Text color as "#RRGGBB"' },
      font_name: { type: 'string', description: 'Font name (e.g., "맑은 고딕", "나눔고딕"). Registers font if not present.' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 for all sections. Default: 0' },
    },
    required: ['path'],
  },
};

const HWPX_SET_PARA_FORMAT: ToolDefinition = {
  type: 'function',
  name: 'hwpx_set_para_format',
  display_name: 'Set Paragraph Format in HWPX',
  description:
    'Apply paragraph formatting (alignment, line spacing, indent, margins) to paragraphs in an existing HWPX document. ' +
    'Can target specific text-containing paragraphs or by index.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      target_text: { type: 'string', description: 'Apply to paragraphs containing this text' },
      paragraph_index: { type: 'number', description: 'Apply to this paragraph only (0-based)' },
      alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY'], description: 'Horizontal alignment' },
      line_spacing: { type: 'number', description: 'Line spacing percentage (e.g., 160 = 160%)' },
      indent: { type: 'number', description: 'Indent in mm' },
      margin_left: { type: 'number', description: 'Left margin in mm' },
      margin_right: { type: 'number', description: 'Right margin in mm' },
      space_before: { type: 'number', description: 'Space before paragraph in mm' },
      space_after: { type: 'number', description: 'Space after paragraph in mm' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 for all sections. Default: 0' },
    },
    required: ['path'],
  },
};

const HWPX_SET_PAGE_LAYOUT: ToolDefinition = {
  type: 'function',
  name: 'hwpx_set_page_layout',
  display_name: 'Set Page Layout in HWPX',
  description:
    'Set page dimensions and margins in an existing HWPX document. ' +
    'All values in mm.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      page_width: { type: 'number', description: `Page width in mm (A4: ${hwpUnitToMm(HWPX_PAGE_SIZES.a4.width)})` },
      page_height: { type: 'number', description: `Page height in mm (A4: ${hwpUnitToMm(HWPX_PAGE_SIZES.a4.height)})` },
      margin_top: { type: 'number', description: `Top margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginTop)})` },
      margin_bottom: { type: 'number', description: `Bottom margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginBottom)})` },
      margin_left: { type: 'number', description: `Left margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginLeft)})` },
      margin_right: { type: 'number', description: `Right margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginRight)})` },
      margin_header: { type: 'number', description: `Header margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginHeader)})` },
      margin_footer: { type: 'number', description: `Footer margin in mm (default: ${hwpUnitToMm(HWPX_DEFAULTS.page.marginFooter)})` },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 for all sections. Default: 0' },
    },
    required: ['path'],
  },
};

const HWPX_EDIT_TABLE_CELL: ToolDefinition = {
  type: 'function',
  name: 'hwpx_edit_table_cell',
  display_name: 'Edit Table Cell in HWPX',
  description:
    'Edit a specific cell in a table within an HWPX document. ' +
    'Supports text replacement, background color, border styling, and cell merging (merge_right, merge_down).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      table_index: { type: 'number', description: 'Table index (0-based, default 0)' },
      row: { type: 'number', description: 'Row index (0-based)' },
      col: { type: 'number', description: 'Column index (0-based)' },
      text: { type: 'string', description: 'New cell text' },
      background_color: { type: 'string', description: 'Background color as "#RRGGBB"' },
      border_type: { type: 'string', enum: ['NONE', 'SOLID', 'DOTTED', 'DASHED'], description: 'Border line type' },
      border_width: { type: 'string', description: `Border width (e.g., "${HWPX_DEFAULTS.border.width}", "0.4 mm")` },
      merge_right: { type: 'number', description: 'Number of cells to merge rightward' },
      merge_down: { type: 'number', description: 'Number of cells to merge downward' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      section_index: { type: 'number', description: 'Section index (0-based). Default: 0' },
    },
    required: ['path', 'row', 'col'],
  },
};

const HWPX_INSERT_IMAGE: ToolDefinition = {
  type: 'function',
  name: 'hwpx_insert_image',
  display_name: 'Insert Image into HWPX',
  description:
    'Insert an image file (PNG, JPG, etc.) into an existing HWPX document. ' +
    'Embeds the image binary and creates a picture element.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      image_path: { type: 'string', description: 'Path to the image file (PNG, JPG, etc.)' },
      width_mm: { type: 'number', description: `Image width in mm (default: ${HWPX_DEFAULTS.image.widthMm})` },
      height_mm: { type: 'number', description: `Image height in mm (default: ${HWPX_DEFAULTS.image.heightMm})` },
      text_wrap: {
        type: 'string',
        enum: ['TOP_AND_BOTTOM', 'SQUARE', 'BEHIND_TEXT'],
        description: `Image wrapping mode (default: ${HWPX_DEFAULTS.image.textWrap})`,
      },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 for all sections. Default: 0' },
    },
    required: ['path', 'image_path'],
  },
};

const HWPX_SET_HEADER_FOOTER: ToolDefinition = {
  type: 'function',
  name: 'hwpx_set_header_footer',
  display_name: 'Set Header/Footer in HWPX',
  description:
    'Set or replace the header or footer in an existing HWPX document. ' +
    'Inserts into the secPr element of the specified section.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      type: { type: 'string', enum: ['header', 'footer'], description: 'Whether to set header or footer' },
      text: { type: 'string', description: 'Text content for the header/footer (legacy)' },
      table: {
        type: 'object',
        description: 'Top-level table content for header/footer (legacy shortcut)',
        properties: {
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          columnWidths: { type: 'array', items: { type: 'number' } },
        },
        required: ['rows'],
      },
      auto_page_num: { type: 'boolean', description: 'Top-level alias: append current page number field' },
      auto_total_pages: { type: 'boolean', description: 'Top-level alias: append total pages field' },
      autoPageNum: { type: 'boolean', description: 'Top-level alias: append current page number field' },
      autoTotalPages: { type: 'boolean', description: 'Top-level alias: append total pages field' },
      content: {
        type: 'object',
        description: 'Structured content for header/footer',
        properties: {
          text: { type: 'string', description: 'Header/footer text. Supports {{PAGE}} and {{TOTAL_PAGE}} placeholders.' },
          autoPageNum: { type: 'boolean', description: 'Append current page number field' },
          autoTotalPages: { type: 'boolean', description: 'Append total pages field' },
          auto_page_num: { type: 'boolean', description: 'Alias of autoPageNum' },
          auto_total_pages: { type: 'boolean', description: 'Alias of autoTotalPages' },
          table: {
            type: 'object',
            properties: {
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              columnWidths: { type: 'array', items: { type: 'number' } },
            },
            required: ['rows'],
          },
        },
      },
      alignment: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT'], description: 'Text alignment (default: CENTER)' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 for all sections. Default: 0' },
    },
    required: ['path', 'type'],
    anyOf: [
      { required: ['text'] },
      { required: ['content'] },
      { required: ['table'] },
      { required: ['auto_page_num'] },
      { required: ['auto_total_pages'] },
      { required: ['autoPageNum'] },
      { required: ['autoTotalPages'] },
    ],
  },
};

const HWPX_INSERT_TABLE: ToolDefinition = {
  type: 'function',
  name: 'hwpx_insert_table',
  display_name: 'Insert Table into HWPX',
  description:
    'Insert a new table into an existing HWPX document. ' +
    'Creates a table with the specified dimensions, headers, and data.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the source .hwpx file' },
      rows: { type: 'number', description: 'Total number of rows (including header)' },
      cols: { type: 'number', description: 'Number of columns' },
      headers: { type: 'array', items: { type: 'string' }, description: 'Header row texts' },
      data: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Data rows (array of arrays)' },
      output_path: { type: 'string', description: 'Optional output path (defaults to overwrite input)' },
      section_index: { type: 'number', description: 'Section index (0-based). -1 for all sections. Default: 0' },
    },
    required: ['path', 'rows', 'cols'],
  },
};

export const HWPX_TOOLS: ToolDefinition[] = [
  HWPX_INIT_TASK,
  HWPX_WRITE_MARKDOWN,
  HWPX_WRITE_XML,
  HWPX_PACK,
  HWPX_UNPACK,
  HWPX_READ_XML,
  HWPX_READ_MARKDOWN,
  HWPX_EXTRACT_STYLES,
  HWPX_SET_METADATA,
  HWPX_FIND_REPLACE,
  HWPX_INSERT_TEXT,
  HWPX_MERGE_DOCUMENTS,
  HWPX_SET_CHAR_FORMAT,
  HWPX_SET_PARA_FORMAT,
  HWPX_SET_PAGE_LAYOUT,
  HWPX_EDIT_TABLE_CELL,
  HWPX_INSERT_IMAGE,
  HWPX_SET_HEADER_FOOTER,
  HWPX_INSERT_TABLE,
];

export async function handleHwpxTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<HwpxToolResult> {
  switch (toolName) {
    case 'hwpx_init_task':
      return hwpxInitTask(args as Parameters<typeof hwpxInitTask>[0]);
    case 'hwpx_write_markdown':
      return hwpxWriteMarkdown(args as Parameters<typeof hwpxWriteMarkdown>[0]);
    case 'hwpx_write_xml':
      return hwpxWriteXml(args as Parameters<typeof hwpxWriteXml>[0]);
    case 'hwpx_pack_document':
      return hwpxPack(args as Parameters<typeof hwpxPack>[0]);
    case 'hwpx_unpack_document':
      return hwpxUnpack(args as Parameters<typeof hwpxUnpack>[0]);
    case 'hwpx_read_xml':
      return hwpxReadXml(args as Parameters<typeof hwpxReadXml>[0]);
    case 'hwpx_read_markdown':
      return hwpxReadMarkdown(args as Parameters<typeof hwpxReadMarkdown>[0]);
    case 'hwpx_extract_styles':
      return parseTemplateStyle(args as Parameters<typeof parseTemplateStyle>[0]);
    case 'hwpx_set_metadata':
      return hwpxSetMetadata(args as Parameters<typeof hwpxSetMetadata>[0]);
    case 'hwpx_find_replace':
      return hwpxFindReplace(args as Parameters<typeof hwpxFindReplace>[0]);
    case 'hwpx_insert_text':
      return hwpxInsertText(args as Parameters<typeof hwpxInsertText>[0]);
    case 'hwpx_merge_documents':
      return hwpxMergeDocuments(args as Parameters<typeof hwpxMergeDocuments>[0]);
    case 'hwpx_set_char_format':
      return hwpxSetCharFormat(args as Parameters<typeof hwpxSetCharFormat>[0]);
    case 'hwpx_set_para_format':
      return hwpxSetParaFormat(args as Parameters<typeof hwpxSetParaFormat>[0]);
    case 'hwpx_set_page_layout':
      return hwpxSetPageLayout(args as Parameters<typeof hwpxSetPageLayout>[0]);
    case 'hwpx_edit_table_cell':
      return hwpxEditTableCell(args as Parameters<typeof hwpxEditTableCell>[0]);
    case 'hwpx_insert_image':
      return hwpxInsertImage(args as Parameters<typeof hwpxInsertImage>[0]);
    case 'hwpx_set_header_footer':
      return hwpxSetHeaderFooter(args as Parameters<typeof hwpxSetHeaderFooter>[0]);
    case 'hwpx_insert_table':
      return hwpxInsertTable(args as Parameters<typeof hwpxInsertTable>[0]);
    default:
      return { success: false, output: `Unknown HWPX tool: ${toolName}` };
  }
}
