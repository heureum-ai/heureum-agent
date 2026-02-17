/**
 * PPT ToolDefinitions + handler for LLM tool binding.
 * 3 tools: add_slide, clean, create_thumbnails.
 * add_slide and clean operate on .pptx files via unpack -> work -> pack lifecycle.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { unpack } from "./unpack";
import { pack } from "./pack";
import { addSlide } from "./add-slide";
import { cleanPptx } from "./clean";
import { createPptxThumbnails } from "./thumbnail";

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

const PPT_ADD_SLIDE: ToolDefinition = {
  type: 'function',
  name: 'ppt_add_slide',
  description:
    'Add a new slide to a PPTX file. Specify a source slide to duplicate (e.g. "slide1.xml") or a layout name (e.g. "layout:Title Slide").',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .pptx file (must be within the working directory)' },
      source: {
        type: 'string',
        description: 'Source slide to duplicate (e.g. "slide1.xml") or layout (e.g. "layout:Title Slide")',
      },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.pptx.',
      },
    },
    required: ['path', 'source'],
  },
}

const PPT_CLEAN: ToolDefinition = {
  type: 'function',
  name: 'ppt_clean',
  description: 'Remove unreferenced files (unused media, layouts, etc.) from a PPTX to reduce file size.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .pptx file (must be within the working directory)' },
      output_path: {
        type: 'string',
        description: 'Output file path within the working directory. Defaults to {basename}_modified.pptx.',
      },
    },
    required: ['path'],
  },
}

const PPT_CREATE_THUMBNAILS: ToolDefinition = {
  type: 'function',
  name: 'ppt_create_thumbnails',
  description:
    'Create a thumbnail grid image from PPTX slides using LibreOffice for rendering.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the .pptx file (must be within the working directory)' },
      output_prefix: {
        type: 'string',
        description: 'Output file prefix (produces {prefix}.jpg). Defaults to "thumbnails".',
      },
      cols: { type: 'integer', description: 'Number of columns in the grid. Defaults to 3, max 6.' },
    },
    required: ['path'],
  },
}

export const PPT_TOOLS: ToolDefinition[] = [
  PPT_ADD_SLIDE,
  PPT_CLEAN,
  PPT_CREATE_THUMBNAILS,
]

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppt-tool-"));
}

function defaultOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  return path.join(dir, `${base}_modified${ext}`);
}

function cleanupDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

export async function handlePptTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'ppt_add_slide': {
      const pptxPath = args.path as string;
      const source = args.source as string;
      const outputPath = (args.output_path as string) || defaultOutputPath(pptxPath);
      const tmpDir = makeTempDir();
      try {
        await unpack(pptxPath, tmpDir);
        const result = addSlide(tmpDir, source);
        if (!result.success) {
          return result;
        }
        await pack(tmpDir, outputPath, { originalFile: pptxPath });
        return { success: true, output: `${result.output}\nSaved to ${outputPath}` };
      } catch (err: any) {
        return { success: false, output: err.message || 'ppt_add_slide failed' };
      } finally {
        cleanupDir(tmpDir);
      }
    }
    case 'ppt_clean': {
      const pptxPath = args.path as string;
      const outputPath = (args.output_path as string) || defaultOutputPath(pptxPath);
      const tmpDir = makeTempDir();
      try {
        await unpack(pptxPath, tmpDir);
        const result = cleanPptx(tmpDir);
        if (!result.success) {
          return result;
        }
        await pack(tmpDir, outputPath, { originalFile: pptxPath });
        return { success: true, output: `${result.output}\nSaved to ${outputPath}` };
      } catch (err: any) {
        return { success: false, output: err.message || 'ppt_clean failed' };
      } finally {
        cleanupDir(tmpDir);
      }
    }
    case 'ppt_create_thumbnails': {
      try {
        const result = await createPptxThumbnails({
          input: args.path as string,
          outputPrefix: args.output_prefix as string | undefined,
          cols: args.cols as number | undefined,
        });
        return { success: result.success, output: result.output };
      } catch (err: any) {
        return { success: false, output: err.message || 'ppt_create_thumbnails failed' };
      }
    }
    default:
      return { success: false, output: `Unknown PPT tool: ${toolName}` };
  }
}
