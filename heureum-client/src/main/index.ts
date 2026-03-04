// Copyright (c) 2026 Heureum AI. All rights reserved.

import { app, BrowserWindow, dialog, ipcMain, session, shell, Notification } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, watch, statSync } from 'fs'
import { randomUUID } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { autoUpdater } from 'electron-updater'
import http from 'http'
import https from 'https'
import { getExecutableTools, handleToolExecution, getSkillsSnapshot, writeSkillFiles, WEB_TOOL_NAMES } from './tools'
import { BROWSER_TOOLS as BROWSER_TOOL_DEFS } from '@heureum/browser'

// --- Deep link protocol registration ---
const PROTOCOL = 'heureum'

if (process.platform === 'win32') {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, ['--'])
} else {
  app.setAsDefaultProtocolClient(PROTOCOL)
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'client-settings.json')
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(getSettingsPath(), 'utf-8'))
  } catch {
    return {}
  }
}

function writeSettings(patch: Record<string, unknown>): void {
  const settings = readSettings()
  Object.assign(settings, patch)
  writeFileSync(getSettingsPath(), JSON.stringify(settings), 'utf-8')
}

function getOrCreateClientId(): string {
  const settings = readSettings()
  if (settings.clientId) return settings.clientId as string
  const clientId = randomUUID()
  writeSettings({ clientId })
  return clientId
}

// --- SSE notification stream ---

let sseRequest: ReturnType<typeof http.get> | null = null
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null
let sseLastNotificationId: string | null = null

function stopNotificationStream(resetLastId = true): void {
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer)
    sseRetryTimer = null
  }
  if (sseRequest) {
    sseRequest.destroy()
    sseRequest = null
  }
  if (resetLastId) {
    sseLastNotificationId = null
    writeSettings({ sseLastNotificationId: null })
  }
}

async function startNotificationStream(platformUrl: string): Promise<void> {
  stopNotificationStream(false)

  // Restore last seen notification ID from disk if not already in memory
  if (!sseLastNotificationId) {
    const settings = readSettings()
    if (settings.sseLastNotificationId) {
      sseLastNotificationId = settings.sseLastNotificationId as string
    }
  }

  // Get session cookies from Electron's cookie store (includes HttpOnly cookies)
  const parsed = new URL(platformUrl)
  const cookies = await session.defaultSession.cookies.get({ url: platformUrl })
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  if (!cookieHeader) {
    console.log('[Heureum] No cookies for platform — skipping notification stream')
    return
  }

  const mod = platformUrl.startsWith('https') ? https : http

  console.log('[Heureum] Connecting to notification stream...')

  sseRequest = mod.get(
    {
      hostname: parsed.hostname,
      port: parsed.port,
      path: '/api/v1/notifications/stream/' + (sseLastNotificationId ? `?last_id=${sseLastNotificationId}` : ''),
      headers: {
        Cookie: cookieHeader,
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        console.error('[Heureum] Notification stream HTTP', res.statusCode)
        sseRetryTimer = setTimeout(() => startNotificationStream(platformUrl), 10000)
        return
      }

      console.log('[Heureum] Notification stream connected')
      let buffer = ''

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()

        // Process complete SSE events (separated by double newline)
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''

        for (const part of parts) {
          const line = part.trim()
          if (!line || line.startsWith(':')) continue // heartbeat or comment

          const match = line.match(/^data:\s*(.+)$/)
          if (!match) continue

          try {
            const notification = JSON.parse(match[1])

            // Skip non-notification events (e.g. {"type": "disabled"})
            if (!notification.id || notification.type === 'disabled') continue

            console.log('[Heureum] Notification received:', notification.title)
            sseLastNotificationId = notification.id
            writeSettings({ sseLastNotificationId: notification.id })

            if (Notification.isSupported()) {
              const nativeNotification = new Notification({
                title: notification.title || 'Heureum',
                body: notification.body || '',
              })

              nativeNotification.on('click', () => {
                if (mainWindow) {
                  if (mainWindow.isMinimized()) mainWindow.restore()
                  mainWindow.focus()
                  mainWindow.webContents.send('push-notification-click', notification.data || {})
                }
              })

              nativeNotification.show()
            }

            if (mainWindow) {
              mainWindow.webContents.send('push-notification', {
                title: notification.title,
                body: notification.body,
                data: notification.data || {},
              })
            }
          } catch {
            // Ignore parse errors
          }
        }
      })

      res.on('end', () => {
        console.log('[Heureum] Notification stream ended, reconnecting...')
        sseRetryTimer = setTimeout(() => startNotificationStream(platformUrl), 3000)
      })

      res.on('error', (err) => {
        console.error('[Heureum] Notification stream error:', err.message)
        sseRetryTimer = setTimeout(() => startNotificationStream(platformUrl), 10000)
      })
    }
  )

  sseRequest.on('error', (err) => {
    console.error('[Heureum] Notification stream connection error:', err.message)
    sseRetryTimer = setTimeout(() => startNotificationStream(platformUrl), 10000)
  })
}

// --- WebSocket server for Chrome extension communication ---

const WS_PORT = 9222
const PING_INTERVAL_MS = 30000
let wss: WebSocketServer | null = null
let extensionSocket: WebSocket | null = null
let pingInterval: ReturnType<typeof setInterval> | null = null
const pendingCommands = new Map<
  string,
  { resolve: (value: { success: boolean; output: string; error?: string }) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }
>()

function startPingInterval(socket: WebSocket): void {
  stopPingInterval()
  pingInterval = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ method: 'ping' }))
    }
  }, PING_INTERVAL_MS)
}

function stopPingInterval(): void {
  if (pingInterval) {
    clearInterval(pingInterval)
    pingInterval = null
  }
}

function startWebSocketServer(): void {
  wss = new WebSocketServer({ port: WS_PORT })

  wss.on('connection', (socket) => {
    console.log('[Heureum] Chrome extension connected')
    extensionSocket = socket
    startPingInterval(socket)

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())

        // Handle keepalive pong — just ignore it
        if (msg.method === 'pong') return

        const pending = pendingCommands.get(msg.id)
        if (!pending) return

        clearTimeout(pending.timer)
        pendingCommands.delete(msg.id)

        if (msg.success) {
          pending.resolve({ success: true, output: msg.result || '' })
        } else {
          pending.resolve({ success: false, output: '', error: msg.error || 'Command failed' })
        }
      } catch {
        // Invalid message, ignore
      }
    })

    socket.on('close', () => {
      console.log('[Heureum] Chrome extension disconnected')
      if (extensionSocket === socket) {
        extensionSocket = null
        stopPingInterval()
      }
      // Reject all pending commands
      for (const [id, pending] of pendingCommands) {
        clearTimeout(pending.timer)
        pending.resolve({ success: false, output: '', error: 'Extension disconnected' })
        pendingCommands.delete(id)
      }
    })
  })

  wss.on('error', (err) => {
    console.error('[Heureum] WebSocket server error:', err.message)
  })

  console.log(`[Heureum] WebSocket server started on port ${WS_PORT}`)
}

function sendBrowserCommand(
  action: string,
  params: Record<string, unknown>
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      resolve({
        success: false,
        output: '',
        error: 'Chrome extension is not connected. Please install and enable the Heureum extension.'
      })
      return
    }

    const id = randomUUID()
    const timer = setTimeout(() => {
      pendingCommands.delete(id)
      resolve({ success: false, output: '', error: 'Command timed out (15s)' })
    }, 15000)

    pendingCommands.set(id, { resolve, reject: () => {}, timer })
    extensionSocket.send(JSON.stringify({ id, action, params }))
  })
}

// --- Deep link handling ---

let mainWindow: BrowserWindow | null = null
const DEFAULT_FRONTEND_URL = 'http://localhost:5173'
const FRONTEND_RETRY_INTERVAL_MS = 300
const FRONTEND_MAX_RETRIES = 100

function getFrontendUrl(): string {
  const fromEnv = process.env['FRONTEND_URL']?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_FRONTEND_URL
}

function isLocalDevFrontend(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function loadFrontendWithRetry(targetWindow: BrowserWindow, frontendUrl: string, attempt = 1): void {
  targetWindow
    .loadURL(frontendUrl)
    .then(() => {
      console.log(`[Heureum] Frontend loaded: ${frontendUrl}`)
    })
    .catch((err) => {
      const shouldRetry = isLocalDevFrontend(frontendUrl) && attempt < FRONTEND_MAX_RETRIES
      if (!shouldRetry) {
        console.error(`[Heureum] Failed to load frontend (${frontendUrl}):`, err)
        return
      }

      if (targetWindow.isDestroyed()) return
      setTimeout(() => {
        if (!targetWindow.isDestroyed()) {
          loadFrontendWithRetry(targetWindow, frontendUrl, attempt + 1)
        }
      }, FRONTEND_RETRY_INTERVAL_MS)
    })
}

function handleDeepLink(url: string): void {
  console.log('[Heureum] Deep link received:', url)

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    console.error('[Heureum] Invalid deep link URL:', url)
    return
  }

  // heureum://auth/callback?token=XXX
  if (parsed.hostname === 'auth' && parsed.pathname === '/callback') {
    const token = parsed.searchParams.get('token')
    if (token) {
      const platformUrl = process.env['PLATFORM_URL'] || 'http://localhost:8001'
      const exchangeUrl = `${platformUrl}/api/v1/auth/token/exchange/?token=${encodeURIComponent(token)}`

      if (mainWindow) {
        mainWindow.focus()
        mainWindow.webContents.loadURL(exchangeUrl)
      }
    }
  }
}

// macOS: open-url is fired when app is already running OR launched via URL
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (app.isReady()) {
    handleDeepLink(url)
  } else {
    app.once('ready', () => handleDeepLink(url))
  }
})

// --- Window creation ---

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.webContents.setWindowOpenHandler((_details) => {
    return { action: 'deny' }
  })

  // Load the frontend URL (heureum-frontend serves the UI)
  const frontendUrl = getFrontendUrl()
  loadFrontendWithRetry(mainWindow, frontendUrl)
}

// --- IPC Handlers ---

ipcMain.handle('get-client-id', async () => {
  return getOrCreateClientId()
})

ipcMain.handle('get-coding-tools', () => {
  return getExecutableTools()
})

ipcMain.handle('get-web-tool-names', () => {
  return Array.from(WEB_TOOL_NAMES)
})

ipcMain.handle('get-browser-tools', () => {
  return BROWSER_TOOL_DEFS
})

ipcMain.handle('get-skills-snapshot', () => {
  return getSkillsSnapshot()
})

ipcMain.handle(
  'coding-tool',
  async (
    _event,
    toolName: string,
    args: Record<string, unknown>,
    cwd?: string
  ): Promise<{ success: boolean; output: string; images?: Array<{ data: string; mimeType: string }> }> => {
    try {
      const result = await handleToolExecution(toolName, args, cwd)
      return result
    } catch (err: any) {
      return { success: false, output: err.message || 'Tool execution failed' }
    }
  }
)

ipcMain.handle('select-cwd', async (): Promise<{ path: string | null }> => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select Working Directory',
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { path: null }
  }
  return { path: result.filePaths[0] }
})

ipcMain.handle(
  'browser-command',
  async (_event, { action, params }: { action: string; params: Record<string, unknown> }) => {
    return sendBrowserCommand(action, params)
  }
)

ipcMain.handle('browser-extension-status', async () => {
  return extensionSocket !== null && extensionSocket.readyState === WebSocket.OPEN
})

ipcMain.handle(
  'docx-tool',
  async (_event, toolName: string, params: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> => {
    try {
      const result = await handleToolExecution(toolName, params)
      return { success: result.success, output: result.output, error: result.success ? undefined : result.output }
    } catch (err: any) {
      return { success: false, output: '', error: err.message || 'DOCX tool execution failed' }
    }
  }
)

ipcMain.handle(
  'pdf-tool',
  async (_event, toolName: string, params: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> => {
    try {
      const result = await handleToolExecution(toolName, params)
      return { success: result.success, output: result.output, error: result.success ? undefined : result.output }
    } catch (err: any) {
      return { success: false, output: '', error: err.message || 'PDF tool execution failed' }
    }
  }
)

ipcMain.handle(
  'ppt-tool',
  async (_event, toolName: string, params: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> => {
    try {
      const result = await handleToolExecution(toolName, params)
      return { success: result.success, output: result.output, error: result.success ? undefined : result.output }
    } catch (err: any) {
      return { success: false, output: '', error: err.message || 'PPT tool execution failed' }
    }
  }
)

ipcMain.handle(
  'xlsx-tool',
  async (_event, toolName: string, params: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> => {
    try {
      const result = await handleToolExecution(toolName, params)
      return { success: result.success, output: result.output, error: result.success ? undefined : result.output }
    } catch (err: any) {
      return { success: false, output: '', error: err.message || 'XLSX tool execution failed' }
    }
  }
)

ipcMain.handle(
  'md-tool',
  async (_event, toolName: string, params: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> => {
    try {
      const result = await handleToolExecution(toolName, params)
      return { success: result.success, output: result.output, error: result.success ? undefined : result.output }
    } catch (err: any) {
      return { success: false, output: '', error: err.message || 'MD tool execution failed' }
    }
  }
)

ipcMain.handle(
  'hwpx-tool',
  async (_event, toolName: string, params: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }> => {
    try {
      const result = await handleToolExecution(toolName, params)
      return { success: result.success, output: result.output, error: result.success ? undefined : result.output }
    } catch (err: any) {
      return { success: false, output: '', error: err.message || 'HWPX tool execution failed' }
    }
  }
)

// SSE notification stream control
ipcMain.handle('start-notification-stream', async (_event, platformUrl: string) => {
  startNotificationStream(platformUrl)
  return { success: true }
})

ipcMain.handle('stop-notification-stream', async () => {
  stopNotificationStream()
  return { success: true }
})

ipcMain.handle('get-notification-info', async () => {
  return {
    supported: Notification.isSupported(),
    platform: process.platform,
  }
})

ipcMain.handle('open-notification-settings', async () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings')
  } else if (process.platform === 'win32') {
    shell.openExternal('ms-settings:notifications')
  }
  return { success: true }
})

ipcMain.handle('send-test-notification', async () => {
  if (!Notification.isSupported()) {
    return { success: false, error: 'Notifications not supported' }
  }
  const n = new Notification({
    title: 'Heureum',
    body: 'Notifications are working!',
  })
  n.show()
  return { success: true }
})

// --- Session file sync ---

interface SyncedFile {
  id: string
  path: string
  updated_at: string
}

const activeWatchers = new Map<string, ReturnType<typeof watch>>()
const watcherDebounce = new Map<string, ReturnType<typeof setTimeout>>()

function sanitizeTitle(title: string): string {
  return title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 100) || 'Untitled'
}

function sessionLocalDir(sessionTitle: string): string {
  const docsDir = app.getPath('documents')
  return join(docsDir, 'Heureum', sanitizeTitle(sessionTitle))
}

async function getCookieHeader(apiBaseUrl: string): Promise<string> {
  const cookies = await session.defaultSession.cookies.get({ url: apiBaseUrl })
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

function httpGet(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const mod = url.startsWith('https') ? https : http
  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    mod.get({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, headers).then(resolve, reject)
        return
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function syncSessionFiles(
  sessionId: string,
  sessionTitle: string,
  apiBaseUrl: string
): Promise<void> {
  const localDir = sessionLocalDir(sessionTitle)
  mkdirSync(localDir, { recursive: true })

  const cookieHeader = await getCookieHeader(apiBaseUrl)
  const headers: Record<string, string> = cookieHeader ? { Cookie: cookieHeader } : {}

  // Fetch file list from platform API
  const listUrl = `${apiBaseUrl}/api/v1/sessions/${sessionId}/files/`
  const listBuf = await httpGet(listUrl, headers)
  const files: SyncedFile[] = JSON.parse(listBuf.toString())

  for (const file of files) {
    const localPath = join(localDir, file.path)
    const localFileDir = dirname(localPath)
    mkdirSync(localFileDir, { recursive: true })

    // Skip if local file is newer or same
    if (existsSync(localPath)) {
      const localMtime = statSync(localPath).mtime
      const remoteMtime = new Date(file.updated_at)
      if (localMtime >= remoteMtime) continue
    }

    // Download file
    const downloadUrl = `${apiBaseUrl}/api/v1/sessions/${sessionId}/files/${file.id}/download/`
    const data = await httpGet(downloadUrl, headers)
    const ws = createWriteStream(localPath)
    ws.write(data)
    ws.end()
  }
}

async function startFileWatcher(
  sessionId: string,
  sessionTitle: string,
  apiBaseUrl: string
): Promise<void> {
  stopFileWatcher(sessionId)
  const localDir = sessionLocalDir(sessionTitle)
  mkdirSync(localDir, { recursive: true })

  const cookieHeader = await getCookieHeader(apiBaseUrl)

  const watcher = watch(localDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return

    // Debounce rapid events (e.g. editor save)
    const key = `${sessionId}:${filename}`
    const existing = watcherDebounce.get(key)
    if (existing) clearTimeout(existing)

    watcherDebounce.set(key, setTimeout(() => {
      watcherDebounce.delete(key)
      const fullPath = join(localDir, filename)

      const reqHeaders: Record<string, string | number> = {}
      if (cookieHeader) reqHeaders['Cookie'] = cookieHeader

      if (!existsSync(fullPath)) {
        // File deleted locally — delete on server
        const deleteUrl = `${apiBaseUrl}/api/v1/sessions/${sessionId}/files/delete-by-path/?path=${encodeURIComponent(filename)}`
        const delMod = deleteUrl.startsWith('https') ? https : http
        const delParsed = new URL(deleteUrl)
        const delReq = delMod.request({ hostname: delParsed.hostname, port: delParsed.port, path: delParsed.pathname + delParsed.search, method: 'DELETE', headers: reqHeaders }, () => {})
        delReq.on('error', () => {})
        delReq.end()
        return
      }

      // File created/modified — upload to server via multipart POST
      try {
        const content = readFileSync(fullPath)
        const boundary = '----HeureumSync' + randomUUID().replace(/-/g, '')
        const fname = filename.split('/').pop() || filename
        const parts: Buffer[] = []

        // path field
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${filename}\r\n`))
        // file field
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: application/octet-stream\r\n\r\n`))
        parts.push(content)
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

        const body = Buffer.concat(parts)
        const uploadUrl = `${apiBaseUrl}/api/v1/sessions/${sessionId}/files/`
        const parsedUrl = new URL(uploadUrl)
        const httpMod = uploadUrl.startsWith('https') ? https : http
        const uploadReq = httpMod.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname,
          method: 'POST',
          headers: {
            ...reqHeaders,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          }
        }, () => {})
        uploadReq.on('error', () => {})
        uploadReq.write(body)
        uploadReq.end()
      } catch {
        // Ignore read errors (e.g. temp files)
      }
    }, 500))
  })

  activeWatchers.set(sessionId, watcher)
}

function stopFileWatcher(sessionId: string): void {
  const watcher = activeWatchers.get(sessionId)
  if (watcher) {
    watcher.close()
    activeWatchers.delete(sessionId)
  }
  // Clear any pending debounce timers for this session
  for (const [key, timer] of watcherDebounce) {
    if (key.startsWith(`${sessionId}:`)) {
      clearTimeout(timer)
      watcherDebounce.delete(key)
    }
  }
}

ipcMain.handle('open-session-folder', async (_event, _sessionId: string, sessionTitle: string) => {
  const localDir = sessionLocalDir(sessionTitle)
  mkdirSync(localDir, { recursive: true })
  shell.openPath(localDir)
})

ipcMain.handle('sync-session-files', async (_event, sessionId: string, sessionTitle: string, apiBaseUrl: string) => {
  try {
    await syncSessionFiles(sessionId, sessionTitle, apiBaseUrl)
    return { success: true }
  } catch (err: any) {
    console.error('[Heureum] File sync error:', err.message)
    return { success: false, error: err.message }
  }
})

ipcMain.handle('start-file-watcher', async (_event, sessionId: string, sessionTitle: string, apiBaseUrl: string) => {
  startFileWatcher(sessionId, sessionTitle, apiBaseUrl)
  return { success: true }
})

ipcMain.handle('stop-file-watcher', async (_event, sessionId: string) => {
  stopFileWatcher(sessionId)
  return { success: true }
})

// --- Auto-updater ---

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('[Heureum] Checking for updates...')
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[Heureum] Update available: ${info.version}`)
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `A new version (${info.version}) is available. Would you like to download it?`,
        buttons: ['Download', 'Later']
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate()
        }
      })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[Heureum] No updates available.')
  })

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Heureum] Download progress: ${Math.round(progress.percent)}%`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Heureum] Update downloaded: ${info.version}`)
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: `Version ${info.version} has been downloaded. Restart now to apply the update?`,
        buttons: ['Restart', 'Later']
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall()
        }
      })
  })

  autoUpdater.on('error', (err) => {
    console.error('[Heureum] Auto-updater error:', err.message)
  })
}

// --- App lifecycle ---

// Windows/Linux: single instance lock + deep link via second-instance event
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    const url = commandLine.find((arg) => arg.startsWith(`${PROTOCOL}://`))
    if (url) {
      handleDeepLink(url)
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.heureum.client')
    }

    // Write SKILL.md files for lazy-read skill catalog
    writeSkillFiles().catch((err) => console.warn('Failed to write skill files:', err))

    startWebSocketServer()
    createWindow()

    // Auto-update only in production (skip when pointing to localhost)
    const frontendUrl = getFrontendUrl()
    if (!frontendUrl.includes('localhost')) {
      setupAutoUpdater()
      setTimeout(() => {
        autoUpdater.checkForUpdates()
      }, 3000)
    }

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  // Clean up notification stream
  stopNotificationStream()
  // Clean up file watchers
  for (const [sessionId] of activeWatchers) {
    stopFileWatcher(sessionId)
  }
  // Clean up ping interval and WebSocket server
  stopPingInterval()
  if (wss) {
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer)
      pending.reject('App closing')
      pendingCommands.delete(id)
    }
    wss.close()
    wss = null
    extensionSocket = null
  }
})
