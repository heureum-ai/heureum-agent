export interface TaskContext {
  sessionId: string;
  taskType: string;
  taskId: string;
  workDir?: string;
}

export interface PdfToolResult {
  success: boolean;
  output: string;
  statusCode: number | null;
}

export interface PdfHandlerResult {
  success: boolean;
  output: string;
}
