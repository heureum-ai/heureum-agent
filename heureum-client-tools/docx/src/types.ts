export interface ExtractedStyles {
  fonts?: any[];
  charProperties?: any[];
  paraProperties?: any[];
  styles?: any[];
  effectiveStyles?: any[];
  pageLayout?: any;
  headerFooter?: any;
  metadata?: Record<string, any>;
  usage?: Record<string, any>;
  numbering?: any[];
  markdownContent?: string;
  markdownSource?: string;
  sourcePath?: string;
  [key: string]: any;
}

export interface DocxDocumentOptions {
  /** Document title (used in core.xml metadata) */
  title?: string;
  /** Default font name (e.g. 'Malgun Gothic') */
  fontName?: string;
  /** Default font size in points (e.g. 11) */
  fontSizePt?: number;
  /** Page width in twips */
  pageWidth?: number;
  /** Page height in twips */
  pageHeight?: number;
  /** Top margin in twips */
  marginTop?: number;
  /** Bottom margin in twips */
  marginBottom?: number;
  /** Left margin in twips */
  marginLeft?: number;
  /** Right margin in twips */
  marginRight?: number;
  /** Extracted style metadata to inject for rendering */
  styles?: ExtractedStyles;
}

export interface DocxToolResult {
  success: boolean;
  output: string;
  outputPath?: string;
}

/** Generic task identification context — same convention across packages */
export interface TaskContext {
  sessionId: string;
  taskType: string;
  taskId: string;
  workDir?: string;
}

export interface DocxXmlMap {
  document: string;
  styles: string;
  numbering: string;
  meta: Record<string, string>;
}

export interface DocxMetadata {
  title?: string;
  creator?: string;
  lastModifiedBy?: string;
  description?: string;
}

export interface PipelineStepOptions {
  documentOptions?: DocxDocumentOptions;
}
