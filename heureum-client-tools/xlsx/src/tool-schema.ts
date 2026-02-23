/**
 * XLSX ToolDefinition + handler for LLM tool binding.
 * Includes XLSX operation tools plus step-based pipeline tools (init/write/pack/unpack/read).
 */

import { recalc, type RecalcResult } from "./recalc";
import {
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
  // P4/P5 tools
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

interface ToolDefinition {
  type: 'function'
  name: string
  display_name: string
  description?: string
  parameters?: Record<string, any>
  guide?: string
}

export type { ToolResult };

// ─── Tool Definitions ────────────────────────

const XLSX_INIT_TASK: ToolDefinition = {
  type: 'function',
  name: 'xlsx_init_task',
  display_name: 'Init XLSX Pipeline Task',
  description:
    'Initialize a persisted XLSX pipeline task with step folders (01_source, 02_parsed, 03_intermediate, 04_output).',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session identifier' },
      task_id: { type: 'string', description: 'Task identifier' },
      work_dir: { type: 'string', description: 'Optional base working directory' },
    },
    required: ['session_id', 'task_id'],
  },
}

const XLSX_WRITE_SOURCE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_write_source',
  display_name: 'Write XLSX Source',
  description:
    'Write pipeline source input for XLSX task. Provide either input_path (existing .xlsx) or create_params (xlsx_create_workbook payload without outputPath).',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from xlsx_init_task' },
      input_path: { type: 'string', description: 'Path to source .xlsx file' },
      create_params: { type: 'object', description: 'Structured create payload compatible with xlsx_create_workbook (without outputPath).' },
    },
    required: ['task_dir'],
  },
}

const XLSX_WRITE_INTERMEDIATE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_write_intermediate',
  display_name: 'Build XLSX Intermediate',
  description:
    'Build and unpack intermediate XLSX structure into 03_intermediate/unpacked from previously written source.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from xlsx_init_task' },
    },
    required: ['task_dir'],
  },
}

const XLSX_PACK_TASK: ToolDefinition = {
  type: 'function',
  name: 'xlsx_pack_workbook',
  display_name: 'Pack XLSX Output',
  description:
    'Pack 03_intermediate/unpacked into an .xlsx output (defaults to 04_output/result.xlsx).',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from xlsx_init_task' },
      output_path: { type: 'string', description: 'Optional output .xlsx path' },
    },
    required: ['task_dir'],
  },
}

const XLSX_UNPACK_TASK: ToolDefinition = {
  type: 'function',
  name: 'xlsx_unpack_workbook',
  display_name: 'Unpack XLSX Into Pipeline',
  description:
    'Unpack an existing .xlsx into 03_intermediate/unpacked for step-based pipeline processing.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from xlsx_init_task' },
      input_path: { type: 'string', description: 'Path to input .xlsx file' },
    },
    required: ['task_dir', 'input_path'],
  },
}

const XLSX_READ_PARSED: ToolDefinition = {
  type: 'function',
  name: 'xlsx_read_parsed',
  display_name: 'Read XLSX Parsed Summary',
  description:
    'Read 03_intermediate/unpacked and write parsed summary to 02_parsed/summary.txt.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from xlsx_init_task' },
    },
    required: ['task_dir'],
  },
}

const XLSX_READ_SOURCE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_read_source',
  display_name: 'Read XLSX Source',
  description:
    'Read source information from 01_source (create.json payload or source .xlsx summary).',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from xlsx_init_task' },
    },
    required: ['task_dir'],
  },
}

const XLSX_RECALC: ToolDefinition = {
  type: 'function',
  name: 'xlsx_recalc_formulas',
  display_name: 'Recalc Formulas',
  description:
    'Recalculate all formulas in an Excel file using LibreOffice and report any formula errors.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file (must be within the working directory)' },
      timeout_seconds: {
        type: 'integer',
        description: 'Timeout for LibreOffice in seconds. Defaults to 30.',
      },
    },
    required: ['path'],
  },
}

const XLSX_READ: ToolDefinition = {
  type: 'function',
  name: 'xlsx_read_data',
  display_name: 'Read Workbook',
  description:
    'Read an Excel file and extract sheet names, cell values, formulas, merged cells, and optionally style information.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Name of a specific sheet to read. If omitted, reads all sheets.' },
      range: { type: 'string', description: 'Cell range to read, e.g. "A1:C10". If omitted, reads entire sheet.' },
      includeStyles: { type: 'boolean', description: 'Include style information (font, alignment, number format). Defaults to false.' },
    },
    required: ['path'],
  },
}

const XLSX_EXTRACT_STYLES: ToolDefinition = {
  type: 'function',
  name: 'xlsx_extract_styles',
  display_name: 'Extract XLSX Styles',
  description:
    'Extract a structured JSON style profile from an Excel file: workbook/sheet/cell styles, OOXML styleSheet tables (numFmts/fonts/fills/borders/xfs/dxfs/tableStyles/colors), sharedStrings/inline rich-text run styles, and sheet-level styleId references.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Optional sheet name. If omitted, all sheets are analyzed.' },
      max_cells_per_sheet: {
        type: 'integer',
        description: 'Maximum styled cell entries returned per sheet. Defaults to 5000.',
      },
      max_rich_text_cells: {
        type: 'integer',
        description: 'Maximum rich-text cell mappings (sharedStrings + inlineStr each) to return. Defaults to 1000.',
      },
    },
    required: ['path'],
  },
}

const XLSX_UPDATE_CELLS: ToolDefinition = {
  type: 'function',
  name: 'xlsx_update_cells',
  display_name: 'Update Cells',
  description:
    'Update cell values in an existing Excel file. For formula-focused operations (fill, array, bulk insertion), use xlsx_manage_formulas instead.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      updates: {
        type: 'array',
        description: 'Array of cell updates',
        items: {
          type: 'object',
          properties: {
            cell: { type: 'string', description: 'Cell address, e.g. "A1"' },
            value: { description: 'New value (string, number, or boolean)' },
            formula: { type: 'string', description: 'Formula to set (without leading =), e.g. "SUM(A1:A10)"' },
            sheet: { type: 'string', description: 'Target sheet name. Defaults to first sheet.' },
          },
          required: ['cell'],
        },
      },
      outputPath: { type: 'string', description: 'Output file path. Defaults to <filename>_modified.xlsx' },
    },
    required: ['path', 'updates'],
  },
}

const XLSX_INSERT_ROWS: ToolDefinition = {
  type: 'function',
  name: 'xlsx_insert_rows',
  display_name: 'Insert Rows',
  description:
    'Insert one or more rows into an Excel file at a specified position.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      startRow: { type: 'integer', description: 'Row number (1-based) at which to insert' },
      rows: {
        type: 'array',
        description: 'Array of rows, each row is an array of cell values',
        items: { type: 'array', items: { type: 'string' } },
      },
      outputPath: { type: 'string', description: 'Output file path. Defaults to <filename>_modified.xlsx' },
    },
    required: ['path', 'startRow', 'rows'],
  },
}

const XLSX_DELETE_ROWS: ToolDefinition = {
  type: 'function',
  name: 'xlsx_delete_rows',
  display_name: 'Delete Rows',
  description:
    'Delete one or more contiguous rows from a worksheet while preserving remaining data, formulas, and formatting alignment.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      startRow: { type: 'integer', description: 'First row number (1-based) to delete' },
      count: { type: 'integer', description: 'Number of rows to delete' },
      outputPath: { type: 'string', description: 'Output file path. Defaults to <filename>_modified.xlsx' },
    },
    required: ['path', 'startRow', 'count'],
  },
}

const XLSX_INSERT_COLUMNS: ToolDefinition = {
  type: 'function',
  name: 'xlsx_insert_columns',
  display_name: 'Insert Columns',
  description:
    'Insert one or more columns into an Excel file at a specified position.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      startColumn: { type: 'integer', description: 'Column number (1-based, 1=A, 2=B, ...) at which to insert' },
      columns: {
        type: 'array',
        description: 'Array of columns, each column is an array of cell values (top to bottom)',
        items: { type: 'array', items: { type: 'string' } },
      },
      outputPath: { type: 'string', description: 'Output file path. Defaults to <filename>_modified.xlsx' },
    },
    required: ['path', 'startColumn', 'columns'],
  },
}

const XLSX_DELETE_COLUMNS: ToolDefinition = {
  type: 'function',
  name: 'xlsx_delete_columns',
  display_name: 'Delete Columns',
  description:
    'Delete one or more contiguous columns from a worksheet and shift remaining columns left, keeping workbook structure consistent.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      startColumn: { type: 'integer', description: 'First column number (1-based) to delete' },
      count: { type: 'integer', description: 'Number of columns to delete' },
      outputPath: { type: 'string', description: 'Output file path. Defaults to <filename>_modified.xlsx' },
    },
    required: ['path', 'startColumn', 'count'],
  },
}

const XLSX_FORMAT_CELLS: ToolDefinition = {
  type: 'function',
  name: 'xlsx_format_cells',
  display_name: 'Format Cells',
  description:
    'Apply formatting (font, fill, border, alignment, number format) to a range of cells.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      range: { type: 'string', description: 'Cell range, e.g. "A1:C3" or single cell "B2"' },
      format: {
        type: 'object',
        description: 'Formatting options to apply',
        properties: {
          font: {
            type: 'object',
            properties: {
              name: { type: 'string' }, size: { type: 'number' },
              bold: { type: 'boolean' }, italic: { type: 'boolean' },
              underline: { type: 'boolean' },
              color: { type: 'string', description: 'ARGB hex color' },
            },
          },
          fill: {
            type: 'object',
            properties: {
              pattern: { type: 'string', enum: ['solid', 'none'] },
              fgColor: { type: 'string', description: 'ARGB hex color' },
            },
          },
          border: {
            type: 'object',
            properties: {
              top: { type: 'object', properties: { style: { type: 'string' }, color: { type: 'string' } } },
              bottom: { type: 'object', properties: { style: { type: 'string' }, color: { type: 'string' } } },
              left: { type: 'object', properties: { style: { type: 'string' }, color: { type: 'string' } } },
              right: { type: 'object', properties: { style: { type: 'string' }, color: { type: 'string' } } },
            },
          },
          alignment: {
            type: 'object',
            properties: {
              horizontal: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
              vertical: { type: 'string', enum: ['top', 'middle', 'bottom'] },
              wrapText: { type: 'boolean' },
            },
          },
          numFmt: { type: 'string', description: 'Number format string, e.g. "#,##0.00"' },
        },
      },
      outputPath: { type: 'string', description: 'Output file path. Defaults to <filename>_modified.xlsx' },
    },
    required: ['path', 'range', 'format'],
  },
}

const XLSX_CREATE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_create_workbook',
  display_name: 'Create Workbook',
  description:
    'Create a new Excel workbook from structured data with optional column widths, freeze panes, and header styling.',
  parameters: {
    type: 'object',
    properties: {
      outputPath: { type: 'string', description: 'Path for the output .xlsx file' },
      sheets: {
        type: 'array',
        description: 'Array of sheet definitions',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            data: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            columnWidths: { type: 'array', items: { type: 'number' } },
            freezeRow: { type: 'integer' },
            freezeColumn: { type: 'integer' },
            headerStyle: { type: 'boolean' },
          },
          required: ['name', 'data'],
        },
      },
    },
    required: ['outputPath', 'sheets'],
  },
}

const XLSX_MANAGE_SHEETS: ToolDefinition = {
  type: 'function',
  name: 'xlsx_manage_sheets',
  display_name: 'Manage Sheets',
  description:
    'Add, delete, rename, copy, or reorder sheets in an existing Excel file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'delete', 'rename', 'copy', 'reorder'] },
            name: { type: 'string', description: 'Sheet name to operate on' },
            newName: { type: 'string', description: 'New name (for rename and copy)' },
            position: { type: 'integer', description: 'Target position (0-based, for reorder)' },
          },
          required: ['action', 'name'],
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'operations'],
  },
}

const XLSX_CONVERT: ToolDefinition = {
  type: 'function',
  name: 'xlsx_convert_file',
  display_name: 'Convert XLSX',
  description:
    'Convert an Excel file to CSV or HTML without LibreOffice.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      format: { type: 'string', enum: ['csv', 'html'], description: 'Target format' },
      outputPath: { type: 'string' },
    },
    required: ['path', 'format'],
  },
}

// ─── P0: Core Features ──────────────────────

const XLSX_MERGE_CELLS: ToolDefinition = {
  type: 'function',
  name: 'xlsx_merge_cells',
  display_name: 'Merge Cells',
  description:
    'Merge or unmerge specified cell ranges in a worksheet, useful for header blocks and structured report layouts.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      operations: {
        type: 'array',
        description: 'Array of merge/unmerge operations',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['merge', 'unmerge'], description: 'Merge or unmerge cells' },
            range: { type: 'string', description: 'Cell range, e.g. "A1:C1"' },
          },
          required: ['action', 'range'],
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'operations'],
  },
}

const XLSX_SORT_DATA: ToolDefinition = {
  type: 'function',
  name: 'xlsx_sort_data',
  display_name: 'Sort Data',
  description:
    'Sort data in a range by one or more columns in ascending or descending order.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      range: { type: 'string', description: 'Data range to sort, e.g. "A1:E100"' },
      sortBy: {
        type: 'array',
        description: 'Sort criteria. Each entry specifies a column letter and sort order.',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string', description: 'Column letter, e.g. "B"' },
            order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' },
          },
          required: ['column', 'order'],
        },
      },
      hasHeader: { type: 'boolean', description: 'If true, first row is treated as header and not sorted. Defaults to false.' },
      outputPath: { type: 'string' },
    },
    required: ['path', 'range', 'sortBy'],
  },
}

const XLSX_AUTO_FILTER: ToolDefinition = {
  type: 'function',
  name: 'xlsx_set_filter',
  display_name: 'Auto Filter',
  description:
    'Set or remove auto-filter on a range. Filter dropdowns appear on the header row when opened in Excel.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: { type: 'string', enum: ['set', 'remove'], description: 'Set or remove auto filter. Defaults to "set".' },
      range: { type: 'string', description: 'Filter range, e.g. "A1:E1" (required for "set" action)' },
      outputPath: { type: 'string' },
    },
    required: ['path'],
  },
}

const XLSX_DATA_VALIDATION: ToolDefinition = {
  type: 'function',
  name: 'xlsx_set_validation',
  display_name: 'Data Validation',
  description:
    'Apply or remove data validation rules (dropdown lists, number ranges, date limits, etc.) on cells.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: { type: 'string', enum: ['apply', 'remove'], description: 'Apply or remove validation. Defaults to "apply".' },
      range: { type: 'string', description: 'Target cell range, e.g. "B2:B100"' },
      validation: {
        type: 'object',
        description: 'Validation rule definition (required for "apply" action)',
        properties: {
          type: { type: 'string', enum: ['list', 'whole', 'decimal', 'date', 'textLength', 'custom'], description: 'Validation type' },
          formulae: { type: 'array', items: { type: 'string' }, description: 'Validation formulae. For list: [\'"Item1,Item2,Item3"\'], for whole/decimal: ["1", "100"] (min, max)' },
          operator: { type: 'string', enum: ['between', 'notBetween', 'equal', 'notEqual', 'greaterThan', 'lessThan', 'greaterThanOrEqual', 'lessThanOrEqual'] },
          allowBlank: { type: 'boolean', description: 'Allow blank cells. Defaults to true.' },
          showDropDown: { type: 'boolean', description: 'Show dropdown for list type' },
          showErrorMessage: { type: 'boolean', description: 'Show error message on invalid input. Defaults to true.' },
          errorTitle: { type: 'string', description: 'Error dialog title' },
          error: { type: 'string', description: 'Error message text' },
          showInputMessage: { type: 'boolean', description: 'Show input hint when cell is selected' },
          promptTitle: { type: 'string', description: 'Input hint title' },
          prompt: { type: 'string', description: 'Input hint text' },
        },
        required: ['type', 'formulae'],
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'range'],
  },
}

// ─── P1: Professional Features ───────────────

const XLSX_CONDITIONAL_FORMATTING: ToolDefinition = {
  type: 'function',
  name: 'xlsx_manage_conditions',
  display_name: 'Conditional Formatting',
  description:
    'Add, remove, or list conditional formatting rules on a sheet (highlight cells based on value conditions, color scales, data bars, icon sets).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: { type: 'string', enum: ['add', 'remove', 'list'], description: 'Action to perform. Defaults to "add".' },
      range: { type: 'string', description: 'Target cell range, e.g. "A1:A100" (required for "add", optional for "remove" to target specific range)' },
      rules: {
        type: 'array',
        description: 'Array of conditional formatting rules (required for "add")',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['cellIs', 'expression', 'colorScale', 'dataBar', 'iconSet', 'top10', 'aboveAverage', 'containsText'] },
            operator: { type: 'string', enum: ['greaterThan', 'lessThan', 'between', 'equal', 'notEqual', 'greaterThanOrEqual', 'lessThanOrEqual'] },
            formulae: { type: 'array', items: { type: 'string' }, description: 'Values or formulas for the condition' },
            text: { type: 'string', description: 'Text to match (for containsText type)' },
            priority: { type: 'integer', description: 'Rule priority (lower = higher priority)' },
            style: {
              type: 'object',
              properties: {
                font: { type: 'object', properties: { bold: { type: 'boolean' }, italic: { type: 'boolean' }, color: { type: 'string' } } },
                fill: { type: 'object', properties: { bgColor: { type: 'string', description: 'ARGB hex background color' } } },
              },
            },
          },
          required: ['type', 'priority'],
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path'],
  },
}

const XLSX_SET_SHEET_PROPERTIES: ToolDefinition = {
  type: 'function',
  name: 'xlsx_set_properties',
  display_name: 'Set Sheet Properties',
  description:
    'Set sheet-level display properties: freeze panes, column widths, row heights, tab color, grid lines.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      properties: {
        type: 'object',
        properties: {
          freezeRow: { type: 'integer', description: 'Number of rows to freeze from top' },
          freezeColumn: { type: 'integer', description: 'Number of columns to freeze from left' },
          columnWidths: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                column: { description: 'Column letter (e.g. "A") or number (1-based)' },
                width: { type: 'number', description: 'Width in characters' },
              },
              required: ['column', 'width'],
            },
          },
          rowHeights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                row: { type: 'integer', description: 'Row number (1-based)' },
                height: { type: 'number', description: 'Height in points' },
              },
              required: ['row', 'height'],
            },
          },
          tabColor: { type: 'string', description: 'ARGB hex color for sheet tab' },
          showGridLines: { type: 'boolean' },
          defaultColWidth: { type: 'number' },
          defaultRowHeight: { type: 'number' },
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'properties'],
  },
}

const XLSX_PROTECT_SHEET: ToolDefinition = {
  type: 'function',
  name: 'xlsx_protect_sheet',
  display_name: 'Protect Sheet',
  description:
    'Protect or unprotect a sheet with optional password and permission settings.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: { type: 'string', enum: ['protect', 'unprotect'], description: 'Protect or unprotect the sheet' },
      password: { type: 'string', description: 'Password for protection (optional)' },
      options: {
        type: 'object',
        description: 'Permissions to allow while protected',
        properties: {
          selectLockedCells: { type: 'boolean' },
          selectUnlockedCells: { type: 'boolean' },
          formatCells: { type: 'boolean' },
          formatColumns: { type: 'boolean' },
          formatRows: { type: 'boolean' },
          insertColumns: { type: 'boolean' },
          insertRows: { type: 'boolean' },
          insertHyperlinks: { type: 'boolean' },
          deleteColumns: { type: 'boolean' },
          deleteRows: { type: 'boolean' },
          sort: { type: 'boolean' },
          autoFilter: { type: 'boolean' },
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'action'],
  },
}

const XLSX_ADD_IMAGE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_add_image',
  display_name: 'Add Image',
  description:
    'Insert an image (PNG, JPEG, GIF) into a sheet at a specified position. For sheet background/watermark, use xlsx_set_background instead.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      image: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to image file' },
          base64: { type: 'string', description: 'Base64-encoded image data (alternative to filePath)' },
          extension: { type: 'string', enum: ['png', 'jpeg', 'gif'], description: 'Image format' },
        },
        required: ['extension'],
      },
      position: {
        type: 'object',
        description: 'Image position (0-based column and row)',
        properties: {
          from: { type: 'object', properties: { col: { type: 'number' }, row: { type: 'number' } }, required: ['col', 'row'] },
          to: { type: 'object', properties: { col: { type: 'number' }, row: { type: 'number' } }, required: ['col', 'row'] },
        },
        required: ['from', 'to'],
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'image', 'position'],
  },
}

// ─── P2: Advanced Data Processing ────────────

const XLSX_NAMED_RANGES: ToolDefinition = {
  type: 'function',
  name: 'xlsx_manage_ranges',
  display_name: 'Named Ranges',
  description:
    'Add, delete, or list named ranges (defined names) in an Excel file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'delete', 'list'] },
            name: { type: 'string', description: 'Named range name (not needed for list)' },
            range: { type: 'string', description: 'Cell range with sheet, e.g. "Sheet1!A1:E100" (only for add)' },
          },
          required: ['action'],
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'operations'],
  },
}

const XLSX_REMOVE_DUPLICATES: ToolDefinition = {
  type: 'function',
  name: 'xlsx_remove_duplicates',
  display_name: 'Remove Duplicates',
  description:
    'Detect and remove duplicate rows from a range based on specified columns.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      range: { type: 'string', description: 'Data range, e.g. "A1:E100"' },
      columns: {
        type: 'array',
        description: 'Column letters to check for duplicates, e.g. ["A", "C"]. If omitted, checks all columns.',
        items: { type: 'string' },
      },
      keepFirst: { type: 'boolean', description: 'Keep the first occurrence of each duplicate. Defaults to true.' },
      outputPath: { type: 'string' },
    },
    required: ['path', 'range'],
  },
}

const XLSX_FIND_REPLACE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_replace_text',
  display_name: 'Find & Replace',
  description:
    'Find and replace text across one or all sheets in an Excel file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. If omitted, searches all sheets.' },
      find: { type: 'string', description: 'Text or regex pattern to find' },
      replace: { type: 'string', description: 'Replacement text' },
      options: {
        type: 'object',
        properties: {
          matchCase: { type: 'boolean', description: 'Case-sensitive matching. Defaults to false.' },
          matchEntireCell: { type: 'boolean', description: 'Match entire cell value only. Defaults to false.' },
          useRegex: { type: 'boolean', description: 'Treat find as a regular expression. Defaults to false.' },
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'find', 'replace'],
  },
}

const XLSX_HYPERLINK: ToolDefinition = {
  type: 'function',
  name: 'xlsx_manage_hyperlinks',
  display_name: 'Hyperlink',
  description:
    'Add or remove hyperlinks (URL, email, sheet reference) on cells.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cell: { type: 'string', description: 'Cell address, e.g. "A1"' },
            action: { type: 'string', enum: ['add', 'remove'] },
            target: { type: 'string', description: 'URL, email (mailto:), or sheet reference (required for add)' },
            text: { type: 'string', description: 'Display text. Defaults to target URL.' },
            tooltip: { type: 'string', description: 'Hover tooltip text' },
          },
          required: ['cell', 'action'],
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'operations'],
  },
}

// ─── P3: Visualization ──────────────────────

const XLSX_ADD_CHART: ToolDefinition = {
  type: 'function',
  name: 'xlsx_add_chart',
  display_name: 'Add Chart',
  description:
    'Add a chart (bar, line, pie, scatter, area, column) to a sheet using LibreOffice. Requires LibreOffice installed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      chart: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'area', 'column'] },
          title: { type: 'string' },
          dataRange: { type: 'string', description: 'Data range, e.g. "A1:D10"' },
          categoryRange: { type: 'string', description: 'Category labels range (optional)' },
          position: {
            type: 'object',
            properties: {
              from: { type: 'object', properties: { col: { type: 'number' }, row: { type: 'number' } }, required: ['col', 'row'] },
              to: { type: 'object', properties: { col: { type: 'number' }, row: { type: 'number' } }, required: ['col', 'row'] },
            },
            required: ['from', 'to'],
          },
        },
        required: ['type', 'dataRange', 'position'],
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'chart'],
  },
}

const XLSX_PIVOT_SUMMARY: ToolDefinition = {
  type: 'function',
  name: 'xlsx_create_pivot',
  display_name: 'Pivot Summary',
  description:
    'Create a PivotTable using LibreOffice (soffice) or generate a pivot-style summary sheet. Use engine="soffice" for a real PivotTable and engine="summary" for pure ExcelJS summary output.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      engine: {
        type: 'string',
        enum: ['soffice', 'summary'],
        description: 'Execution engine. soffice=real PivotTable, summary=grouped summary sheet. Defaults to "soffice".',
      },
      sheet: { type: 'string', description: 'Source sheet name. Defaults to first sheet.' },
      dataRange: { type: 'string', description: 'Data range including header row, e.g. "A1:E100"' },
      config: {
        type: 'object',
        properties: {
          rowFields: {
            type: 'array',
            description: 'Column numbers (1-based) to group by',
            items: { type: 'integer' },
          },
          valueFields: {
            type: 'array',
            description: 'Columns to aggregate',
            items: {
              type: 'object',
              properties: {
                column: { type: 'integer', description: 'Column number (1-based)' },
                aggregation: { type: 'string', enum: ['sum', 'count', 'average', 'min', 'max'] },
              },
              required: ['column', 'aggregation'],
            },
          },
        },
        required: ['rowFields', 'valueFields'],
      },
      outputSheet: { type: 'string', description: 'Output sheet name. Defaults to "PivotTable" for soffice, "PivotSummary" for summary.' },
      outputPath: { type: 'string' },
    },
    required: ['path', 'dataRange', 'config'],
  },
}

// ─── P4: High Priority ExcelJS Native ────────

const XLSX_TABLE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_manage_tables',
  display_name: 'Table',
  description:
    'Create, get, remove, or list Excel tables (structured ranges with headers, filters, totals row, and theme styling).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: { type: 'string', enum: ['add', 'get', 'remove', 'list'], description: 'Action to perform' },
      table: {
        type: 'object',
        description: 'Table definition (required for "add" action)',
        properties: {
          name: { type: 'string', description: 'Table name (unique in workbook, no spaces, cannot start with number)' },
          ref: { type: 'string', description: 'Table range, e.g. "A1:D10"' },
          headerRow: { type: 'boolean', description: 'Show header row. Defaults to true.' },
          totalsRow: { type: 'boolean', description: 'Show totals row. Defaults to false.' },
          style: {
            type: 'object',
            properties: {
              theme: { type: 'string', description: 'Table theme name, e.g. "TableStyleMedium2"' },
              showRowStripes: { type: 'boolean' },
              showColumnStripes: { type: 'boolean' },
              showFirstColumn: { type: 'boolean' },
              showLastColumn: { type: 'boolean' },
            },
          },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                filterButton: { type: 'boolean' },
                totalsRowLabel: { type: 'string' },
                totalsRowFunction: { type: 'string', enum: ['none', 'average', 'countNums', 'count', 'max', 'min', 'stdDev', 'var', 'sum', 'custom'] },
                totalsRowFormula: { type: 'string' },
              },
              required: ['name'],
            },
          },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Array of row data arrays' },
        },
      },
      tableName: { type: 'string', description: 'Table name (for "get" and "remove" actions)' },
      outputPath: { type: 'string' },
    },
    required: ['path', 'action'],
  },
}

const XLSX_COMMENT: ToolDefinition = {
  type: 'function',
  name: 'xlsx_manage_comments',
  display_name: 'Comment',
  description:
    'Add, remove, or list cell comments (notes) in an Excel file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: { type: 'string', enum: ['add', 'remove', 'list'], description: 'Action to perform' },
      comments: {
        type: 'array',
        description: 'Array of comment operations (required for "add" and "remove")',
        items: {
          type: 'object',
          properties: {
            cell: { type: 'string', description: 'Cell address, e.g. "A1"' },
            text: { type: 'string', description: 'Comment text (for "add")' },
            author: { type: 'string', description: 'Comment author (optional)' },
          },
          required: ['cell'],
        },
      },
      range: { type: 'string', description: 'Cell range to list comments from (optional for "list", defaults to entire sheet)' },
      outputPath: { type: 'string' },
    },
    required: ['path', 'action'],
  },
}

const XLSX_PAGE_SETUP: ToolDefinition = {
  type: 'function',
  name: 'xlsx_setup_page',
  display_name: 'Page Setup',
  description:
    'Get or set print/page setup settings: paper size, orientation, margins, print area, repeat headers, fit-to-page, centering, grid lines.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: { type: 'string', enum: ['set', 'get'], description: 'Set or get page setup. Defaults to "set".' },
      settings: {
        type: 'object',
        description: 'Page setup settings (required for "set")',
        properties: {
          paperSize: { type: 'integer', description: 'Paper size code (9=A4, 1=Letter)' },
          orientation: { type: 'string', enum: ['portrait', 'landscape'] },
          margins: {
            type: 'object',
            properties: {
              top: { type: 'number' }, bottom: { type: 'number' },
              left: { type: 'number' }, right: { type: 'number' },
              header: { type: 'number' }, footer: { type: 'number' },
            },
          },
          fitToPage: { type: 'boolean' },
          fitToWidth: { type: 'integer' },
          fitToHeight: { type: 'integer' },
          scale: { type: 'integer', description: 'Print scale percentage' },
          printArea: { type: 'string', description: 'Print area range, e.g. "A1:G20"' },
          printTitlesRow: { type: 'string', description: 'Rows to repeat, e.g. "1:1"' },
          printTitlesColumn: { type: 'string', description: 'Columns to repeat, e.g. "A:A"' },
          horizontalCentered: { type: 'boolean' },
          verticalCentered: { type: 'boolean' },
          showGridLines: { type: 'boolean' },
          showRowColHeaders: { type: 'boolean' },
          pageOrder: { type: 'string', enum: ['downThenOver', 'overThenDown'] },
          blackAndWhite: { type: 'boolean' },
          draft: { type: 'boolean' },
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path'],
  },
}

const XLSX_HEADER_FOOTER: ToolDefinition = {
  type: 'function',
  name: 'xlsx_set_header',
  display_name: 'Header & Footer',
  description:
    'Get or set sheet header/footer text with format codes: &L(left) &C(center) &R(right) &P(page#) &N(total) &D(date) &T(time) &F(file) &A(sheet).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: { type: 'string', enum: ['set', 'get'], description: 'Set or get headers/footers. Defaults to "set".' },
      settings: {
        type: 'object',
        description: 'Header/footer settings (required for "set")',
        properties: {
          oddHeader: { type: 'string' },
          oddFooter: { type: 'string' },
          evenHeader: { type: 'string' },
          evenFooter: { type: 'string' },
          firstHeader: { type: 'string' },
          firstFooter: { type: 'string' },
          differentFirst: { type: 'boolean' },
          differentOddEven: { type: 'boolean' },
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path'],
  },
}

const XLSX_CSV_IO: ToolDefinition = {
  type: 'function',
  name: 'xlsx_convert_csv',
  display_name: 'CSV Import/Export',
  description:
    'Convert between CSV and XLSX using ExcelJS (no LibreOffice needed). read: CSV→XLSX, write: XLSX→CSV.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write'], description: 'read=CSV→XLSX, write=XLSX→CSV' },
      path: { type: 'string', description: 'Path to the XLSX file (output for read, input for write)' },
      csvPath: { type: 'string', description: 'Path to the CSV file (input for read, output for write)' },
      options: {
        type: 'object',
        properties: {
          sheetName: { type: 'string', description: 'Sheet name for the conversion' },
          delimiter: { type: 'string', description: 'CSV delimiter. Defaults to ","' },
          encoding: { type: 'string', description: 'File encoding. Defaults to "utf-8"' },
          dateFormats: { type: 'array', items: { type: 'string' }, description: 'Date format patterns for parsing (read)' },
          dateFormat: { type: 'string', description: 'Date format for output (write)' },
          dateUTC: { type: 'boolean' },
          sheetId: { type: 'integer', description: 'Sheet ID to export (write). Defaults to first sheet.' },
          includeEmptyRows: { type: 'boolean' },
        },
      },
      outputPath: { type: 'string', description: 'Override output XLSX path (for read action)' },
    },
    required: ['action', 'path', 'csvPath'],
  },
}

const XLSX_WORKBOOK_PROPERTIES: ToolDefinition = {
  type: 'function',
  name: 'xlsx_set_metadata',
  display_name: 'Workbook Properties',
  description:
    'Get or set workbook metadata: creator, title, subject, description, keywords, category, company, dates.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      action: { type: 'string', enum: ['set', 'get'], description: 'Set or get properties. Defaults to "set".' },
      properties: {
        type: 'object',
        description: 'Workbook properties to set (required for "set")',
        properties: {
          creator: { type: 'string' },
          lastModifiedBy: { type: 'string' },
          created: { type: 'string', description: 'ISO date string' },
          modified: { type: 'string', description: 'ISO date string' },
          title: { type: 'string' },
          subject: { type: 'string' },
          description: { type: 'string' },
          keywords: { type: 'string' },
          category: { type: 'string' },
          company: { type: 'string' },
          manager: { type: 'string' },
          calcProperties: {
            type: 'object',
            properties: { fullCalcOnLoad: { type: 'boolean' } },
          },
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path'],
  },
}

// ─── P5: Medium Priority ExcelJS Native ──────

const XLSX_OUTLINE_GROUP: ToolDefinition = {
  type: 'function',
  name: 'xlsx_set_outline',
  display_name: 'Outline Group',
  description:
    'Group rows or columns into collapsible outline levels (grouping/ungrouping for hierarchical data).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['row', 'column'] },
            start: { type: 'integer', description: 'Start row/column number (1-based)' },
            end: { type: 'integer', description: 'End row/column number (1-based)' },
            outlineLevel: { type: 'integer', description: 'Outline level (0=ungrouped, 1+=grouped)' },
            collapsed: { type: 'boolean', description: 'Whether the group is collapsed' },
          },
          required: ['type', 'start', 'end', 'outlineLevel'],
        },
      },
      outlineProperties: {
        type: 'object',
        properties: {
          summaryBelow: { type: 'boolean', description: 'Summary row below detail rows. Defaults to true.' },
          summaryRight: { type: 'boolean', description: 'Summary column right of detail columns. Defaults to true.' },
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'operations'],
  },
}

const XLSX_SHEET_STATE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_hide_sheets',
  display_name: 'Sheet State',
  description:
    'Set sheet visibility: visible, hidden, or veryHidden (cannot be unhidden from Excel UI). At least one sheet must remain visible.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sheet: { type: 'string', description: 'Sheet name' },
            state: { type: 'string', enum: ['visible', 'hidden', 'veryHidden'] },
          },
          required: ['sheet', 'state'],
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'operations'],
  },
}

const XLSX_ROW_COL_VISIBILITY: ToolDefinition = {
  type: 'function',
  name: 'xlsx_set_visibility',
  display_name: 'Row/Column Visibility',
  description:
    'Show or hide entire row/column ranges in a worksheet to control display without deleting underlying data.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['row', 'column'] },
            start: { type: 'integer', description: 'Start row/column number (1-based)' },
            end: { type: 'integer', description: 'End row/column number (optional, defaults to start)' },
            hidden: { type: 'boolean', description: 'true=hide, false=show' },
          },
          required: ['type', 'start', 'hidden'],
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'operations'],
  },
}

const XLSX_CELL_PROTECTION: ToolDefinition = {
  type: 'function',
  name: 'xlsx_lock_cells',
  display_name: 'Cell Protection',
  description:
    'Lock or unlock individual cells for form-style sheets. Use with xlsx_protect_sheet for locks to take effect.',
  guide: 'Cell protection only works when the sheet is protected via xlsx_protect_sheet. Unlock specific cells (locked=false) to allow editing while the rest of the sheet is locked.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            range: { type: 'string', description: 'Cell range, e.g. "B2:B10"' },
            locked: { type: 'boolean', description: 'Lock cells (true) or unlock (false). Defaults to true.' },
            hidden: { type: 'boolean', description: 'Hide formula in formula bar. Defaults to false.' },
          },
          required: ['range'],
        },
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'operations'],
  },
}

const XLSX_DUPLICATE_ROW: ToolDefinition = {
  type: 'function',
  name: 'xlsx_duplicate_rows',
  display_name: 'Duplicate Row',
  description:
    'Duplicate a row (values + formatting) one or more times, optionally inserting new rows.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      rowNumber: { type: 'integer', description: 'Row number (1-based) to duplicate' },
      count: { type: 'integer', description: 'Number of copies. Defaults to 1.' },
      insert: { type: 'boolean', description: 'Insert new rows (true) or overwrite below (false). Defaults to true.' },
      outputPath: { type: 'string' },
    },
    required: ['path', 'rowNumber'],
  },
}

const XLSX_BACKGROUND_IMAGE: ToolDefinition = {
  type: 'function',
  name: 'xlsx_set_background',
  display_name: 'Background Image',
  description:
    'Set a background image (watermark) on a sheet. Only one background per sheet; setting again replaces it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      image: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to image file' },
          base64: { type: 'string', description: 'Base64-encoded image data (alternative to filePath)' },
          extension: { type: 'string', enum: ['png', 'jpeg', 'gif'], description: 'Image format' },
        },
        required: ['extension'],
      },
      outputPath: { type: 'string' },
    },
    required: ['path', 'image'],
  },
}

// ─── P6: Formula ─────────────────────────────

const XLSX_FORMULA: ToolDefinition = {
  type: 'function',
  name: 'xlsx_manage_formulas',
  display_name: 'Formula',
  description:
    'Insert, fill, array-enter, clear, or list Excel formulas. Automatically enables fullCalcOnLoad so Excel recalculates on open.',
  guide: `## Excel Formula Reference

**IMPORTANT**: ExcelJS stores formulas as strings — it does NOT compute results. Use xlsx_recalc_formulas (LibreOffice) if you need computed values in the file. Otherwise, Excel will auto-calculate when the user opens the file (fullCalcOnLoad is set automatically).

### Actions
- **set**: Insert formulas into specific cells. Use for individual or scattered formula placement.
- **fill**: Apply one master formula to a range, auto-translating cell references (like dragging fill handle in Excel). Use \`$\` for absolute references.
- **array**: Insert a CSE array formula (Ctrl+Shift+Enter) over a result range.
- **clear**: Remove formulas from cells, preserving their last cached values.
- **list**: List all formulas in a sheet or specific range.

### Common Formula Patterns

**Math & Aggregation**
- SUM(A1:A100), SUMIF(A:A,"criteria",B:B), SUMIFS(C:C,A:A,">10",B:B,"<5")
- AVERAGE(A1:A100), AVERAGEIF(A:A,">0",B:B)
- COUNT(A1:A100), COUNTA(A1:A100), COUNTIF(A:A,">0"), COUNTIFS(A:A,">0",B:B,"<100")
- MIN(A1:A100), MAX(A1:A100), MEDIAN(A1:A100)
- ROUND(A1,2), ROUNDUP(A1,0), ROUNDDOWN(A1,0), INT(A1), MOD(A1,B1)
- SUMPRODUCT(A1:A10,B1:B10), ABS(A1), POWER(A1,2), SQRT(A1)

**Lookup & Reference**
- VLOOKUP(lookup,table_range,col_index,FALSE)
- HLOOKUP(lookup,table_range,row_index,FALSE)
- INDEX(range,row_num,col_num), MATCH(lookup,range,0)
- INDEX+MATCH combo: INDEX(B:B,MATCH(lookup,A:A,0))
- XLOOKUP(lookup,lookup_array,return_array,"not found",0) — Excel 365+
- OFFSET(ref,rows,cols,height,width), INDIRECT("A"&B1)
- ROW(), COLUMN(), ADDRESS(row,col)

**Logic**
- IF(condition,true_val,false_val)
- IFS(cond1,val1,cond2,val2,...) — Excel 2019+
- AND(cond1,cond2), OR(cond1,cond2), NOT(cond)
- IFERROR(value,error_val), IFNA(value,na_val)
- SWITCH(expr,val1,result1,val2,result2,...,default)
- IF+AND: IF(AND(A1>0,B1<100),"Yes","No")
- Nested IF: IF(A1>90,"A",IF(A1>80,"B",IF(A1>70,"C","F")))

**Text**
- CONCATENATE(A1," ",B1) or A1&" "&B1
- TEXTJOIN(delimiter,ignore_empty,range) — Excel 2019+
- LEFT(text,n), RIGHT(text,n), MID(text,start,n)
- LEN(text), TRIM(text), CLEAN(text)
- UPPER(text), LOWER(text), PROPER(text)
- SUBSTITUTE(text,old,new), REPLACE(text,start,n,new)
- TEXT(value,format) — e.g., TEXT(A1,"#,##0"), TEXT(A1,"yyyy-mm-dd")
- FIND(find_text,text), SEARCH(find_text,text) — SEARCH is case-insensitive
- VALUE(text) — convert text to number

**Date & Time**
- TODAY(), NOW(), DATE(year,month,day)
- YEAR(date), MONTH(date), DAY(date), WEEKDAY(date)
- DATEDIF(start,end,"Y"/"M"/"D")
- EDATE(date,months), EOMONTH(date,months)
- NETWORKDAYS(start,end,holidays), WORKDAY(start,days,holidays)
- TEXT(date,"yyyy-mm-dd"), TEXT(date,"yyyy\"년\" m\"월\" d\"일\"")

**Financial**
- PMT(rate,nper,pv) — periodic payment
- FV(rate,nper,pmt,pv) — future value
- PV(rate,nper,pmt,fv) — present value
- NPV(rate,values...), IRR(values,guess)
- XNPV(rate,values,dates), XIRR(values,dates)
- RATE(nper,pmt,pv), NPER(rate,pmt,pv)

**Statistical**
- STDEV(range), STDEV.S(range), STDEV.P(range)
- VAR(range), VAR.S(range), VAR.P(range)
- PERCENTILE(range,k), QUARTILE(range,quart)
- RANK(number,range,order), RANK.EQ(number,range,order)
- LARGE(range,k), SMALL(range,k)
- CORREL(array1,array2), COVARIANCE.P(array1,array2)
- FORECAST(x,known_y,known_x)

**Percentage & Growth**
- Growth rate: (B2-B1)/B1 → format as percentage
- YoY change: (B2-B1)/ABS(B1)
- CAGR: (end/start)^(1/years)-1
- Weighted average: SUMPRODUCT(values,weights)/SUM(weights)

### Fill Examples
- Master "=SUM(B$1:B1)" at B2, fill B2:B20 → running total
- Master "=A2*$D$1" at B2, fill B2:B100 → multiply column by fixed cell
- Master "=B2-B1" at C2, fill C2:C20 → differences

### Tips
- Use fill action for repetitive formulas (more efficient than setting each cell)
- Use $ for absolute references: $A$1 (both fixed), $A1 (col fixed), A$1 (row fixed)
- For cross-sheet references: Sheet2!A1 or 'Sheet Name'!A1
- Named ranges work in formulas: =SUM(SalesData)
- After inserting formulas, use xlsx_recalc_formulas to compute results in the file, or let Excel compute on open
`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .xlsx file' },
      sheet: { type: 'string', description: 'Sheet name. Defaults to first sheet.' },
      action: {
        type: 'string',
        enum: ['set', 'fill', 'array', 'clear', 'list'],
        description: 'set=insert formulas, fill=auto-fill range, array=CSE array formula, clear=remove formulas (keep values), list=show formulas',
      },
      formulas: {
        type: 'array',
        description: 'For "set": array of cell+formula pairs',
        items: {
          type: 'object',
          properties: {
            cell: { type: 'string', description: 'Cell address, e.g. "B2"' },
            formula: { type: 'string', description: 'Excel formula WITHOUT leading "=", e.g. "SUM(A1:A10)"' },
            result: { description: 'Optional cached result value (string, number, or boolean)' },
          },
          required: ['cell', 'formula'],
        },
      },
      fill: {
        type: 'object',
        description: 'For "fill": master formula + fill range. References auto-translate like Excel fill handle.',
        properties: {
          masterCell: { type: 'string', description: 'Master cell address (top-left of fill range), e.g. "B2"' },
          formula: { type: 'string', description: 'Formula for master cell (without "="). Use $ for absolute refs.' },
          fillRange: { type: 'string', description: 'Range to fill, e.g. "B2:B20". Master cell should be at the start.' },
          result: { description: 'Optional cached result for master cell' },
        },
        required: ['masterCell', 'formula', 'fillRange'],
      },
      array: {
        type: 'object',
        description: 'For "array": CSE array formula (Ctrl+Shift+Enter)',
        properties: {
          range: { type: 'string', description: 'Result range, e.g. "D1:D5"' },
          formula: { type: 'string', description: 'Array formula (without "=")' },
        },
        required: ['range', 'formula'],
      },
      clearRange: { type: 'string', description: 'For "clear": range to clear formulas from, e.g. "A1:C10"' },
      listRange: { type: 'string', description: 'For "list": optional range to limit (omit to scan entire sheet)' },
      outputPath: { type: 'string', description: 'Output file path (not needed for "list")' },
    },
    required: ['path', 'action'],
  },
}

// ─── Exports ─────────────────────────────────

export const XLSX_TOOLS: ToolDefinition[] = [
  XLSX_INIT_TASK,
  XLSX_WRITE_SOURCE,
  XLSX_WRITE_INTERMEDIATE,
  XLSX_PACK_TASK,
  XLSX_UNPACK_TASK,
  XLSX_READ_PARSED,
  XLSX_READ_SOURCE,
  // Core (existing)
  XLSX_READ,
  XLSX_EXTRACT_STYLES,
  XLSX_UPDATE_CELLS,
  XLSX_INSERT_ROWS,
  XLSX_DELETE_ROWS,
  XLSX_INSERT_COLUMNS,
  XLSX_DELETE_COLUMNS,
  XLSX_FORMAT_CELLS,
  XLSX_CREATE,
  XLSX_MANAGE_SHEETS,
  XLSX_CONVERT,
  XLSX_RECALC,
  // P0
  XLSX_MERGE_CELLS,
  XLSX_SORT_DATA,
  XLSX_AUTO_FILTER,
  XLSX_DATA_VALIDATION,
  // P1
  XLSX_CONDITIONAL_FORMATTING,
  XLSX_SET_SHEET_PROPERTIES,
  XLSX_PROTECT_SHEET,
  XLSX_ADD_IMAGE,
  // P2
  XLSX_NAMED_RANGES,
  XLSX_REMOVE_DUPLICATES,
  XLSX_FIND_REPLACE,
  XLSX_HYPERLINK,
  // P3
  XLSX_ADD_CHART,
  XLSX_PIVOT_SUMMARY,
  // P4
  XLSX_TABLE,
  XLSX_COMMENT,
  XLSX_PAGE_SETUP,
  XLSX_HEADER_FOOTER,
  XLSX_CSV_IO,
  XLSX_WORKBOOK_PROPERTIES,
  // P5
  XLSX_OUTLINE_GROUP,
  XLSX_SHEET_STATE,
  XLSX_ROW_COL_VISIBILITY,
  XLSX_CELL_PROTECTION,
  XLSX_DUPLICATE_ROW,
  XLSX_BACKGROUND_IMAGE,
  // P6: Formula
  XLSX_FORMULA,
]

// ─── Helpers ─────────────────────────────────

function formatRecalcResult(result: RecalcResult): ToolResult {
  if ('error' in result) {
    return { success: false, output: result.error };
  }
  const lines: string[] = [];
  lines.push(`Status: ${result.status}`);
  lines.push(`Total formulas: ${result.total_formulas}`);
  if (result.total_errors > 0) {
    lines.push(`Total errors: ${result.total_errors}`);
    for (const [errorType, info] of Object.entries(result.error_summary)) {
      lines.push(`  ${errorType}: ${info.count} occurrence(s)`);
      for (const loc of info.locations.slice(0, 5)) {
        lines.push(`    - ${loc}`);
      }
    }
  }
  return { success: true, output: lines.join('\n') };
}

// ─── Dispatcher ──────────────────────────────

export async function handleXlsxTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'xlsx_init_task':
      return xlsxInitTask(args as Parameters<typeof xlsxInitTask>[0]);
    case 'xlsx_write_source':
      return xlsxWriteSource(args as Parameters<typeof xlsxWriteSource>[0]);
    case 'xlsx_write_intermediate':
      return xlsxWriteIntermediate(args as Parameters<typeof xlsxWriteIntermediate>[0]);
    case 'xlsx_pack_workbook':
      return xlsxPackTask(args as Parameters<typeof xlsxPackTask>[0]);
    case 'xlsx_unpack_workbook':
      return xlsxUnpackTask(args as Parameters<typeof xlsxUnpackTask>[0]);
    case 'xlsx_read_parsed':
      return xlsxReadParsed(args as Parameters<typeof xlsxReadParsed>[0]);
    case 'xlsx_read_source':
      return xlsxReadSource(args as Parameters<typeof xlsxReadSource>[0]);
    case 'xlsx_read_data':
      return xlsxRead(args as Parameters<typeof xlsxRead>[0]);
    case 'xlsx_extract_styles':
      return parseTemplateStyle(args as Parameters<typeof parseTemplateStyle>[0]);
    case 'xlsx_update_cells':
      return xlsxUpdateCells(args as Parameters<typeof xlsxUpdateCells>[0]);
    case 'xlsx_insert_rows':
      return xlsxInsertRows(args as Parameters<typeof xlsxInsertRows>[0]);
    case 'xlsx_delete_rows':
      return xlsxDeleteRows(args as Parameters<typeof xlsxDeleteRows>[0]);
    case 'xlsx_insert_columns':
      return xlsxInsertColumns(args as Parameters<typeof xlsxInsertColumns>[0]);
    case 'xlsx_delete_columns':
      return xlsxDeleteColumns(args as Parameters<typeof xlsxDeleteColumns>[0]);
    case 'xlsx_format_cells':
      return xlsxFormatCells(args as Parameters<typeof xlsxFormatCells>[0]);
    case 'xlsx_create_workbook':
      return xlsxCreate(args as Parameters<typeof xlsxCreate>[0]);
    case 'xlsx_manage_sheets':
      return xlsxManageSheets(args as Parameters<typeof xlsxManageSheets>[0]);
    case 'xlsx_convert_file':
      return xlsxConvert(args as Parameters<typeof xlsxConvert>[0]);
    case 'xlsx_merge_cells':
      return xlsxMergeCells(args as Parameters<typeof xlsxMergeCells>[0]);
    case 'xlsx_sort_data':
      return xlsxSortData(args as Parameters<typeof xlsxSortData>[0]);
    case 'xlsx_set_filter':
      return xlsxAutoFilter(args as Parameters<typeof xlsxAutoFilter>[0]);
    case 'xlsx_set_validation':
      return xlsxDataValidation(args as Parameters<typeof xlsxDataValidation>[0]);
    case 'xlsx_manage_conditions':
      return xlsxConditionalFormatting(args as Parameters<typeof xlsxConditionalFormatting>[0]);
    case 'xlsx_set_properties':
      return xlsxSetSheetProperties(args as Parameters<typeof xlsxSetSheetProperties>[0]);
    case 'xlsx_protect_sheet':
      return xlsxProtectSheet(args as Parameters<typeof xlsxProtectSheet>[0]);
    case 'xlsx_add_image':
      return xlsxAddImage(args as Parameters<typeof xlsxAddImage>[0]);
    case 'xlsx_manage_ranges':
      return xlsxNamedRanges(args as Parameters<typeof xlsxNamedRanges>[0]);
    case 'xlsx_remove_duplicates':
      return xlsxRemoveDuplicates(args as Parameters<typeof xlsxRemoveDuplicates>[0]);
    case 'xlsx_replace_text':
      return xlsxFindReplace(args as Parameters<typeof xlsxFindReplace>[0]);
    case 'xlsx_manage_hyperlinks':
      return xlsxHyperlink(args as Parameters<typeof xlsxHyperlink>[0]);
    case 'xlsx_add_chart':
      return xlsxAddChart(args as Parameters<typeof xlsxAddChart>[0]);
    case 'xlsx_create_pivot':
      return xlsxPivotSummary(args as Parameters<typeof xlsxPivotSummary>[0]);
    // P4
    case 'xlsx_manage_tables':
      return xlsxTable(args as Parameters<typeof xlsxTable>[0]);
    case 'xlsx_manage_comments':
      return xlsxComment(args as Parameters<typeof xlsxComment>[0]);
    case 'xlsx_setup_page':
      return xlsxPageSetup(args as Parameters<typeof xlsxPageSetup>[0]);
    case 'xlsx_set_header':
      return xlsxHeaderFooter(args as Parameters<typeof xlsxHeaderFooter>[0]);
    case 'xlsx_convert_csv':
      return xlsxCsvIo(args as Parameters<typeof xlsxCsvIo>[0]);
    case 'xlsx_set_metadata':
      return xlsxWorkbookProperties(args as Parameters<typeof xlsxWorkbookProperties>[0]);
    // P5
    case 'xlsx_set_outline':
      return xlsxOutlineGroup(args as Parameters<typeof xlsxOutlineGroup>[0]);
    case 'xlsx_hide_sheets':
      return xlsxSheetState(args as Parameters<typeof xlsxSheetState>[0]);
    case 'xlsx_set_visibility':
      return xlsxRowColVisibility(args as Parameters<typeof xlsxRowColVisibility>[0]);
    case 'xlsx_lock_cells':
      return xlsxCellProtection(args as Parameters<typeof xlsxCellProtection>[0]);
    case 'xlsx_duplicate_rows':
      return xlsxDuplicateRow(args as Parameters<typeof xlsxDuplicateRow>[0]);
    case 'xlsx_set_background':
      return xlsxBackgroundImage(args as Parameters<typeof xlsxBackgroundImage>[0]);
    // P6: Formula
    case 'xlsx_manage_formulas':
      return xlsxFormula(args as Parameters<typeof xlsxFormula>[0]);
    case 'xlsx_recalc_formulas': {
      const result = await recalc(
        args.path as string,
        args.timeout_seconds as number | undefined
      );
      return formatRecalcResult(result);
    }
    default:
      return { success: false, output: `Unknown XLSX tool: ${toolName}` };
  }
}
