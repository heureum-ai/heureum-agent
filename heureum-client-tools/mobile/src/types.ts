export interface ToolDefinition {
  type: 'function'
  name: string
  display_name: string
  description?: string
  parameters?: Record<string, unknown>
  guide?: string
}

