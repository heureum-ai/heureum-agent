/**
 * Markdown ToolDefinitions + handler for LLM tool binding.
 * Includes Markdown editing tools plus step-based pipeline tools (init/write/pack/unpack/read).
 */

import {
  mdInitTask,
  mdWriteSource,
  mdWriteIntermediate,
  mdPackTask,
  mdUnpackTask,
  mdReadParsed,
  mdReadSource,
  markdownAppendContent,
  markdownCreate,
  markdownDiffDocument,
  markdownExtractStyleProfile,
  parseTemplateStyle,
  markdownExtractOutline,
  markdownFormatDocument,
  markdownGenerateToc,
  markdownManageFrontmatter,
  markdownRead,
  markdownTransformDocument,
  markdownUpdateSection,
  markdownValidateDocument,
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

const JSON_VALUE_SCHEMA: Record<string, any> = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
    { type: "array", items: {} },
    { type: "object", additionalProperties: true },
  ],
};

const INLINE_RUN_SCHEMA = {
  type: "object",
  description: "Inline run for mixed Markdown formatting in a paragraph/table cell.",
  properties: {
    text: { type: "string", description: "Plain text for this run" },
    markdown: { type: "string", description: "Raw inline markdown snippet for this run" },
    html: { type: "string", description: "Raw inline HTML for this run" },
    bold: { type: "boolean" },
    italic: { type: "boolean" },
    strikethrough: { type: "boolean" },
    underline: { type: "boolean" },
    highlight: { type: "boolean" },
    subscript: { type: "boolean" },
    superscript: { type: "boolean" },
    code: { type: "boolean", description: "Render run as inline code" },
    link: {
      type: "object",
      properties: {
        url: { type: "string" },
        title: { type: "string" },
      },
      required: ["url"],
    },
    footnote_ref: { type: "string", description: "Attach footnote reference [^id] after this run" },
    footnoteRef: { type: "string", description: "Alias of footnote_ref" },
    line_break: { type: "boolean", description: "Append a hard line break after this run" },
    lineBreak: { type: "boolean", description: "Alias of line_break" },
  },
};

const TABLE_CELL_SCHEMA = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      properties: {
        text: { type: "string" },
        markdown: { type: "string" },
        raw_markdown: { type: "string" },
        runs: {
          type: "array",
          items: INLINE_RUN_SCHEMA,
        },
      },
    },
  ],
};

function buildListItemSchema(depth: number): Record<string, any> {
  const base: Record<string, any> = {
    oneOf: [
      { type: "string" },
      {
        type: "object",
        properties: {
          text: { type: "string" },
          markdown: { type: "string" },
          runs: { type: "array", items: INLINE_RUN_SCHEMA },
          checked: { type: "boolean", description: "Per-item task checked flag override" },
        },
      },
    ],
  };
  if (depth > 0) {
    base.oneOf[1].properties.children = {
      type: "object",
      properties: {
        ordered: { type: "boolean" },
        start: { type: "integer" },
        items: {
          type: "array",
          items: buildListItemSchema(depth - 1),
          description: "Nested list items (same structure as parent items)",
        },
      },
      required: ["items"],
    };
  }
  return base;
}

const LIST_ITEM_SCHEMA = buildListItemSchema(3);

const HEADING_SELECTOR_SCHEMA = {
  type: "object",
  description: "Heading selector used by section transform tools.",
  properties: {
    heading: { type: "string", description: "Heading text (without #)" },
    heading_path: {
      type: "array",
      items: { type: "string" },
      description: "Exact heading path from root, e.g. [\"Chapter 1\", \"Section A\"]",
    },
    occurrence: { type: "integer", description: "1-based match index when selector is ambiguous. Defaults to 1." },
    line_start: { type: "integer", description: "Optional minimum heading line number filter" },
    line_end: { type: "integer", description: "Optional maximum heading line number filter" },
  },
};

const CONTENT_BLOCK_SCHEMA = {
  type: "array",
  description: "Ordered content blocks for Markdown generation",
  items: {
    type: "object",
    oneOf: [
      {
        properties: {
          heading: {
            type: "object",
            properties: {
              level: { type: "integer", minimum: 1, maximum: 6 },
              text: { type: "string" },
              id: { type: "string", description: "Optional heading id rendered as `{#id}` suffix." },
            },
            required: ["text"],
          },
        },
        required: ["heading"],
      },
      {
        properties: {
          paragraph: {
            type: "object",
            properties: {
              text: { type: "string" },
              runs: {
                type: "array",
                description: "Inline runs for mixed formatting; when present this takes precedence over text.",
                items: INLINE_RUN_SCHEMA,
              },
            },
          },
        },
        required: ["paragraph"],
      },
      {
        properties: {
          list: {
            type: "object",
            properties: {
              items: { type: "array", items: LIST_ITEM_SCHEMA },
              ordered: { type: "boolean" },
              start: { type: "integer" },
              task: { type: "boolean" },
              checked: { type: "array", items: { type: "boolean" } },
            },
            required: ["items"],
          },
        },
        required: ["list"],
      },
      {
        properties: {
          code: {
            type: "object",
            properties: {
              code: { type: "string" },
              language: { type: "string" },
            },
            required: ["code"],
          },
        },
        required: ["code"],
      },
      {
        properties: {
          quote: {
            type: "object",
            properties: {
              text: {
                oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              },
            },
            required: ["text"],
          },
        },
        required: ["quote"],
      },
      {
        properties: {
          table: {
            type: "object",
            properties: {
              headers: { type: "array", items: TABLE_CELL_SCHEMA },
              rows: {
                type: "array",
                items: {
                  type: "array",
                  items: TABLE_CELL_SCHEMA,
                },
              },
              align: {
                type: "array",
                items: { type: "string", enum: ["left", "center", "right"] },
              },
            },
            required: ["headers", "rows"],
          },
        },
        required: ["table"],
      },
      {
        properties: {
          definition_list: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    term: { type: "string" },
                    definitions: {
                      type: "array",
                      items: TABLE_CELL_SCHEMA,
                    },
                  },
                  required: ["term", "definitions"],
                },
              },
            },
            required: ["items"],
          },
        },
        required: ["definition_list"],
      },
      {
        properties: {
          footnote: {
            type: "object",
            properties: {
              id: { type: "string", description: "Footnote id used in [^id] references." },
              text: { type: "string" },
              markdown: { type: "string" },
              content: {
                type: "array",
                items: {},
                description: "Optional structured Markdown blocks used as footnote body.",
              },
            },
            required: ["id"],
          },
        },
        required: ["footnote"],
      },
      {
        properties: {
          html: {
            type: "object",
            properties: {
              html: { type: "string", description: "Raw HTML block inserted as-is." },
            },
            required: ["html"],
          },
        },
        required: ["html"],
      },
      {
        properties: {
          hr: {
            type: "object",
          },
        },
        required: ["hr"],
      },
      {
        properties: {
          image: {
            type: "object",
            properties: {
              alt: { type: "string" },
              src: { type: "string" },
              title: { type: "string" },
            },
            required: ["alt", "src"],
          },
        },
        required: ["image"],
      },
      {
        properties: {
          raw_markdown: {
            type: "object",
            properties: {
              markdown: { type: "string", description: "Raw Markdown block inserted as-is via parser." },
            },
            required: ["markdown"],
          },
        },
        required: ["raw_markdown"],
      },
    ],
  },
} as const;

const MD_INIT_TASK_TOOL: ToolDefinition = {
  type: "function",
  name: "md_init_task",
  display_name: "Init MD Pipeline Task",
  description:
    "Initialize a persisted Markdown pipeline task with step folders (01_source, 02_parsed, 03_intermediate, 04_output).",
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

const MD_WRITE_SOURCE_TOOL: ToolDefinition = {
  type: "function",
  name: "md_write_source",
  display_name: "Write MD Source",
  description:
    "Write pipeline source input for Markdown task. Provide one of input_path, markdown_text, or create_params.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from md_init_task" },
      input_path: { type: "string", description: "Path to source .md file" },
      markdown_text: { type: "string", description: "Raw markdown content to save as source/input.md" },
      create_params: { type: "object", description: "Structured create payload compatible with md_create_document (without output_path)." },
    },
    required: ["task_dir"],
  },
};

const MD_WRITE_INTERMEDIATE_TOOL: ToolDefinition = {
  type: "function",
  name: "md_write_intermediate",
  display_name: "Build MD Intermediate",
  description:
    "Build intermediate markdown file at 03_intermediate/working.md from previously written source.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from md_init_task" },
    },
    required: ["task_dir"],
  },
};

const MD_PACK_TOOL: ToolDefinition = {
  type: "function",
  name: "md_pack_document",
  display_name: "Pack MD Output",
  description:
    "Finalize pipeline output by copying 03_intermediate/working.md to output (defaults to 04_output/result.md).",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from md_init_task" },
      output_path: { type: "string", description: "Optional output .md path" },
    },
    required: ["task_dir"],
  },
};

const MD_UNPACK_TOOL: ToolDefinition = {
  type: "function",
  name: "md_unpack_document",
  display_name: "Unpack MD Into Pipeline",
  description:
    "Load an existing markdown file into source/intermediate pipeline locations.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from md_init_task" },
      input_path: { type: "string", description: "Path to source .md file" },
    },
    required: ["task_dir", "input_path"],
  },
};

const MD_READ_PARSED_TOOL: ToolDefinition = {
  type: "function",
  name: "md_read_parsed",
  display_name: "Read MD Parsed Summary",
  description:
    "Read intermediate/source markdown and write summary+outline to 02_parsed/summary.txt.",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from md_init_task" },
    },
    required: ["task_dir"],
  },
};

const MD_READ_SOURCE_TOOL: ToolDefinition = {
  type: "function",
  name: "md_read_source",
  display_name: "Read MD Source",
  description:
    "Read source information from 01_source (create.json payload or input.md text).",
  parameters: {
    type: "object",
    properties: {
      task_dir: { type: "string", description: "Task directory from md_init_task" },
    },
    required: ["task_dir"],
  },
};

const MARKDOWN_CREATE_TOOL: ToolDefinition = {
  type: "function",
  name: "md_create_document",
  display_name: "Create Markdown",
  description:
    "Create a Markdown document from structured content blocks. Supports inline runs and raw_markdown blocks for precise syntax control.",
  parameters: {
    type: "object",
    properties: {
      output_path: {
        type: "string",
        description: "Path where the .md file will be written",
      },
      title: {
        type: "string",
        description: "Optional document title. Written as H1 heading.",
      },
      frontmatter: {
        type: "object",
        description: "Optional YAML frontmatter key/value map (supports nested objects/arrays).",
        additionalProperties: JSON_VALUE_SCHEMA,
      },
      content: CONTENT_BLOCK_SCHEMA,
      overwrite: {
        type: "boolean",
        description: "Overwrite existing output file if true. Defaults to false.",
      },
    },
    required: ["output_path"],
  },
};

const MARKDOWN_READ_TOOL: ToolDefinition = {
  type: "function",
  name: "md_read_document",
  display_name: "Read Markdown",
  description:
    "Read a Markdown document and return text summary or machine-readable JSON metadata/outline/excerpt.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .md file" },
      start_line: { type: "integer", description: "Start line for excerpt (1-based)." },
      limit: { type: "integer", description: "Max lines to return. Defaults to 200." },
      include_line_numbers: { type: "boolean", description: "Include line numbers in excerpt." },
      include_frontmatter: {
        type: "boolean",
        description: "If false, excerpt excludes YAML frontmatter. Defaults to false.",
      },
      output_format: {
        type: "string",
        enum: ["text", "json"],
        description: "Output mode. text=human summary, json=machine-readable payload.",
      },
      include_ast: {
        type: "boolean",
        description: "When output_format=json, include parsed AST payload.",
      },
    },
    required: ["path"],
  },
};

const MARKDOWN_OUTLINE_TOOL: ToolDefinition = {
  type: "function",
  name: "md_extract_outline",
  display_name: "Extract MD Outline",
  description:
    "Extract the full heading outline from a Markdown file with heading levels and line numbers.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .md file" },
      max_depth: { type: "integer", description: "Maximum heading depth (1-6). Defaults to 6." },
    },
    required: ["path"],
  },
};

const MARKDOWN_STYLE_PROFILE_TOOL: ToolDefinition = {
  type: "function",
  name: "md_extract_style_profile",
  display_name: "Extract MD Style Profile",
  description:
    "Analyze Markdown structure and emit a JSON style/syntax profile (headings, inline emphasis, lists, code blocks, links, tables, etc.).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the .md file" },
      max_examples: {
        type: "integer",
        description: "Maximum sample headings/examples to include in profile output. Defaults to 20.",
      },
    },
    required: ["path"],
  },
};

const MARKDOWN_APPEND_TOOL: ToolDefinition = {
  type: "function",
  name: "md_append_content",
  display_name: "Append MD Content",
  description:
    "Append structured content blocks to the end of an existing Markdown document.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to source .md file" },
      content: CONTENT_BLOCK_SCHEMA,
      output_path: {
        type: "string",
        description: "Optional output path. Defaults to {basename}_modified.md",
      },
    },
    required: ["path", "content"],
  },
};

const MARKDOWN_UPDATE_SECTION_TOOL: ToolDefinition = {
  type: "function",
  name: "md_update_section",
  display_name: "Update MD Section",
  description:
    "Replace the body under a selected heading. Supports heading text, path, occurrence, and line range selectors.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to source .md file" },
      heading: { type: "string", description: "Backward-compatible heading text selector (without #)" },
      selector: HEADING_SELECTOR_SCHEMA,
      content: CONTENT_BLOCK_SCHEMA,
      output_path: {
        type: "string",
        description: "Optional output path. Defaults to {basename}_modified.md",
      },
      create_if_missing: {
        type: "boolean",
        description: "Create section at end when selector is missing. Defaults to false.",
      },
      heading_level: {
        type: "integer",
        description: "Heading level used when create_if_missing=true. Defaults to 2.",
      },
    },
    required: ["path", "content"],
  },
};

const MARKDOWN_TRANSFORM_TOOL: ToolDefinition = {
  type: "function",
  name: "md_transform_document",
  display_name: "Transform Markdown",
  description:
    "Perform advanced section transforms: replace_section, delete_section, insert_before, insert_after, rename_heading, move_section.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to source .md file" },
      action: {
        type: "string",
        enum: ["replace_section", "delete_section", "insert_before", "insert_after", "rename_heading", "move_section"],
      },
      selector: HEADING_SELECTOR_SCHEMA,
      target_selector: HEADING_SELECTOR_SCHEMA,
      target_position: {
        type: "string",
        enum: ["before", "after"],
        description: "For move_section: insert position relative to target selector. Defaults to before.",
      },
      content: CONTENT_BLOCK_SCHEMA,
      new_heading: { type: "string", description: "For rename_heading: replacement heading text" },
      output_path: {
        type: "string",
        description: "Optional output path. Defaults to {basename}_modified.md",
      },
      dry_run: { type: "boolean", description: "If true, do not write file and return unified diff preview." },
    },
    required: ["path", "action"],
  },
};

const MARKDOWN_FORMAT_TOOL: ToolDefinition = {
  type: "function",
  name: "md_format_document",
  display_name: "Format Markdown",
  description:
    "Format Markdown with preserve or normalize mode. normalize reparses AST; preserve keeps body as-is and applies whitespace cleanup.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to source .md file" },
      output_path: {
        type: "string",
        description: "Optional output path. Defaults to {basename}_modified.md",
      },
      mode: {
        type: "string",
        enum: ["normalize", "preserve"],
        description: "normalize=parse+stringify, preserve=keep syntax and only whitespace-format.",
      },
      trim_trailing_spaces: { type: "boolean" },
      collapse_blank_lines: { type: "boolean" },
      ensure_trailing_newline: { type: "boolean" },
    },
    required: ["path"],
  },
};

const MARKDOWN_FRONTMATTER_TOOL: ToolDefinition = {
  type: "function",
  name: "md_manage_frontmatter",
  display_name: "Manage Frontmatter",
  description:
    "Get, set, or remove YAML frontmatter in a Markdown file. Supports nested object/array values.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to source .md file" },
      action: { type: "string", enum: ["get", "set", "remove"] },
      frontmatter: {
        type: "object",
        description: "Required when action=set",
        additionalProperties: JSON_VALUE_SCHEMA,
      },
      output_path: {
        type: "string",
        description: "Optional output path for set/remove. Defaults to {basename}_modified.md",
      },
    },
    required: ["path", "action"],
  },
};

const MARKDOWN_VALIDATE_TOOL: ToolDefinition = {
  type: "function",
  name: "md_validate_document",
  display_name: "Validate Markdown",
  description:
    "Validate Markdown syntax compatibility for commonmark/gfm profiles and report risky or renderer-dependent constructs.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to source .md file" },
      profile: {
        type: "string",
        enum: ["commonmark", "gfm", "strict"],
        description: "Validation profile. Defaults to gfm.",
      },
    },
    required: ["path"],
  },
};

const MARKDOWN_TOC_TOOL: ToolDefinition = {
  type: "function",
  name: "md_generate_toc",
  display_name: "Generate Markdown TOC",
  description:
    "Generate a table of contents from headings and insert it at the top or replace content between TOC markers.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to source .md file" },
      output_path: { type: "string", description: "Optional output path. Defaults to {basename}_modified.md" },
      min_depth: { type: "integer", description: "Minimum heading level to include (1-6)." },
      max_depth: { type: "integer", description: "Maximum heading level to include (1-6)." },
      include_h1: { type: "boolean", description: "Include H1 headings in TOC. Defaults to false." },
      ordered: { type: "boolean", description: "Render TOC as ordered list. Defaults to false." },
      heading: {
        type: "string",
        description: "Optional TOC title line. If it doesn't start with '#', tool prepends '## '.",
      },
      marker_start: { type: "string", description: "Start marker for in-place replacement. Defaults to <!-- TOC -->" },
      marker_end: { type: "string", description: "End marker for in-place replacement. Defaults to <!-- /TOC -->" },
    },
    required: ["path"],
  },
};

const MARKDOWN_DIFF_TOOL: ToolDefinition = {
  type: "function",
  name: "md_diff_document",
  display_name: "Diff Markdown",
  description:
    "Generate unified diff between two Markdown states. Provide compare_path or a transform payload for dry-run diff.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to base .md file" },
      compare_path: { type: "string", description: "Path to comparison .md file" },
      transform: {
        type: "object",
        description: "Optional in-memory transform to diff against without writing output.",
        properties: {
          action: {
            type: "string",
            enum: ["replace_section", "delete_section", "insert_before", "insert_after", "rename_heading", "move_section"],
          },
          selector: HEADING_SELECTOR_SCHEMA,
          target_selector: HEADING_SELECTOR_SCHEMA,
          target_position: { type: "string", enum: ["before", "after"] },
          content: CONTENT_BLOCK_SCHEMA,
          new_heading: { type: "string" },
        },
        required: ["action"],
      },
      output_path: { type: "string", description: "Optional path to save the diff text." },
    },
    required: ["path"],
  },
};

export const MD_TOOLS: ToolDefinition[] = [
  MD_INIT_TASK_TOOL,
  MD_WRITE_SOURCE_TOOL,
  MD_WRITE_INTERMEDIATE_TOOL,
  MD_PACK_TOOL,
  MD_UNPACK_TOOL,
  MD_READ_PARSED_TOOL,
  MD_READ_SOURCE_TOOL,
  MARKDOWN_CREATE_TOOL,
  MARKDOWN_READ_TOOL,
  MARKDOWN_OUTLINE_TOOL,
  MARKDOWN_STYLE_PROFILE_TOOL,
  MARKDOWN_APPEND_TOOL,
  MARKDOWN_UPDATE_SECTION_TOOL,
  MARKDOWN_TRANSFORM_TOOL,
  MARKDOWN_FORMAT_TOOL,
  MARKDOWN_FRONTMATTER_TOOL,
  MARKDOWN_VALIDATE_TOOL,
  MARKDOWN_TOC_TOOL,
  MARKDOWN_DIFF_TOOL,
];

export async function handleMdTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case "md_init_task":
      return mdInitTask(args as Parameters<typeof mdInitTask>[0]);
    case "md_write_source":
      return mdWriteSource(args as Parameters<typeof mdWriteSource>[0]);
    case "md_write_intermediate":
      return mdWriteIntermediate(args as Parameters<typeof mdWriteIntermediate>[0]);
    case "md_pack_document":
      return mdPackTask(args as Parameters<typeof mdPackTask>[0]);
    case "md_unpack_document":
      return mdUnpackTask(args as Parameters<typeof mdUnpackTask>[0]);
    case "md_read_parsed":
      return mdReadParsed(args as Parameters<typeof mdReadParsed>[0]);
    case "md_read_source":
      return mdReadSource(args as Parameters<typeof mdReadSource>[0]);
    case "md_create_document":
      return markdownCreate(args as Parameters<typeof markdownCreate>[0]);
    case "md_read_document":
      return markdownRead(args as Parameters<typeof markdownRead>[0]);
    case "md_extract_outline":
      return markdownExtractOutline(args as Parameters<typeof markdownExtractOutline>[0]);
    case "md_extract_style_profile":
      return parseTemplateStyle(args as Parameters<typeof parseTemplateStyle>[0]);
    case "md_append_content":
      return markdownAppendContent(args as Parameters<typeof markdownAppendContent>[0]);
    case "md_update_section":
      return markdownUpdateSection(args as Parameters<typeof markdownUpdateSection>[0]);
    case "md_transform_document":
      return markdownTransformDocument(args as Parameters<typeof markdownTransformDocument>[0]);
    case "md_format_document":
      return markdownFormatDocument(args as Parameters<typeof markdownFormatDocument>[0]);
    case "md_manage_frontmatter":
      return markdownManageFrontmatter(args as Parameters<typeof markdownManageFrontmatter>[0]);
    case "md_validate_document":
      return markdownValidateDocument(args as Parameters<typeof markdownValidateDocument>[0]);
    case "md_generate_toc":
      return markdownGenerateToc(args as Parameters<typeof markdownGenerateToc>[0]);
    case "md_diff_document":
      return markdownDiffDocument(args as Parameters<typeof markdownDiffDocument>[0]);
    default:
      return { success: false, output: `Unknown Markdown tool: ${toolName}` };
  }
}
