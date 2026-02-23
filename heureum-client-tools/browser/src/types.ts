export interface BrowserToolResult {
  success: boolean
  output: string
  /** Base64-encoded image data for screenshot results */
  image?: { data: string; mimeType: string }
}

export interface BrowserCommandPayload {
  action: string
  params: Record<string, unknown>
}

export interface ToolMeta {
  /** Tool returns a point-in-time snapshot subject to stale invalidation */
  snapshot?: boolean
  /** Tool performs a state-changing action */
  mutating?: boolean
  /** Tool is purely observational */
  read_only?: boolean
  /** Tool is a polling/wait tool (loop detection) */
  poll?: boolean
}

export interface BrowserToolDefinition {
  type: 'function'
  name: string
  display_name: string
  description?: string
  parameters?: Record<string, unknown>
  guide?: string
  tool_meta?: ToolMeta
}
