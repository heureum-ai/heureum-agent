// Copyright (c) 2026 Heureum AI. All rights reserved.

/**
 * Open Responses specification types
 * Based on https://www.openresponses.org/
 */

export type MessageRole = 'user' | 'assistant' | 'system' | 'developer';

export type ItemStatus = 'in_progress' | 'incomplete' | 'completed' | 'failed';

export interface InputTextContent {
  type: 'input_text';
  text: string;
}

export interface OutputTextContent {
  type: 'output_text';
  text: string;
}

export type ContentPart = InputTextContent | OutputTextContent;

export interface MessageItem {
  id?: string;
  type: 'message';
  role: MessageRole;
  status?: ItemStatus;
  content: ContentPart[];
}

export interface FunctionToolCall {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status?: ItemStatus;
  display_name?: string;
}

export interface FunctionToolResult {
  type: 'function_call_output';
  id?: string;
  call_id: string;
  output: string;
}

export interface ToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, any>;
  guide?: string;
  display_name?: string;
}

export type OutputItem = MessageItem | FunctionToolCall;

export type InputItem = MessageItem | FunctionToolCall | FunctionToolResult;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_cost?: number;
  output_cost?: number;
  total_cost?: number;
}

export interface ResponseRequest {
  model?: string;
  input: string | InputItem[];
  tools?: ToolDefinition[];
  previous_response_id?: string;
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
  metadata?: Record<string, string>;
}

export interface ResponseError {
  type: string;
  message: string;
  code?: string;
}

export interface ResponseObject {
  id: string;
  created_at: number;
  completed_at?: number;
  model: string;
  status: ItemStatus;
  output: OutputItem[];
  usage?: Usage;
  error?: ResponseError;
  metadata?: Record<string, any>;
}

// TODO progress types
export interface TodoStep {
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
}

export interface TodoState {
  task: string;
  steps: TodoStep[];
}

// Tool call display info
export interface ToolCallInfo {
  callId?: string;
  command: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  displayName?: string;
  output?: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
  cost?: number;
}

// Question system types
export interface ChoiceObject {
  label: string;
  description?: string;
}

export type Choice = string | ChoiceObject;

export function normalizeChoice(c: Choice): ChoiceObject {
  return typeof c === 'string' ? { label: c } : c;
}

export function getChoiceLabel(c: Choice): string {
  return typeof c === 'string' ? c : c.label;
}

export interface QuestionRequest {
  callId: string;
  question: string;
  choices: Choice[];
  allowUserInput: boolean;
}

export type QuestionAnswer = {
  type: 'choice';
  value: string;
} | {
  type: 'user_input';
  value: string;
} | {
  type: 'cancelled';
};

// Legacy interfaces for backward compatibility
export interface PeriodicRunInfo {
  taskId: string;
  taskTitle: string;
  executedAt: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCall?: ToolCallInfo;
  todo?: TodoState;
  question?: QuestionRequest;
  questionAnswer?: QuestionAnswer;
  cancelled?: 'permission' | 'question';
  cancelledPermission?: PermissionRequest;
  cost?: number;
  periodicRun?: PeriodicRunInfo;
}

export interface ChatRequest {
  messages: Message[];
  session_id?: string;
  extraInput?: InputItem[];
}

export interface ChatResponse {
  message: string;
  session_id: string;
  toolCalls?: ToolCallInfo[];
}

// Session list item (from GET /api/v1/sessions/)
export interface SessionListItem {
  id: number;
  session_id: string;
  title: string | null;
  cwd: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost: number | string;
  has_periodic_task?: boolean;
}

// Permission system types (used when running in Electron with window.api)
export type PermissionDecision = 'always_allow' | 'allow_once' | 'deny';

export interface PermissionRequest {
  toolName: string;
  command: string;
  callId: string;
}

// Helper functions to convert between formats
export function messageToItem(message: Message): MessageItem {
  return {
    type: 'message',
    role: message.role as MessageRole,
    status: 'completed',
    content: [
      {
        type: message.role === 'user' ? 'input_text' : 'output_text',
        text: message.content,
      },
    ],
  };
}

export function itemToMessage(item: MessageItem): Message {
  const textContent = item.content.find(
    (c): c is InputTextContent | OutputTextContent =>
      c.type === 'input_text' || c.type === 'output_text'
  );

  return {
    role: item.role as 'user' | 'assistant' | 'system',
    content: textContent?.text || '',
  };
}

export function extractTextFromItem(item: MessageItem): string {
  return item.content
    .filter((c): c is InputTextContent | OutputTextContent =>
      c.type === 'input_text' || c.type === 'output_text'
    )
    .map((c) => c.text)
    .join(' ');
}

export function isToolCall(item: OutputItem): item is FunctionToolCall {
  return item.type === 'function_call';
}

export function isMessageItem(item: OutputItem): item is MessageItem {
  return item.type === 'message';
}

// SSE stream event types
export interface StreamEventCreated {
  type: 'response.created';
  response: ResponseObject;
}

export interface StreamEventTextDelta {
  type: 'response.output_text.delta';
  delta: string;
}

export interface StreamEventTextDone {
  type: 'response.output_text.done';
  text: string;
}

export interface StreamEventFunctionCallDone {
  type: 'response.function_call.done';
  item: FunctionToolCall;
  usage?: Usage;
}

export interface StreamEventToolResultDone {
  type: 'response.tool_result.done';
  call_id: string;
  output?: string;
  status: string;
}

export interface StreamEventCompleted {
  type: 'response.completed';
  response: ResponseObject;
}

export interface StreamEventIncomplete {
  type: 'response.incomplete';
  response: ResponseObject;
}

export interface StreamEventFailed {
  type: 'response.failed';
  response: ResponseObject;
}

export interface StreamEventTodoUpdated {
  type: 'response.todo.updated';
  todo: TodoState;
}

export type StreamEvent =
  | StreamEventCreated
  | StreamEventTextDelta
  | StreamEventTextDone
  | StreamEventFunctionCallDone
  | StreamEventToolResultDone
  | StreamEventCompleted
  | StreamEventIncomplete
  | StreamEventFailed
  | StreamEventTodoUpdated;

// Periodic task types
export interface PeriodicTask {
  id: string;
  session_id: string;
  title: string;
  description: string;
  recipe: Record<string, any>;
  schedule: { type: string; cron?: Record<string, string | number>; interval?: Record<string, any> };
  timezone_name: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  notify_on_success: boolean;
  max_retries: number;
  consecutive_failures: number;
  next_run_at: string | null;
  last_run_at: string | null;
  total_runs: number;
  total_successes: number;
  total_failures: number;
  created_at: string;
  updated_at: string;
}

export interface PeriodicTaskRun {
  id: string;
  task_id: string;
  status: 'running' | 'completed' | 'failed';
  attempt: number;
  output_summary: string;
  error_message: string;
  files_created: string[];
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost: number | string;
  iterations: number;
  tool_calls_count: number;
  started_at: string;
  completed_at: string | null;
}
