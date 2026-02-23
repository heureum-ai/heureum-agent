export interface ExtractedStyles {
  fonts?: any[];
  charProperties?: any[];
  paraProperties?: any[];
  borderFills?: any[];
  styles?: any[];
  effectiveStyles?: any[];
  pageLayout?: any;
  headerFooter?: any;
  metadata?: Record<string, any>;
  usage?: Record<string, any>;
  sections?: any[];
  sectionCount?: number;
  markdownContent?: string;
  markdownSource?: string;
  sourcePath?: string;
  [key: string]: any;
}

export interface HwpxDocumentOptions {
  /** Page width in HWPUNIT (default from HWPX_PAGE_SIZES.a4.width) */
  pageWidth?: number;
  /** Page height in HWPUNIT (default from HWPX_PAGE_SIZES.a4.height) */
  pageHeight?: number;
  /** Top margin in HWPUNIT (default from HWPX_DEFAULTS.page.marginTop) */
  marginTop?: number;
  /** Bottom margin in HWPUNIT (default from HWPX_DEFAULTS.page.marginBottom) */
  marginBottom?: number;
  /** Left margin in HWPUNIT (default from HWPX_DEFAULTS.page.marginLeft) */
  marginLeft?: number;
  /** Right margin in HWPUNIT (default from HWPX_DEFAULTS.page.marginRight) */
  marginRight?: number;
  /** Extracted style metadata to inject for rendering */
  styles?: ExtractedStyles;
}

export interface HwpxToolResult {
  success: boolean;
  output: string;
  outputPath?: string;
}

/** Generic task identification context — same convention across packages */
export interface TaskContext {
  sessionId: string;
  taskType: string;   // "hwpx", "xlsx", "docx", "pdf", etc.
  taskId: string;
  workDir?: string;   // defaults resolved at runtime
}

export interface HwpxXmlMap {
  header: string;
  sections: string[];
  contentHpf: string;
  meta: Record<string, string>;
}

export interface HwpxMetadata {
  title?: string;
  language?: string;
  creator?: string;
  sectionCount: number;
}

export interface PipelineStepOptions {
  documentOptions?: HwpxDocumentOptions;
}
