// Copyright (c) 2026 Heureum AI. All rights reserved.

interface BashResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface BrowserCommandResult {
  success: boolean
  output: string
  error?: string
}

interface SelectCwdResult {
  path: string | null
}

interface CodingToolResult {
  success: boolean
  output: string
  images?: Array<{ data: string; mimeType: string }>
}

interface CodingToolSchema {
  type: string
  name: string
  description?: string
  parameters?: Record<string, any>
}

interface ElectronAPI {
  executeBash: (command: string, cwd?: string) => Promise<BashResult>
  selectCwd: () => Promise<SelectCwdResult>
  getClientId: () => Promise<string>
  canExecuteTools: boolean
  getCodingTools: () => Promise<CodingToolSchema[]>
  codingTool: (toolName: string, args: Record<string, unknown>, cwd?: string) => Promise<CodingToolResult>
  browserCommand: (action: string, params: Record<string, unknown>) => Promise<BrowserCommandResult>
  isBrowserExtensionConnected: () => Promise<boolean>
  // TODO: re-enable when document tools are ready
  // docxTool: (toolName: string, params: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>
  // pdfTool: (toolName: string, params: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>
  // pptTool: (toolName: string, params: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>
  // xlsxTool: (toolName: string, params: Record<string, unknown>) => Promise<{ success: boolean; output: string; error?: string }>
  startNotificationStream: (platformUrl: string) => Promise<{ success: boolean }>
  stopNotificationStream: () => Promise<{ success: boolean }>
  openSessionFolder: (sessionId: string, sessionTitle: string) => Promise<void>
  syncSessionFiles: (sessionId: string, sessionTitle: string, apiBaseUrl: string) => Promise<{ success: boolean; error?: string }>
  startFileWatcher: (sessionId: string, sessionTitle: string, apiBaseUrl: string) => Promise<{ success: boolean }>
  stopFileWatcher: (sessionId: string) => Promise<{ success: boolean }>
  getNotificationInfo: () => Promise<{ supported: boolean; platform: string }>
  openNotificationSettings: () => Promise<{ success: boolean }>
  sendTestNotification: () => Promise<{ success: boolean; error?: string }>
}

interface MobileBridge {
  available: boolean
  request: (action: string, params?: Record<string, unknown>) => Promise<any>
}

declare global {
  interface Window {
    api?: ElectronAPI
    mobileBridge?: MobileBridge
  }
}

export {}
