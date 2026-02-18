// Copyright (c) 2026 Heureum AI. All rights reserved.

import axios from 'axios';
import type {
  ChatRequest,
  ChatResponse,
  ResponseObject,
  ResponseRequest,
  FunctionToolResult,
  InputItem,
  ToolDefinition,
  ToolCallInfo,
  MessageItem,
  PermissionRequest,
  PermissionDecision,
  QuestionRequest,
  QuestionAnswer,
  SessionListItem,
  Message,
  StreamEvent,
  PeriodicTask,
  PeriodicTaskRun,
  TodoState,
} from '../types';
import { messageToItem, extractTextFromItem, isToolCall, isMessageItem } from '../types';

const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8001').replace(/\/+$/, '');

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// CSRF token handling for session-based auth
function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

apiClient.interceptors.request.use((config: import('axios').InternalAxiosRequestConfig) => {
  if (config.method && !['get', 'head', 'options'].includes(config.method)) {
    const token = getCsrfToken();
    if (token) {
      config.headers['X-CSRFToken'] = token;
    }
  }
  return config;
});

// --- Session CWD state ---
let sessionCwd: string | null = null;
let cwdSelectionDeclined = false;

export function getSessionCwd(): string | null {
  return sessionCwd;
}

export function setSessionCwd(cwd: string): void {
  sessionCwd = cwd;
  cwdSelectionDeclined = false;
}

export function clearSessionCwd(): void {
  sessionCwd = null;
  cwdSelectionDeclined = false;
}

// --- Extension connection state ---
let extensionConnected = false;

export function getExtensionConnected(): boolean {
  return extensionConnected;
}

export function setExtensionConnected(connected: boolean): void {
  extensionConnected = connected;
}

// --- Dynamic tool builders ---

function buildBashTool(): ToolDefinition {
  const cwdNote = sessionCwd
    ? ` Commands will execute in the working directory: ${sessionCwd}.`
    : ' No working directory is set; commands will execute in the default directory. You should call select_cwd first to let the user choose a working directory.';
  return {
    type: 'function',
    name: 'bash',
    display_name: 'Bash',
    description: `Execute a bash command on the local system.${cwdNote}`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
  };
}

function buildSelectCwdTool(): ToolDefinition {
  const cwdStatus = sessionCwd
    ? `Current working directory is: ${sessionCwd}.`
    : 'No working directory is currently set.';
  return {
    type: 'function',
    name: 'select_cwd',
    display_name: 'Select Directory',
    description: `Open a native folder picker dialog for the user to select a working directory for bash commands. ${cwdStatus} Call this before running bash commands if no working directory has been set, or if the user wants to change it.`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

const ASK_QUESTION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'ask_question',
  display_name: 'Question',
  description:
    'Ask the user a multiple-choice question when you need clarification or a decision',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      choices: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
          ],
        },
        description: 'List of choices. Each can be a string or {label, description?}.',
      },
      allow_user_input: {
        type: 'boolean',
        description: 'Whether to allow free-text input',
        default: false,
      },
    },
    required: ['question', 'choices'],
  },
};

const BROWSER_NAVIGATE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_navigate',
  display_name: 'Navigate',
  description: 'Navigate the current browser tab to a URL. Returns page content.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to navigate to' },
    },
    required: ['url'],
  },
};

const BROWSER_NEW_TAB_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_new_tab',
  display_name: 'New Tab',
  description: 'Open a URL in a new browser tab. Returns page content.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to open in a new tab' },
    },
    required: ['url'],
  },
};

const BROWSER_CLICK_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_click',
  display_name: 'Click',
  description: 'Click an element on the page using a CSS selector from browser_get_content.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the element to click' },
    },
    required: ['selector'],
  },
};

const BROWSER_TYPE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_type',
  display_name: 'Type',
  description: 'Type text into an input field using a CSS selector from browser_get_content.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the input element' },
      text: { type: 'string', description: 'Text to type into the input' },
    },
    required: ['selector', 'text'],
  },
};

const BROWSER_GET_CONTENT_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_get_content',
  display_name: 'Get Content',
  description:
    'Get current page content: title, URL, interactive elements with CSS selectors, and visible text. Call this before clicking or typing.',
  parameters: { type: 'object', properties: {} },
};

const BROWSER_TOOLS: ToolDefinition[] = [
  BROWSER_NAVIGATE_TOOL,
  BROWSER_NEW_TAB_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_GET_CONTENT_TOOL,
];

const GET_DEVICE_INFO_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_device_info',
  display_name: 'Device Info',
  description: 'Get mobile device info: model, OS, battery, screen size, memory.',
  parameters: { type: 'object', properties: {} },
};

const GET_SENSOR_DATA_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_sensor_data',
  display_name: 'Sensor Data',
  description: 'Get live sensor readings: accelerometer, gyroscope, barometer.',
  parameters: { type: 'object', properties: {} },
};

const GET_CONTACTS_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_contacts',
  display_name: 'Contacts',
  description: 'Search phone contacts. Returns names, phone numbers, and emails.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional name filter' },
    },
  },
};

const GET_LOCATION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_location',
  display_name: 'Location',
  description: 'Get current GPS location: latitude, longitude, altitude, accuracy.',
  parameters: { type: 'object', properties: {} },
};

const TAKE_PHOTO_TOOL: ToolDefinition = {
  type: 'function',
  name: 'take_photo',
  display_name: 'Photo',
  description: 'Open the camera to take a photo.',
  parameters: {
    type: 'object',
    properties: {
      camera: { type: 'string', description: 'front or back. Defaults to back.' },
    },
  },
};

const SEND_NOTIFICATION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'send_notification',
  display_name: 'Notification',
  description: 'Send a local push notification with title and body.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Notification title' },
      body: { type: 'string', description: 'Notification body' },
    },
    required: ['title', 'body'],
  },
};

const GET_CLIPBOARD_TOOL: ToolDefinition = {
  type: 'function',
  name: 'get_clipboard',
  display_name: 'Clipboard',
  description: 'Read current clipboard text.',
  parameters: { type: 'object', properties: {} },
};

const SET_CLIPBOARD_TOOL: ToolDefinition = {
  type: 'function',
  name: 'set_clipboard',
  display_name: 'Clipboard',
  description: 'Copy text to clipboard.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to copy' },
    },
    required: ['text'],
  },
};

const SEND_SMS_TOOL: ToolDefinition = {
  type: 'function',
  name: 'send_sms',
  display_name: 'SMS',
  description: 'Open SMS compose screen with pre-filled recipients and message.',
  parameters: {
    type: 'object',
    properties: {
      phones: { type: 'array', items: { type: 'string' }, description: 'Recipient phone numbers' },
      message: { type: 'string', description: 'Message text' },
    },
    required: ['phones', 'message'],
  },
};

const SHARE_CONTENT_TOOL: ToolDefinition = {
  type: 'function',
  name: 'share_content',
  display_name: 'Share',
  description: 'Open native share sheet to share text or URL.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Text to share' },
      url: { type: 'string', description: 'Optional URL' },
    },
    required: ['message'],
  },
};

const TRIGGER_HAPTIC_TOOL: ToolDefinition = {
  type: 'function',
  name: 'trigger_haptic',
  display_name: 'Haptic',
  description: 'Trigger haptic vibration feedback.',
  parameters: {
    type: 'object',
    properties: {
      style: { type: 'string', description: 'light, medium, or heavy. Defaults to medium.' },
    },
  },
};

const OPEN_URL_TOOL: ToolDefinition = {
  type: 'function',
  name: 'open_url',
  display_name: 'Open URL',
  description: 'Open a URL in the in-app browser.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to open' },
    },
    required: ['url'],
  },
};

const MOBILE_TOOLS: ToolDefinition[] = [
  GET_DEVICE_INFO_TOOL,
  GET_SENSOR_DATA_TOOL,
  GET_CONTACTS_TOOL,
  GET_LOCATION_TOOL,
  TAKE_PHOTO_TOOL,
  SEND_NOTIFICATION_TOOL,
  GET_CLIPBOARD_TOOL,
  SET_CLIPBOARD_TOOL,
  SEND_SMS_TOOL,
  SHARE_CONTENT_TOOL,
  TRIGGER_HAPTIC_TOOL,
  OPEN_URL_TOOL,
];

export const MOBILE_TOOL_NAMES = new Set(MOBILE_TOOLS.map((t) => t.name));

function canExecuteTools(): boolean {
  return typeof window !== 'undefined' && window.api?.canExecuteTools === true;
}

export function isMobileApp(): boolean {
  return typeof window !== 'undefined' && window.mobileBridge?.available === true;
}

function extractBaseCommand(fullCommand: string): string {
  return fullCommand.trim().split(/\s+/)[0];
}

function buildTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [ASK_QUESTION_TOOL];
  if (canExecuteTools()) {
    if (sessionCwd) {
      tools.push(buildBashTool());
    }
    if (!cwdSelectionDeclined && !sessionCwd) {
      tools.push(buildSelectCwdTool());
    }
    if (extensionConnected) {
      tools.push(...BROWSER_TOOLS);
    }
  }
  if (isMobileApp()) {
    tools.push(...MOBILE_TOOLS);
  }
  return tools;
}

export async function checkPermission(
  clientId: string,
  toolName: string,
  baseCommand: string,
): Promise<boolean | null> {
  const response = await apiClient.get<{ allowed: boolean | null }>('/api/v1/permissions/', {
    params: { client_id: clientId, tool_name: toolName, command: baseCommand },
  });
  return response.data.allowed;
}

export async function setPermission(
  clientId: string,
  toolName: string,
  baseCommand: string,
  allowed: boolean,
): Promise<void> {
  await apiClient.post('/api/v1/permissions/', {
    client_id: clientId,
    tool_name: toolName,
    command: baseCommand,
    allowed,
  });
}

export async function logPermissionDecision(
  sessionId: string,
  clientId: string,
  toolName: string,
  command: string,
  baseCommand: string,
  decision: 'always_allow' | 'allow_once' | 'deny' | 'auto_approved',
  callId?: string,
): Promise<void> {
  await apiClient.post('/api/v1/permissions/log/', {
    session_id: sessionId,
    client_id: clientId,
    tool_name: toolName,
    command,
    base_command: baseCommand,
    decision,
    call_id: callId || '',
  });
}

export async function updateSessionCwd(sessionId: string, cwd: string): Promise<void> {
  await apiClient.patch(`/api/v1/sessions/${sessionId}/cwd/`, { cwd });
}

export async function fetchSessions(): Promise<SessionListItem[]> {
  const response = await apiClient.get<SessionListItem[]>('/api/v1/sessions/');
  return response.data;
}

export async function generateSessionTitle(sessionId: string): Promise<string> {
  const response = await apiClient.post<{ title: string }>(
    `/api/v1/sessions/${sessionId}/generate-title/`,
  );
  return response.data.title;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await apiClient.delete(`/api/v1/sessions/${sessionId}/`);
}


export async function fetchSessionMessages(sessionId: string): Promise<Message[]> {
  // Fetch all pages of messages
  type RawMsg = {
    role: string;
    content: Array<{ type: string; text?: string }> | Record<string, unknown>;
    type: string;
  };
  const allRaw: RawMsg[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await apiClient.get<{ results: RawMsg[]; next: string | null }>(
      '/api/v1/messages/',
      { params: { session_id: sessionId, ordering: 'created_at', page } },
    );
    allRaw.push(...response.data.results);
    hasMore = response.data.next !== null;
    page++;
  }

  const messages: Message[] = [];
  for (const msg of allRaw) {
    if (msg.type !== 'message' || !['user', 'assistant'].includes(msg.role)) continue;
    const content = Array.isArray(msg.content)
      ? msg.content
          .filter((c) => c.type === 'input_text' || c.type === 'output_text')
          .map((c) => c.text || '')
          .join(' ')
      : '';
    if (content) {
      messages.push({ role: msg.role as 'user' | 'assistant', content });
    }
  }
  return messages;
}

interface RawMessage {
  role: string;
  content: Array<{ type: string; text?: string }> | Record<string, unknown>;
  type: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export async function fetchAllSessionMessages(sessionId: string): Promise<Message[]> {
  // Fetch all pages of messages
  const raw: RawMessage[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await apiClient.get<{ results: RawMessage[]; next: string | null }>(
      '/api/v1/messages/',
      { params: { session_id: sessionId, ordering: 'created_at', page } },
    );
    raw.push(...response.data.results);
    hasMore = response.data.next !== null;
    page++;
  }

  // Build call_id → output lookup from function_call_output messages
  const outputMap = new Map<string, string>();
  for (const msg of raw) {
    if (msg.type === 'function_call_output') {
      const content = msg.content as Record<string, unknown>;
      const callId = content.call_id as string;
      const output = content.output as string;
      if (callId) outputMap.set(callId, output || '');
    }
  }

  const messages: Message[] = [];
  const seenCallIds = new Set<string>();
  for (const msg of raw) {
    if (msg.type === 'message' && ['user', 'assistant'].includes(msg.role)) {
      // Periodic task execution — show as a card instead of raw prompt
      if (msg.role === 'user' && msg.metadata?.is_periodic_run) {
        messages.push({
          role: 'user',
          content: '',
          periodicRun: {
            taskId: String(msg.metadata.periodic_task_id || ''),
            taskTitle: String(msg.metadata.periodic_task_title || 'Scheduled Task'),
            executedAt: msg.created_at || '',
          },
        });
        continue;
      }
      const content = Array.isArray(msg.content)
        ? msg.content
            .filter((c) => c.type === 'input_text' || c.type === 'output_text')
            .map((c) => c.text || '')
            .join(' ')
        : '';
      if (content && content !== '(tool calls)') {
        messages.push({ role: msg.role as 'user' | 'assistant', content });
      }
    } else if (msg.type === 'function_call') {
      const content = msg.content as Record<string, unknown>;
      const name = content.name as string || 'unknown';
      const args = content.arguments as string || '';
      const callId = content.call_id as string || '';
      const status = (content.status as string) || 'completed';

      // Skip manage_todo — shown via TodoProgress, not as a tool block
      if (name === 'manage_todo') continue;

      // Skip duplicate function_call records (same call_id stored from both output and follow-up input)
      if (callId && seenCallIds.has(callId)) continue;
      if (callId) seenCallIds.add(callId);

      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(args); } catch { /* ignore */ }
      const command = name === 'bash' && parsedArgs.command
        ? String(parsedArgs.command)
        : name;

      messages.push({
        role: 'assistant',
        content: '',
        toolCall: {
          command,
          toolName: name,
          toolArgs: parsedArgs,
          output: outputMap.get(callId),
          status: status === 'failed' ? 'failed' : 'completed',
        },
      });
    } else if (msg.type === 'todo_state') {
      // Reconstruct todo progress from persisted snapshot
      const todoContent = msg.content as unknown as TodoState;
      if (todoContent && todoContent.task) {
        messages.push({ role: 'assistant', content: '', todo: todoContent });
      }
    }
    // function_call_output messages are consumed via outputMap, not rendered separately
  }
  return messages;
}

export async function fetchSessionMessagesPage(
  sessionId: string,
  page: number,
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const response = await apiClient.get<{ results: RawMessage[]; next: string | null }>(
    '/api/v1/messages/',
    { params: { session_id: sessionId, ordering: '-created_at', page } },
  );

  const raw = response.data.results;
  const hasMore = response.data.next !== null;

  // Build call_id → output lookup from function_call_output messages
  const outputMap = new Map<string, string>();
  for (const msg of raw) {
    if (msg.type === 'function_call_output') {
      const content = msg.content as Record<string, unknown>;
      const callId = content.call_id as string;
      const output = content.output as string;
      if (callId) outputMap.set(callId, output || '');
    }
  }

  const messages: Message[] = [];
  const seenCallIds = new Set<string>();
  for (const msg of raw) {
    if (msg.type === 'message' && ['user', 'assistant'].includes(msg.role)) {
      // Periodic task execution — show as a card instead of raw prompt
      if (msg.role === 'user' && msg.metadata?.is_periodic_run) {
        messages.push({
          role: 'user',
          content: '',
          periodicRun: {
            taskId: String(msg.metadata.periodic_task_id || ''),
            taskTitle: String(msg.metadata.periodic_task_title || 'Scheduled Task'),
            executedAt: msg.created_at || '',
          },
        });
        continue;
      }
      const content = Array.isArray(msg.content)
        ? msg.content
            .filter((c) => c.type === 'input_text' || c.type === 'output_text')
            .map((c) => c.text || '')
            .join(' ')
        : '';
      if (content && content !== '(tool calls)') {
        messages.push({ role: msg.role as 'user' | 'assistant', content });
      }
    } else if (msg.type === 'function_call') {
      const content = msg.content as Record<string, unknown>;
      const name = (content.name as string) || 'unknown';
      const args = (content.arguments as string) || '';
      const callId = (content.call_id as string) || '';
      const status = (content.status as string) || 'completed';

      // Skip manage_todo — shown via TodoProgress, not as a tool block
      if (name === 'manage_todo') continue;

      if (callId && seenCallIds.has(callId)) continue;
      if (callId) seenCallIds.add(callId);

      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(args); } catch { /* ignore */ }
      const command = name === 'bash' && parsedArgs.command
        ? String(parsedArgs.command)
        : name;

      messages.push({
        role: 'assistant',
        content: '',
        toolCall: {
          command,
          toolName: name,
          toolArgs: parsedArgs,
          output: outputMap.get(callId),
          status: status === 'failed' ? 'failed' : 'completed',
        },
      });
    } else if (msg.type === 'todo_state') {
      const todoContent = msg.content as unknown as TodoState;
      if (todoContent && todoContent.task) {
        messages.push({ role: 'assistant', content: '', todo: todoContent });
      }
    }
  }

  // Reverse so messages are chronological (oldest first within page)
  messages.reverse();

  return { messages, hasMore };
}

export async function checkSessionUpdates(
  sessionId: string,
): Promise<{ message_count: number; updated_at: string }> {
  const response = await apiClient.get<{ message_count: number; updated_at: string }>(
    `/api/v1/sessions/${sessionId}/check-updates/`,
  );
  return response.data;
}

export interface SubagentProgressStep {
  tool_name: string;
  detail: string;
  status: 'running' | 'completed' | 'failed';
}

export interface SubagentStatusItem {
  child_session_id: string;
  task: string;
  status: string;
  elapsed_seconds: number;
  result_summary?: string | null;
  current_iteration?: number;
  progress?: SubagentProgressStep[];
}

export interface SubagentStatusResponse {
  children: SubagentStatusItem[];
}

export async function fetchSubagentStatus(
  sessionId: string,
): Promise<SubagentStatusResponse> {
  const response = await apiClient.get<SubagentStatusResponse>(
    `/api/v1/subagent/status/${sessionId}/`,
  );
  return response.data;
}

export const chatAPI = {
  sendMessage: async (
    request: ChatRequest,
    onToolCall?: (info: ToolCallInfo) => void,
    onPermissionRequired?: (req: PermissionRequest) => Promise<PermissionDecision>,
    onQuestionRequired?: (req: QuestionRequest) => Promise<QuestionAnswer>,
    onCwdSelectRequired?: () => Promise<boolean>,
  ): Promise<ChatResponse> => {
    const inputItems: InputItem[] = request.messages.filter(m => m.content && !m.toolCall && !m.cancelled).map(messageToItem);

    const tools = buildTools();

    const openRequest: ResponseRequest = {
      input: inputItems,
      tools,
      metadata: request.session_id ? { session_id: request.session_id } : undefined,
    };

    let response = await apiClient.post<ResponseObject>('/api/v1/proxy/', openRequest);
    let data = response.data;
    if (data.status === 'failed') {
      throw new Error(data.error?.message || 'Server returned an error');
    }
    let previousResponseId = data.id;
    const collectedToolCalls: ToolCallInfo[] = [];

    const clientId = canExecuteTools() ? await window.api!.getClientId() : '';

    // Tool call loop (max 10 iterations for multi-step browser workflows)
    let iterations = 0;
    while (iterations < 10) {
      const toolCalls = data.output.filter(isToolCall);
      if (toolCalls.length === 0) break;

      iterations++;

      const toolResults: FunctionToolResult[] = [];
      for (const tc of toolCalls) {
        // --- Handle ask_question tool calls ---
        if (tc.name === 'ask_question') {
          const qArgs = JSON.parse(tc.arguments);
          if (onQuestionRequired) {
            const questionReq: QuestionRequest = {
              callId: tc.call_id,
              question: qArgs.question,
              choices: qArgs.choices,
              allowUserInput: qArgs.allow_user_input ?? false,
            };
            const answer = await onQuestionRequired(questionReq);
            const outputText =
              answer.type === 'cancelled'
                ? 'User cancelled the question.'
                : answer.type === 'choice'
                  ? `User chose: ${answer.value}`
                  : `User input: ${answer.value}`;
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output: outputText,
            });
          } else {
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output: `User chose: ${qArgs.choices[0]}`,
            });
          }
          continue;
        }

        // --- Handle mobile tool calls ---
        if (MOBILE_TOOL_NAMES.has(tc.name)) {
          if (!isMobileApp()) {
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output: 'Error: Mobile device tools are only available on mobile.',
            });
            continue;
          }

          // Permission check for mobile tools
          const mobileStored = await checkPermission(clientId, tc.name, tc.name);
          let mobileDecision: PermissionDecision = 'allow_once';
          if (mobileStored === true) {
            mobileDecision = 'always_allow';
          } else if (mobileStored === false) {
            mobileDecision = 'deny';
          } else if (onPermissionRequired) {
            mobileDecision = await onPermissionRequired({
              toolName: tc.name,
              command: tc.name,
              callId: tc.call_id,
            });
          }

          const mobileLogDecision = mobileStored === true ? 'auto_approved' : mobileDecision;
          const mobileSid = data.metadata?.session_id || request.session_id || '';
          logPermissionDecision(mobileSid, clientId, tc.name, tc.name, tc.name, mobileLogDecision, tc.call_id).catch(() => {});

          if (mobileDecision === 'deny') {
            const deniedInfo: ToolCallInfo = {
              command: tc.name,
              status: 'failed',
              output: 'Permission denied by user',
              exitCode: -1,
            };
            onToolCall?.({ ...deniedInfo });
            collectedToolCalls.push(deniedInfo);
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output: 'Permission denied: user rejected tool execution.',
            });
            continue;
          }

          if (mobileDecision === 'always_allow' && mobileStored !== true) {
            await setPermission(clientId, tc.name, tc.name, true);
          }

          const toolInfo: ToolCallInfo = { command: tc.name, status: 'running' };
          onToolCall?.({ ...toolInfo });

          try {
            const tcArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
            const result = await window.mobileBridge!.request(tc.name, tcArgs);
            const output = JSON.stringify(result);
            toolInfo.output = output;
            toolInfo.status = 'completed';
            toolInfo.exitCode = 0;
            onToolCall?.({ ...toolInfo });
            collectedToolCalls.push({ ...toolInfo });
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output,
            });
          } catch (err: any) {
            toolInfo.output = err.message || 'Failed to read device data';
            toolInfo.status = 'failed';
            toolInfo.exitCode = 1;
            onToolCall?.({ ...toolInfo });
            collectedToolCalls.push({ ...toolInfo });
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output: `Error: ${err.message || 'Failed to read device data'}`,
            });
          }
          continue;
        }

        // --- Non-question tools require canExecuteTools ---
        if (!canExecuteTools()) {
          throw new Error(
            'Tool calls other than questions are not supported in the web browser. Please use the desktop client.',
          );
        }

        // --- Handle select_cwd tool calls (no permission needed — user picks folder interactively) ---
        if (tc.name === 'select_cwd') {
          const cwdCallInfo: ToolCallInfo = { command: 'select_cwd', status: 'running' };

          // If user already declined, stop the conversation immediately
          if (cwdSelectionDeclined) {
            cwdCallInfo.output = 'User already declined working directory selection.';
            cwdCallInfo.status = 'failed';
            cwdCallInfo.exitCode = 1;
            onToolCall?.({ ...cwdCallInfo });
            collectedToolCalls.push({ ...cwdCallInfo });
            const sessionId = data.metadata?.session_id || request.session_id || '';
            return {
              message:
                'A working directory is required to run commands. You can set one using the "Set Working Directory" button in the header.',
              session_id: sessionId,
              toolCalls: collectedToolCalls,
            };
          }

          // Auto-report if a working directory is already set
          if (sessionCwd) {
            cwdCallInfo.output = `Working directory is already set to: ${sessionCwd}`;
            cwdCallInfo.status = 'completed';
            cwdCallInfo.exitCode = 0;
            onToolCall?.({ ...cwdCallInfo });
            collectedToolCalls.push({ ...cwdCallInfo });
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output: `Working directory is already set to: ${sessionCwd}`,
            });
            continue;
          }

          // Ask user for confirmation before opening the folder picker
          let userConfirmed = true;
          if (onCwdSelectRequired) {
            userConfirmed = await onCwdSelectRequired();
          }

          if (!userConfirmed) {
            cwdSelectionDeclined = true;
            cwdCallInfo.output = 'User declined working directory selection.';
            cwdCallInfo.status = 'failed';
            cwdCallInfo.exitCode = 1;
            onToolCall?.({ ...cwdCallInfo });
            collectedToolCalls.push({ ...cwdCallInfo });
            const sessionId = data.metadata?.session_id || request.session_id || '';
            return {
              message:
                'A working directory is required to run commands. You can set one using the "Set Working Directory" button in the header.',
              session_id: sessionId,
              toolCalls: collectedToolCalls,
            };
          }

          onToolCall?.({ ...cwdCallInfo });

          const cwdResult = await window.api!.selectCwd();
          if (cwdResult.path) {
            setSessionCwd(cwdResult.path);
            // Persist CWD to platform
            const sid = request.session_id || data.metadata?.session_id;
            if (sid) {
              await updateSessionCwd(sid, cwdResult.path);
            }
            cwdCallInfo.output = `Working directory set to: ${cwdResult.path}`;
            cwdCallInfo.status = 'completed';
            cwdCallInfo.exitCode = 0;
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output: `Working directory set to: ${cwdResult.path}`,
            });
          } else {
            cwdSelectionDeclined = true;
            cwdCallInfo.output = 'User cancelled folder selection.';
            cwdCallInfo.status = 'failed';
            cwdCallInfo.exitCode = 1;
            onToolCall?.({ ...cwdCallInfo });
            collectedToolCalls.push({ ...cwdCallInfo });
            const sessionId = data.metadata?.session_id || request.session_id || '';
            return {
              message:
                'A working directory is required to run commands. You can set one using the "Set Working Directory" button in the header.',
              session_id: sessionId,
              toolCalls: collectedToolCalls,
            };
          }
          onToolCall?.({ ...cwdCallInfo });
          collectedToolCalls.push({ ...cwdCallInfo });
          continue;
        }

        // --- Handle browser tool calls ---
        if (tc.name.startsWith('browser_')) {
          const browserArgs = JSON.parse(tc.arguments);
          const action = tc.name.replace('browser_', '');
          const displayCommand =
            tc.name === 'browser_navigate'
              ? `Navigate: ${browserArgs.url}`
              : tc.name === 'browser_new_tab'
                ? `New tab: ${browserArgs.url}`
                : tc.name === 'browser_click'
                  ? `Click: ${browserArgs.selector}`
                  : tc.name === 'browser_type'
                    ? `Type into ${browserArgs.selector}: "${browserArgs.text}"`
                    : 'Get page content';

          // Permission check for browser tools
          const browserBaseCommand = tc.name;
          let browserDecision: PermissionDecision = 'allow_once';
          const browserStored = await checkPermission(clientId, tc.name, browserBaseCommand);
          if (browserStored === true) {
            browserDecision = 'always_allow';
          } else if (browserStored === false) {
            browserDecision = 'deny';
          } else if (onPermissionRequired) {
            browserDecision = await onPermissionRequired({
              toolName: tc.name,
              command: displayCommand,
              callId: tc.call_id,
            });
          }

          const browserLogDecision = browserStored === true ? 'auto_approved' : browserDecision;
          const browserSid = data.metadata?.session_id || request.session_id || '';
          logPermissionDecision(browserSid, clientId, tc.name, displayCommand, browserBaseCommand, browserLogDecision, tc.call_id).catch(() => {});

          if (browserDecision === 'deny') {
            const deniedInfo: ToolCallInfo = {
              command: displayCommand,
              status: 'failed',
              output: 'Permission denied by user',
              exitCode: -1,
            };
            onToolCall?.({ ...deniedInfo });
            collectedToolCalls.push(deniedInfo);
            toolResults.push({
              type: 'function_call_output',
              call_id: tc.call_id,
              output: 'Permission denied: user rejected browser action.',
            });
            continue;
          }

          if (browserDecision === 'always_allow' && browserStored !== true) {
            await setPermission(clientId, tc.name, browserBaseCommand, true);
          }

          const browserToolInfo: ToolCallInfo = { command: displayCommand, status: 'running' };
          onToolCall?.({ ...browserToolInfo });

          const browserResult = await window.api!.browserCommand(action, browserArgs);
          const browserOutput = browserResult.success
            ? browserResult.output
            : `Error: ${browserResult.error || 'Unknown error'}`;

          browserToolInfo.output = browserOutput || '(no output)';
          browserToolInfo.status = browserResult.success ? 'completed' : 'failed';
          browserToolInfo.exitCode = browserResult.success ? 0 : 1;
          onToolCall?.({ ...browserToolInfo });
          collectedToolCalls.push({ ...browserToolInfo });

          toolResults.push({
            type: 'function_call_output',
            call_id: tc.call_id,
            output: browserOutput || '(no output)',
          });
          continue;
        }

        // --- Handle bash tool calls ---
        // Block bash execution if no working directory is set
        if (!sessionCwd) {
          const deniedInfo: ToolCallInfo = {
            command: tc.name,
            status: 'failed',
            output: 'No working directory set.',
            exitCode: 1,
          };
          onToolCall?.({ ...deniedInfo });
          collectedToolCalls.push(deniedInfo);
          const sessionId = data.metadata?.session_id || request.session_id || '';
          return {
            message:
              'A working directory is required to run commands. You can set one using the "Set Working Directory" button in the header.',
            session_id: sessionId,
            toolCalls: collectedToolCalls,
          };
        }

        const args = JSON.parse(tc.arguments);
        const command: string = args.command;
        const baseCommand = extractBaseCommand(command);

        // --- Permission check (always query platform) ---
        let decision: PermissionDecision = 'allow_once';

        const stored = await checkPermission(clientId, tc.name, baseCommand);
        if (stored === true) {
          decision = 'always_allow';
        } else if (stored === false) {
          decision = 'deny';
        } else if (onPermissionRequired) {
          decision = await onPermissionRequired({
            toolName: tc.name,
            command,
            callId: tc.call_id,
          });
        }

        const bashLogDecision = stored === true ? 'auto_approved' : decision;
        const bashSid = data.metadata?.session_id || request.session_id || '';
        logPermissionDecision(bashSid, clientId, tc.name, command, baseCommand, bashLogDecision, tc.call_id).catch(() => {});

        // --- Handle denial ---
        if (decision === 'deny') {
          const deniedInfo: ToolCallInfo = {
            command,
            status: 'failed',
            output: 'Permission denied by user',
            exitCode: -1,
          };
          onToolCall?.({ ...deniedInfo });
          collectedToolCalls.push(deniedInfo);
          toolResults.push({
            type: 'function_call_output',
            call_id: tc.call_id,
            output: 'Permission denied: user rejected tool execution.',
          });
          continue;
        }

        // --- Store "always allow" if user chose it and it wasn't already stored ---
        if (decision === 'always_allow' && stored !== true) {
          await setPermission(clientId, tc.name, baseCommand, true);
        }

        // --- Execute the tool ---
        const toolCallInfo: ToolCallInfo = { command, status: 'running' };
        onToolCall?.({ ...toolCallInfo });

        const result = await window.api!.executeBash(command, sessionCwd || undefined);
        const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
        const exitCode = result.exitCode;

        toolCallInfo.output = output || '(no output)';
        toolCallInfo.exitCode = exitCode;
        toolCallInfo.status = exitCode === 0 ? 'completed' : 'failed';
        onToolCall?.({ ...toolCallInfo });
        collectedToolCalls.push({ ...toolCallInfo });

        toolResults.push({
          type: 'function_call_output',
          call_id: tc.call_id,
          output: output || '(no output)',
        });
      }

      // Send results back (include tools so LLM can chain select_cwd → bash)
      const followUpInput: InputItem[] = [...inputItems, ...toolCalls, ...toolResults];
      const followUpRequest: ResponseRequest = {
        input: followUpInput,
        tools: buildTools(),
        previous_response_id: previousResponseId,
        metadata: request.session_id ? { session_id: request.session_id } : undefined,
      };

      response = await apiClient.post<ResponseObject>('/api/v1/proxy/', followUpRequest);
      data = response.data;
      if (data.status === 'failed') {
        throw new Error(data.error?.message || 'Server returned an error');
      }
      previousResponseId = data.id;
    }

    // Extract final text response
    const assistantOutput = data.output.find(
      (item): item is MessageItem => isMessageItem(item) && item.role === 'assistant',
    );
    const message = assistantOutput ? extractTextFromItem(assistantOutput) : '';
    const sessionId = data.metadata?.session_id || '';

    return { message, session_id: sessionId, toolCalls: collectedToolCalls };
  },

  /**
   * Send a streaming chat request via SSE.
   * Calls onEvent for each parsed SSE event.
   * Returns the final ResponseObject from the completed/incomplete/failed event.
   */
  sendMessageStream: async (
    request: ChatRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<ResponseObject> => {
    const inputItems: InputItem[] = [
      ...request.messages.filter(m => m.content && !m.toolCall && !m.cancelled).map(messageToItem),
      ...(request.extraInput || []),
    ];
    const tools = buildTools();

    const openRequest: ResponseRequest = {
      input: inputItems,
      tools,
      stream: true,
      metadata: request.session_id ? { session_id: request.session_id } : undefined,
    };

    const csrfToken = getCsrfToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (csrfToken) headers['X-CSRFToken'] = csrfToken;

    const resp = await fetch(`${API_BASE_URL}/api/v1/proxy/`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(openRequest),
    });

    if (!resp.ok) {
      throw new Error(`Server error: ${resp.status}`);
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResponse: ResponseObject | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const event: StreamEvent = JSON.parse(payload);
          onEvent(event);
          if (
            event.type === 'response.completed' ||
            event.type === 'response.incomplete' ||
            event.type === 'response.failed'
          ) {
            finalResponse = event.response;
          }
        } catch {
          // skip unparseable lines
        }
      }
    }

    if (!finalResponse) {
      throw new Error('Stream ended without a final response event');
    }
    return finalResponse;
  },
};

// --- Session Files API ---

export interface SessionFileInfo {
  id: string;
  path: string;
  filename: string;
  content_type: string;
  size: number;
  is_text: boolean;
  text_content: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function fetchSessionFiles(sessionId: string, path?: string): Promise<SessionFileInfo[]> {
  const params: Record<string, string> = {};
  if (path) params.path = path;
  const resp = await apiClient.get<SessionFileInfo[]>(`/api/v1/sessions/${sessionId}/files/`, { params });
  return resp.data;
}

export async function uploadSessionFile(sessionId: string, file: File, path?: string): Promise<SessionFileInfo> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('path', path || file.name);
  const resp = await apiClient.post<SessionFileInfo>(`/api/v1/sessions/${sessionId}/files/`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return resp.data;
}

export async function getSessionFile(sessionId: string, fileId: string): Promise<SessionFileInfo> {
  const resp = await apiClient.get<SessionFileInfo>(`/api/v1/sessions/${sessionId}/files/${fileId}/`);
  return resp.data;
}

export async function updateSessionFileContent(sessionId: string, fileId: string, textContent: string): Promise<SessionFileInfo> {
  const resp = await apiClient.put<SessionFileInfo>(`/api/v1/sessions/${sessionId}/files/${fileId}/`, { text_content: textContent });
  return resp.data;
}

export async function deleteSessionFile(sessionId: string, fileId: string): Promise<void> {
  await apiClient.delete(`/api/v1/sessions/${sessionId}/files/${fileId}/`);
}

export async function downloadSessionFile(sessionId: string, fileId: string): Promise<Blob> {
  const resp = await apiClient.get(`/api/v1/sessions/${sessionId}/files/${fileId}/download/`, {
    responseType: 'blob',
  });
  return resp.data;
}

export interface SuggestedQuestion {
  id: string;
  question_text: string;
  order: number;
}

export async function fetchSuggestedQuestions(): Promise<SuggestedQuestion[]> {
  const response = await apiClient.get<SuggestedQuestion[]>('/api/v1/suggested-questions/');
  return response.data;
}

// --- Notification API ---

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPreferences {
  enabled: boolean;
  web_enabled: boolean;
  electron_enabled: boolean;
  mobile_enabled: boolean;
  updated_at: string;
}

export interface NotificationPreferencesResponse {
  preferences: NotificationPreferences;
  registered_device_types: string[];
}

export const notificationAPI = {
  registerDevice: async (token: string, deviceType: string): Promise<void> => {
    await apiClient.post('/api/v1/notifications/register-device/', {
      token,
      device_type: deviceType,
    });
  },

  unregisterDevice: async (token: string): Promise<void> => {
    await apiClient.post('/api/v1/notifications/unregister-device/', { token });
  },

  list: async (unreadOnly = false): Promise<NotificationItem[]> => {
    const params: Record<string, string> = {};
    if (unreadOnly) params.unread = '1';
    const response = await apiClient.get<NotificationItem[]>('/api/v1/notifications/', { params });
    return response.data;
  },

  markRead: async (notificationId: string): Promise<void> => {
    await apiClient.post(`/api/v1/notifications/${notificationId}/read/`);
  },

  markAllRead: async (): Promise<void> => {
    await apiClient.post('/api/v1/notifications/read-all/');
  },

  getPreferences: async (): Promise<NotificationPreferencesResponse> => {
    const response = await apiClient.get<NotificationPreferencesResponse>('/api/v1/notifications/preferences/');
    return response.data;
  },

  updatePreferences: async (prefs: Partial<NotificationPreferences>): Promise<NotificationPreferences> => {
    const response = await apiClient.patch<NotificationPreferences>('/api/v1/notifications/preferences/', prefs);
    return response.data;
  },
};

// --- Periodic Tasks API ---

export const periodicTaskAPI = {
  list: async (): Promise<PeriodicTask[]> => {
    const response = await apiClient.get<PeriodicTask[]>('/api/v1/periodic-tasks/');
    return response.data;
  },

  get: async (taskId: string): Promise<PeriodicTask> => {
    const response = await apiClient.get<PeriodicTask>(`/api/v1/periodic-tasks/${taskId}/`);
    return response.data;
  },

  pause: async (taskId: string): Promise<PeriodicTask> => {
    const response = await apiClient.post<PeriodicTask>(`/api/v1/periodic-tasks/${taskId}/pause/`);
    return response.data;
  },

  resume: async (taskId: string): Promise<PeriodicTask> => {
    const response = await apiClient.post<PeriodicTask>(`/api/v1/periodic-tasks/${taskId}/resume/`);
    return response.data;
  },

  delete: async (taskId: string): Promise<void> => {
    await apiClient.delete(`/api/v1/periodic-tasks/${taskId}/`);
  },

  update: async (taskId: string, updates: Partial<PeriodicTask>): Promise<PeriodicTask> => {
    const response = await apiClient.patch<PeriodicTask>(`/api/v1/periodic-tasks/${taskId}/`, updates);
    return response.data;
  },

  runs: async (taskId: string): Promise<PeriodicTaskRun[]> => {
    const response = await apiClient.get<PeriodicTaskRun[]>(`/api/v1/periodic-tasks/${taskId}/runs/`);
    return response.data;
  },
};
