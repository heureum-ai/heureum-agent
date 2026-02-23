export interface TaskContext {
  sessionId: string;
  taskType: string;
  taskId: string;
  workDir?: string;
}

export interface PptToolResult {
  success: boolean;
  output: string;
  outputPath?: string;
}

export type ToolResult = PptToolResult;
