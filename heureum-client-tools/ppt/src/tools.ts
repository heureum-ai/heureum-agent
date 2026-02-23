import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { unpack } from "./unpack";
import { pack } from "./pack";
import { addSlide } from "./add-slide";
import { cleanPptx } from "./clean";
import { createPptxThumbnails } from "./thumbnail";
import {
  PptPipeline,
  PPT_STEP_INTERMEDIATE,
  PPT_STEP_OUTPUT,
  PPT_STEP_PARSED,
  PPT_STEP_SOURCE,
  pptPipelineFromTaskDir,
} from "./pipeline";
import type { ToolResult } from "./types";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


export type { PptToolResult, ToolResult } from "./types";

export const PPT_INIT_TASK_TOOL = "ppt_init_task" as const;
export const PPT_WRITE_SOURCE_TOOL = "ppt_write_source" as const;
export const PPT_WRITE_INTERMEDIATE_TOOL = "ppt_write_intermediate" as const;
export const PPT_PACK_TASK_TOOL = "ppt_pack_presentation" as const;
export const PPT_UNPACK_TASK_TOOL = "ppt_unpack_presentation" as const;
export const PPT_READ_PARSED_TOOL = "ppt_read_parsed" as const;
export const PPT_READ_SOURCE_TOOL = "ppt_read_source" as const;

export const PPT_ADD_SLIDE_TOOL = "ppt_add_slide" as const;
export const PPT_CLEAN_PRESENTATION_TOOL = "ppt_clean_presentation" as const;
export const PPT_CREATE_THUMBNAILS_TOOL = "ppt_create_thumbnails" as const;

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

function buildSlideSummary(unpackedDir: string): {
  slideCount: number;
  slides: string[];
} {
  const slidesDir = path.join(unpackedDir, "ppt", "slides");
  if (!fs.existsSync(slidesDir)) {
    return { slideCount: 0, slides: [] };
  }

  const slides = fs
    .readdirSync(slidesDir)
    .filter((name) => /^slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const aNum = Number(a.replace(/[^0-9]/g, ""));
      const bNum = Number(b.replace(/[^0-9]/g, ""));
      return aNum - bNum;
    });

  return { slideCount: slides.length, slides };
}

export async function pptInitTask(params: {
  session_id: string;
  task_id: string;
  work_dir?: string;
}): Promise<ToolResult> {
  try {
    if (!params.session_id) return { success: false, output: "Missing required parameter: session_id" };
    if (!params.task_id) return { success: false, output: "Missing required parameter: task_id" };

    const pipeline = new PptPipeline({
      sessionId: params.session_id,
      taskType: "ppt",
      taskId: params.task_id,
      workDir: params.work_dir,
    });
    pipeline.ensureStepDirs();
    await pipeline.setMeta({
      sessionId: params.session_id,
      taskType: "ppt",
      taskId: params.task_id,
      createdAt: new Date().toISOString(),
    });

    return {
      success: true,
      output: `Task initialized at: ${pipeline.taskDir}`,
      outputPath: pipeline.taskDir,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function pptWriteSource(params: {
  task_dir: string;
  input_path: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    if (!params.input_path) return { success: false, output: "Missing required parameter: input_path" };

    const inputPath = path.resolve(params.input_path);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const pipeline = pptPipelineFromTaskDir(params.task_dir);
    pipeline.ensureStepDirs();

    const sourcePath = path.join(pipeline.stepPath(PPT_STEP_SOURCE), "input.pptx");
    ;(await fs.promises.copyFile(inputPath, sourcePath));

    await pipeline.setMeta({ updatedAt: new Date().toISOString() });
    return { success: true, output: `Source written: ${sourcePath}`, outputPath: sourcePath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function pptWriteIntermediate(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };

    const pipeline = pptPipelineFromTaskDir(params.task_dir);
    pipeline.ensureStepDirs();

    const sourcePath = path.join(pipeline.stepPath(PPT_STEP_SOURCE), "input.pptx");
    if (!(await pathExists(sourcePath))) {
      return { success: false, output: "Missing source file. Run ppt_write_source first." };
    }

    const unpackDir = path.join(pipeline.stepPath(PPT_STEP_INTERMEDIATE), "unpacked");
    ;(await fs.promises.rm(unpackDir, { recursive: true, force: true }));

    const [, unpackMsg] = await unpack(sourcePath, unpackDir, {});
    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    const summary = buildSlideSummary(unpackDir);
    const parsedPath = path.join(pipeline.stepPath(PPT_STEP_PARSED), "summary.json");
    ;(await fs.promises.writeFile(parsedPath, JSON.stringify(summary, null, 2), "utf-8"));

    await pipeline.setMeta({ updatedAt: new Date().toISOString() });
    return {
      success: true,
      output: `Intermediate generated at: ${unpackDir}`,
      outputPath: unpackDir,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function pptPackTask(params: {
  task_dir: string;
  output_path?: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };

    const pipeline = pptPipelineFromTaskDir(params.task_dir);
    const unpackDir = path.join(pipeline.stepPath(PPT_STEP_INTERMEDIATE), "unpacked");
    if (!(await pathExists(unpackDir))) {
      return {
        success: false,
        output: "Missing intermediate unpacked folder. Run ppt_write_intermediate or ppt_unpack_presentation first.",
      };
    }

    const outputPath = params.output_path
      ? path.resolve(params.output_path)
      : path.join(pipeline.stepPath(PPT_STEP_OUTPUT), "result.pptx");

    const [, packMsg] = await pack(unpackDir, outputPath, { validate: false });
    if (packMsg.startsWith("Error")) {
      return { success: false, output: packMsg };
    }

    return { success: true, output: packMsg, outputPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function pptUnpackTask(params: {
  task_dir: string;
  input_path: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    if (!params.input_path) return { success: false, output: "Missing required parameter: input_path" };

    const inputPath = path.resolve(params.input_path);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const pipeline = pptPipelineFromTaskDir(params.task_dir);
    pipeline.ensureStepDirs();

    const sourcePath = path.join(pipeline.stepPath(PPT_STEP_SOURCE), "input.pptx");
    ;(await fs.promises.copyFile(inputPath, sourcePath));

    const unpackDir = path.join(pipeline.stepPath(PPT_STEP_INTERMEDIATE), "unpacked");
    ;(await fs.promises.rm(unpackDir, { recursive: true, force: true }));

    const [, unpackMsg] = await unpack(inputPath, unpackDir, {});
    if (unpackMsg.startsWith("Error")) {
      return { success: false, output: unpackMsg };
    }

    const summary = buildSlideSummary(unpackDir);
    const parsedPath = path.join(pipeline.stepPath(PPT_STEP_PARSED), "summary.json");
    ;(await fs.promises.writeFile(parsedPath, JSON.stringify(summary, null, 2), "utf-8"));

    return { success: true, output: unpackMsg, outputPath: unpackDir };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function pptReadParsed(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };

    const pipeline = pptPipelineFromTaskDir(params.task_dir);
    const parsedPath = path.join(pipeline.stepPath(PPT_STEP_PARSED), "summary.json");
    if (!(await pathExists(parsedPath))) {
      return { success: false, output: "Missing parsed summary. Run ppt_write_intermediate first." };
    }

    const summary = (await fs.promises.readFile(parsedPath, "utf-8"));
    return { success: true, output: summary, outputPath: parsedPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function pptReadSource(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };

    const pipeline = pptPipelineFromTaskDir(params.task_dir);
    const sourcePath = path.join(pipeline.stepPath(PPT_STEP_SOURCE), "input.pptx");
    if (!(await pathExists(sourcePath))) {
      return { success: false, output: "Missing source file. Run ppt_write_source first." };
    }

    const stat = (await fs.promises.stat(sourcePath));
    const payload = {
      path: sourcePath,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };

    return {
      success: true,
      output: JSON.stringify(payload, null, 2),
      outputPath: sourcePath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function handlePptTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case PPT_INIT_TASK_TOOL:
      return pptInitTask(args as Parameters<typeof pptInitTask>[0]);
    case PPT_WRITE_SOURCE_TOOL:
      return pptWriteSource(args as Parameters<typeof pptWriteSource>[0]);
    case PPT_WRITE_INTERMEDIATE_TOOL:
      return pptWriteIntermediate(args as Parameters<typeof pptWriteIntermediate>[0]);
    case PPT_PACK_TASK_TOOL:
      return pptPackTask(args as Parameters<typeof pptPackTask>[0]);
    case PPT_UNPACK_TASK_TOOL:
      return pptUnpackTask(args as Parameters<typeof pptUnpackTask>[0]);
    case PPT_READ_PARSED_TOOL:
      return pptReadParsed(args as Parameters<typeof pptReadParsed>[0]);
    case PPT_READ_SOURCE_TOOL:
      return pptReadSource(args as Parameters<typeof pptReadSource>[0]);
    case PPT_ADD_SLIDE_TOOL: {
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
        return { success: true, output: `${result.output}\nSaved to ${outputPath}`, outputPath };
      } catch (err: any) {
        return { success: false, output: err.message || `${PPT_ADD_SLIDE_TOOL} failed` };
      } finally {
        cleanupDir(tmpDir);
      }
    }
    case PPT_CLEAN_PRESENTATION_TOOL: {
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
        return { success: true, output: `${result.output}\nSaved to ${outputPath}`, outputPath };
      } catch (err: any) {
        return { success: false, output: err.message || `${PPT_CLEAN_PRESENTATION_TOOL} failed` };
      } finally {
        cleanupDir(tmpDir);
      }
    }
    case PPT_CREATE_THUMBNAILS_TOOL: {
      try {
        const result = await createPptxThumbnails({
          input: args.path as string,
          outputPrefix: args.output_prefix as string | undefined,
          cols: args.cols as number | undefined,
        });
        return { success: result.success, output: result.output };
      } catch (err: any) {
        return { success: false, output: err.message || `${PPT_CREATE_THUMBNAILS_TOOL} failed` };
      }
    }
    default:
      return { success: false, output: `Unknown PPT tool: ${toolName}` };
  }
}
