/**
 * XLSX ToolDefinition + handler for LLM tool binding.
 * 1 tool: xlsx_recalc — recalculate formulas via LibreOffice.
 */

import { recalc, type RecalcResult } from "./recalc";

interface ToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, any>
  guide?: string
}

export interface ToolResult {
  success: boolean
  output: string
}

const XLSX_RECALC: ToolDefinition = {
  type: 'function',
  name: 'xlsx_recalc',
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

export const XLSX_TOOLS: ToolDefinition[] = [XLSX_RECALC]

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

export async function handleXlsxTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'xlsx_recalc': {
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
