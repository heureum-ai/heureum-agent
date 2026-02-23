export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type ToolContent = TextContent | ImageContent;

export interface ToolExecuteResult {
	content: ToolContent[];
	details?: any;
}

export interface CodingTool {
	name: string;
	label: string;
	description: string;
	execute: (
		toolCallId: string,
		args: any,
		signal?: AbortSignal,
		onUpdate?: (partial: ToolExecuteResult) => void,
	) => Promise<ToolExecuteResult>;
}

export interface ToolResult {
	success: boolean;
	output: string;
	outputPath?: string;
	/** Image attachments (for image file reads) */
	images?: Array<{ data: string; mimeType: string }>;
}

export interface TaskContext {
	sessionId: string;
	taskType: string;
	taskId: string;
	workDir?: string;
}

export type CodingToolResult = ToolResult;
