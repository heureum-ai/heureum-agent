// Copyright (c) 2026 Heureum AI. All rights reserved.

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  executeBash: (command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    return ipcRenderer.invoke('execute-bash', command, cwd)
  },
  selectCwd: (): Promise<{ path: string | null }> => {
    return ipcRenderer.invoke('select-cwd')
  },
  getClientId: (): Promise<string> => {
    return ipcRenderer.invoke('get-client-id')
  },
  canExecuteTools: true,
  getCodingTools: (): Promise<Array<{ type: string; name: string; description?: string; parameters?: Record<string, any> }>> => {
    return ipcRenderer.invoke('get-coding-tools')
  },
  codingTool: (
    toolName: string,
    args: Record<string, unknown>,
    cwd?: string
  ): Promise<{ success: boolean; output: string; images?: Array<{ data: string; mimeType: string }> }> => {
    return ipcRenderer.invoke('coding-tool', toolName, args, cwd)
  },
  browserCommand: (
    action: string,
    params: Record<string, unknown>
  ): Promise<{ success: boolean; output: string; error?: string }> => {
    return ipcRenderer.invoke('browser-command', { action, params })
  },
  isBrowserExtensionConnected: (): Promise<boolean> => {
    return ipcRenderer.invoke('browser-extension-status')
  },
  // TODO: re-enable when document tools are ready
  // docxTool: (
  //   toolName: string,
  //   params: Record<string, unknown>
  // ): Promise<{ success: boolean; output: string; error?: string }> => {
  //   return ipcRenderer.invoke('docx-tool', toolName, params)
  // },
  // pdfTool: (
  //   toolName: string,
  //   params: Record<string, unknown>
  // ): Promise<{ success: boolean; output: string; error?: string }> => {
  //   return ipcRenderer.invoke('pdf-tool', toolName, params)
  // },
  // pptTool: (
  //   toolName: string,
  //   params: Record<string, unknown>
  // ): Promise<{ success: boolean; output: string; error?: string }> => {
  //   return ipcRenderer.invoke('ppt-tool', toolName, params)
  // },
  // xlsxTool: (
  //   toolName: string,
  //   params: Record<string, unknown>
  // ): Promise<{ success: boolean; output: string; error?: string }> => {
  //   return ipcRenderer.invoke('xlsx-tool', toolName, params)
  // },
  startNotificationStream: (platformUrl: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('start-notification-stream', platformUrl)
  },
  stopNotificationStream: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('stop-notification-stream')
  },
  onPushNotification: (callback: (data: { title: string; body: string; data: Record<string, unknown> }) => void): void => {
    ipcRenderer.on('push-notification', (_event, payload) => callback(payload))
  },
  onPushNotificationClick: (callback: (data: Record<string, unknown>) => void): void => {
    ipcRenderer.on('push-notification-click', (_event, payload) => callback(payload))
  },
  openSessionFolder: (sessionId: string, sessionTitle: string): Promise<void> => {
    return ipcRenderer.invoke('open-session-folder', sessionId, sessionTitle)
  },
  syncSessionFiles: (sessionId: string, sessionTitle: string, apiBaseUrl: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('sync-session-files', sessionId, sessionTitle, apiBaseUrl)
  },
  startFileWatcher: (sessionId: string, sessionTitle: string, apiBaseUrl: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('start-file-watcher', sessionId, sessionTitle, apiBaseUrl)
  },
  stopFileWatcher: (sessionId: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('stop-file-watcher', sessionId)
  },
  getNotificationInfo: (): Promise<{ supported: boolean; platform: string }> => {
    return ipcRenderer.invoke('get-notification-info')
  },
  openNotificationSettings: (): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke('open-notification-settings')
  },
  sendTestNotification: (): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('send-test-notification')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
