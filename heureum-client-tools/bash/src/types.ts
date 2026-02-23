export interface TextContent {
	type: "text";
	text: string;
}

export type ToolContent = TextContent;

export interface ToolExecuteResult {
	content: ToolContent[];
	details?: any;
}

export interface BashTool {
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
	images?: Array<{ data: string; mimeType: string }>;
}
