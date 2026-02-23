/**
 * Web ToolDefinitions for LLM tool binding.
 * Includes persisted pipeline tools and direct fetch tooling.
 *
 * working_directory and session_id are injected by the frontend at call time,
 * not specified by the LLM for web_fetch.
 */

import {
  WEB_INIT_TASK_TOOL,
  WEB_WRITE_SOURCE_TOOL,
  WEB_WRITE_INTERMEDIATE_TOOL,
  WEB_PACK_TASK_TOOL,
  WEB_UNPACK_TASK_TOOL,
  WEB_READ_PARSED_TOOL,
  WEB_READ_SOURCE_TOOL,
  WEB_FETCH_TOOL,
  buildSnippet,
  handleWebTool,
  stripSecurityWrapper,
  truncateAtWord,
  type ToolResult,
} from './tools.js'

interface ToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, any>
  guide?: string
  display_name: string
}

const WEB_INIT_TASK: ToolDefinition = {
  type: 'function',
  name: WEB_INIT_TASK_TOOL,
  display_name: 'Init Web Pipeline Task',
  description: 'Initialize persisted web task directories (01_source, 02_parsed, 03_intermediate, 04_output).',
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

const WEB_WRITE_SOURCE: ToolDefinition = {
  type: 'function',
  name: WEB_WRITE_SOURCE_TOOL,
  display_name: 'Write Web Source',
  description: 'Write fetch request payload into 01_source/request.json.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from web_init_task' },
      url: { type: 'string', description: 'URL to fetch' },
      max_length: { type: 'integer', description: 'Optional max length' },
      start_index: { type: 'integer', description: 'Optional start offset' },
      extract_mode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: "Extraction mode. Defaults to 'markdown'.",
      },
      headers: { type: 'object', description: 'Optional request headers' },
    },
    required: ['task_dir', 'url'],
  },
}

const WEB_WRITE_INTERMEDIATE: ToolDefinition = {
  type: 'function',
  name: WEB_WRITE_INTERMEDIATE_TOOL,
  display_name: 'Build Web Intermediate',
  description: 'Execute fetch from source request and persist intermediate/parsed artifacts.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from web_init_task' },
    },
    required: ['task_dir'],
  },
}

const WEB_PACK_OUTPUT: ToolDefinition = {
  type: 'function',
  name: WEB_PACK_TASK_TOOL,
  display_name: 'Pack Web Output',
  description: 'Copy 03_intermediate/fetch.json into output file (defaults to 04_output/result.json).',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from web_init_task' },
      output_path: { type: 'string', description: 'Optional output path for packed JSON' },
    },
    required: ['task_dir'],
  },
}

const WEB_UNPACK_OUTPUT: ToolDefinition = {
  type: 'function',
  name: WEB_UNPACK_TASK_TOOL,
  display_name: 'Unpack Web Output',
  description: 'Import an existing JSON fetch payload into pipeline source/intermediate directories.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from web_init_task' },
      input_path: { type: 'string', description: 'Path to an existing fetch JSON file' },
    },
    required: ['task_dir', 'input_path'],
  },
}

const WEB_READ_PARSED: ToolDefinition = {
  type: 'function',
  name: WEB_READ_PARSED_TOOL,
  display_name: 'Read Web Parsed Summary',
  description: 'Read parsed summary metadata from 02_parsed/summary.json.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from web_init_task' },
    },
    required: ['task_dir'],
  },
}

const WEB_READ_SOURCE: ToolDefinition = {
  type: 'function',
  name: WEB_READ_SOURCE_TOOL,
  display_name: 'Read Web Source',
  description: 'Read source request/input payload from 01_source.',
  parameters: {
    type: 'object',
    properties: {
      task_dir: { type: 'string', description: 'Task directory from web_init_task' },
    },
    required: ['task_dir'],
  },
}

const WEB_FETCH: ToolDefinition = {
  type: 'function',
  name: WEB_FETCH_TOOL,
  display_name: 'Web Fetch',
  description:
    'Fetch a URL and extract readable content. Returns a snippet directly in the tool response plus saves full content as .md when working_directory is provided.',
  guide:
    '<tool_guide name="web_fetch">\n'
    + 'mcp_web__search returns brief snippets and URLs. Follow up with web_fetch to get actual page content.\n'
    + 'Each fetch saves a .md file; use read(path="...") on the saved .md file for full content.\n'
    + 'Multiple fetch calls in the same turn run in parallel.\n'
    + '</tool_guide>',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (must include http:// or https://)' },
      max_length: { type: 'integer', description: 'Maximum content length in characters. Defaults to 20000.' },
      start_index: { type: 'integer', description: 'Character offset to start from (for pagination). Defaults to 0.' },
      extract_mode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: "Content extraction mode. Defaults to 'markdown'.",
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers to include in the request.',
      },
    },
    required: ['url'],
  },
}

export const WEB_TOOLS: ToolDefinition[] = [
  WEB_INIT_TASK,
  WEB_WRITE_SOURCE,
  WEB_WRITE_INTERMEDIATE,
  WEB_PACK_OUTPUT,
  WEB_UNPACK_OUTPUT,
  WEB_READ_PARSED,
  WEB_READ_SOURCE,
  WEB_FETCH,
]

export {
  handleWebTool,
  stripSecurityWrapper,
  truncateAtWord,
  buildSnippet,
  type ToolResult,
}
