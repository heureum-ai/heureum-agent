/**
 * PPT ToolDefinitions for LLM tool binding.
 * Includes pipeline tools and slide/cleanup/thumbnail operations.
 */

import {
  PPT_INIT_TASK_TOOL,
  PPT_WRITE_SOURCE_TOOL,
  PPT_WRITE_INTERMEDIATE_TOOL,
  PPT_PACK_TASK_TOOL,
  PPT_UNPACK_TASK_TOOL,
  PPT_READ_PARSED_TOOL,
  PPT_READ_SOURCE_TOOL,
  PPT_ADD_SLIDE_TOOL,
  PPT_CLEAN_PRESENTATION_TOOL,
  PPT_CREATE_THUMBNAILS_TOOL,
  handlePptTool,
  type ToolResult,
} from "./tools";

interface ToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  guide?: string;
  display_name: string;
}

const PPT_INIT_TASK: ToolDefinition = {
  type: "function",
  name: PPT_INIT_TASK_TOOL,
  display_name: "Init PPT Pipeline Task",
  description: "Initialize persisted PPT task directories (01_source, 02_parsed, 03_intermediate, 04_output).",
  parameters: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "Session identifier" },
      task_id: { type: "string", description: "Task identifier" },
      work_dir: { type: "string", description: "Optional base working directory" },
    },
    required: ["session_id", "task_id"],
  },
};

const PPT_WRITE_SOURCE: ToolDefinition = {
  type: "function",
  name: PPT_WRITE_SOURCE_TOOL,
  display_name: "Write PPT Source",
  description: "Write source PPTX input into 01_source/input.pptx.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from ppt_init_task" },
      input_path: { type: "string", description: "Path to source .pptx" },
    },
    required: ["task_dir", "input_path"],
  },
};

const PPT_WRITE_INTERMEDIATE: ToolDefinition = {
  type: "function",
  name: PPT_WRITE_INTERMEDIATE_TOOL,
  display_name: "Build PPT Intermediate",
  description: "Unpack source PPTX into 03_intermediate/unpacked and generate slide summary into 02_parsed.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from ppt_init_task" },
    },
    required: ["task_dir"],
  },
};

const PPT_PACK_TASK: ToolDefinition = {
  type: "function",
  name: PPT_PACK_TASK_TOOL,
  display_name: "Pack PPT Output",
  description: "Pack 03_intermediate/unpacked into a .pptx output (defaults to 04_output/result.pptx).",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from ppt_init_task" },
      output_path: { type: "string", description: "Optional output .pptx path" },
    },
    required: ["task_dir"],
  },
};

const PPT_UNPACK_TASK: ToolDefinition = {
  type: "function",
  name: PPT_UNPACK_TASK_TOOL,
  display_name: "Unpack PPT Into Pipeline",
  description: "Copy source PPTX into 01_source and unpack to 03_intermediate/unpacked.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from ppt_init_task" },
      input_path: { type: "string", description: "Path to source .pptx" },
    },
    required: ["task_dir", "input_path"],
  },
};

const PPT_READ_PARSED: ToolDefinition = {
  type: "function",
  name: PPT_READ_PARSED_TOOL,
  display_name: "Read PPT Parsed Summary",
  description: "Read parsed slide summary from 02_parsed/summary.json.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from ppt_init_task" },
    },
    required: ["task_dir"],
  },
};

const PPT_READ_SOURCE: ToolDefinition = {
  type: "function",
  name: PPT_READ_SOURCE_TOOL,
  display_name: "Read PPT Source",
  description: "Read source metadata from 01_source/input.pptx.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from ppt_init_task" },
    },
    required: ["task_dir"],
  },
};

const PPT_ADD_SLIDE: ToolDefinition = {
  type: "function",
  name: PPT_ADD_SLIDE_TOOL,
  display_name: "Add Slide",
  description:
    'Add a new slide to a PPTX file. Specify a source slide to duplicate (e.g. "slide1.xml") or a layout name (e.g. "layout:Title Slide").',
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .pptx file (must be within the working directory)" },
      source: {
        type: "string",
        description: 'Source slide to duplicate (e.g. "slide1.xml") or layout (e.g. "layout:Title Slide")',
      },
      output_path: {
        type: "string",
        description: "Output file path within the working directory. Defaults to {basename}_modified.pptx.",
      },
    },
    required: ["path", "source"],
  },
};

const PPT_CLEAN_PRESENTATION: ToolDefinition = {
  type: "function",
  name: PPT_CLEAN_PRESENTATION_TOOL,
  display_name: "Clean Presentation",
  description: "Remove unreferenced files (unused media, layouts, etc.) from a PPTX to reduce file size.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .pptx file (must be within the working directory)" },
      output_path: {
        type: "string",
        description: "Output file path within the working directory. Defaults to {basename}_modified.pptx.",
      },
    },
    required: ["path"],
  },
};

const PPT_CREATE_THUMBNAILS: ToolDefinition = {
  type: "function",
  name: PPT_CREATE_THUMBNAILS_TOOL,
  display_name: "Create Thumbnails",
  description:
    "Create a thumbnail grid image from PPTX slides using LibreOffice for rendering.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .pptx file (must be within the working directory)" },
      output_prefix: {
        type: "string",
        description: 'Output file prefix (produces {prefix}.jpg). Defaults to "thumbnails".',
      },
      cols: { type: "integer", description: "Number of columns in the grid. Defaults to 3, max 6." },
    },
    required: ["path"],
  },
};

export const PPT_TOOLS: ToolDefinition[] = [
  PPT_INIT_TASK,
  PPT_WRITE_SOURCE,
  PPT_WRITE_INTERMEDIATE,
  PPT_PACK_TASK,
  PPT_UNPACK_TASK,
  PPT_READ_PARSED,
  PPT_READ_SOURCE,
  PPT_ADD_SLIDE,
  PPT_CLEAN_PRESENTATION,
  PPT_CREATE_THUMBNAILS,
];

export { handlePptTool, type ToolResult };
