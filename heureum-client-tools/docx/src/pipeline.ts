/**
 * DocxPipeline — bidirectional file-system-persisted pipeline.
 * Each step reads from / writes to a well-known folder structure:
 *   {workDir}/{sessionId}/{taskType}/{taskId}/steps/0N_step/
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';
import { buildDocumentXml } from './document.js';
import { buildStylesXml } from './styles.js';
import { buildNumberingXml } from './numbering.js';
import { DOCX_DEFAULTS } from './configs.js';
import {
  buildContentTypes,
  ROOT_RELS,
  buildDocumentRels,
  SETTINGS_XML,
  buildFontTable,
  buildCoreXml,
  APP_XML,
} from './template.js';
import { parseDocumentXml, parseCoreXml } from './reader.js';
import type {
  TaskContext,
  DocxXmlMap,
  DocxMetadata,
  PipelineStepOptions,
} from './types.js';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Remark AST root node */
interface Root {
  type: 'root';
  children: any[];
  [key: string]: unknown;
}

// ── workDir resolution ──────────────────────────────────

export function resolveWorkDir(workDir?: string): string {
  if (workDir) return workDir;
  const home = os.homedir();
  const cacheParent = path.join(home, '.cache');
  if (fs.existsSync(cacheParent)) {
    return path.join(cacheParent, DOCX_DEFAULTS.runtime.cacheDirName);
  }
  return path.join(os.tmpdir(), DOCX_DEFAULTS.runtime.cacheDirName);
}

// ── step directory names ────────────────────────────────

const STEP_SOURCE = 'steps/01_source';
const STEP_PARSED = 'steps/02_parsed';
const STEP_INTERMEDIATE = 'steps/03_intermediate';
const STEP_OUTPUT = 'steps/04_output';

// ── DocxPipeline ────────────────────────────────────────

export class DocxPipeline {
  private readonly _taskDir: string;

  constructor(ctx: TaskContext) {
    const base = resolveWorkDir(ctx.workDir);
    this._taskDir = path.join(base, ctx.sessionId, ctx.taskType, ctx.taskId);
  }

  /** Absolute path of the task folder */
  get taskDir(): string {
    return this._taskDir;
  }

  /** Ensure a sub-directory exists under taskDir */
  private ensureDir(rel: string): string {
    const dir = path.join(this._taskDir, rel);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ── Forward (write) ─────────────────────────────────

  /**
   * Step 1-2: Save markdown → 01_source/input.md,
   *           Parse → AST → 02_parsed/ast.json
   */
  async writeMarkdown(markdown: string): Promise<Root> {
    const sourceDir = this.ensureDir(STEP_SOURCE);
    await fs.promises.writeFile(path.join(sourceDir, 'input.md'), markdown, 'utf-8');

    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml']);
    const tree = processor.parse(markdown) as Root;

    const parsedDir = this.ensureDir(STEP_PARSED);
    await fs.promises.writeFile(
      path.join(parsedDir, 'ast.json'),
      JSON.stringify(tree, null, 2),
      'utf-8',
    );

    return tree;
  }

  /**
   * Step 3: AST → XML files → 03_intermediate/docx/
   */
  async writeXml(ast: Root, opts?: PipelineStepOptions): Promise<DocxXmlMap> {
    const docxDir = this.ensureDir(`${STEP_INTERMEDIATE}/docx`);
    const docOpts = opts?.documentOptions;

    // Extract title
    let title: string | undefined;
    for (const node of (ast.children as any[])) {
      if (node.type === 'heading' && node.depth === 1) {
        title = node.children?.map((c: any) => c.value || '').join('') || undefined;
        break;
      }
    }

    const documentXml = buildDocumentXml(ast.children as any[], docOpts);
    const stylesXml = buildStylesXml();
    const numberingXml = buildNumberingXml();
    const contentTypes = buildContentTypes();
    const documentRels = buildDocumentRels();
    const fontTable = buildFontTable();
    const coreXml = buildCoreXml({ title });

    // Write file structure
    await fs.promises.writeFile(path.join(docxDir, '[Content_Types].xml'), contentTypes, 'utf-8');

    const relsDir = path.join(docxDir, '_rels');
    await fs.promises.mkdir(relsDir, { recursive: true });
    await fs.promises.writeFile(path.join(relsDir, '.rels'), ROOT_RELS, 'utf-8');

    const wordDir = path.join(docxDir, 'word');
    await fs.promises.mkdir(wordDir, { recursive: true });
    await fs.promises.writeFile(path.join(wordDir, 'document.xml'), documentXml, 'utf-8');
    await fs.promises.writeFile(path.join(wordDir, 'styles.xml'), stylesXml, 'utf-8');
    await fs.promises.writeFile(path.join(wordDir, 'settings.xml'), SETTINGS_XML, 'utf-8');
    await fs.promises.writeFile(path.join(wordDir, 'numbering.xml'), numberingXml, 'utf-8');
    await fs.promises.writeFile(path.join(wordDir, 'fontTable.xml'), fontTable, 'utf-8');

    const wordRelsDir = path.join(wordDir, '_rels');
    await fs.promises.mkdir(wordRelsDir, { recursive: true });
    await fs.promises.writeFile(path.join(wordRelsDir, 'document.xml.rels'), documentRels, 'utf-8');

    const docPropsDir = path.join(docxDir, 'docProps');
    await fs.promises.mkdir(docPropsDir, { recursive: true });
    await fs.promises.writeFile(path.join(docPropsDir, 'core.xml'), coreXml, 'utf-8');
    await fs.promises.writeFile(path.join(docPropsDir, 'app.xml'), APP_XML, 'utf-8');

    const xmlMap: DocxXmlMap = {
      document: documentXml,
      styles: stylesXml,
      numbering: numberingXml,
      meta: {
        '[Content_Types].xml': contentTypes,
        '_rels/.rels': ROOT_RELS,
        'word/_rels/document.xml.rels': documentRels,
        'word/settings.xml': SETTINGS_XML,
        'word/fontTable.xml': fontTable,
        'docProps/core.xml': coreXml,
        'docProps/app.xml': APP_XML,
      },
    };

    return xmlMap;
  }

  /**
   * Step 4: 03_intermediate/docx/ → ZIP → 04_output/result.docx
   */
  async pack(): Promise<string> {
    const docxDir = path.join(this._taskDir, STEP_INTERMEDIATE, 'docx');
    if (!(await pathExists(docxDir))) {
      throw new Error(`Intermediate DOCX folder not found: ${docxDir}`);
    }

    const zip = new JSZip();

    const addDir = async (dirPath: string, zipPath: string): Promise<void> => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await addDir(fullPath, entryZipPath);
        } else {
          zip.file(entryZipPath, await fs.promises.readFile(fullPath));
        }
      }
    };

    await addDir(docxDir, '');

    const buffer = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const outputDir = this.ensureDir(STEP_OUTPUT);
    const outputPath = path.join(outputDir, 'result.docx');
    await fs.promises.writeFile(outputPath, buffer);

    return outputPath;
  }

  /**
   * Full forward pipeline: markdown → result.docx path
   */
  async fromMarkdown(md: string, opts?: PipelineStepOptions): Promise<string> {
    const ast = await this.writeMarkdown(md);
    await this.writeXml(ast, opts);
    return this.pack();
  }

  // ── Reverse (read) ──────────────────────────────────

  /**
   * Unpack .docx → 03_intermediate/docx/
   */
  async unpack(docxPath: string): Promise<void> {
    const resolved = path.resolve(docxPath);
    const data = await fs.promises.readFile(resolved);
    const zip = await JSZip.loadAsync(data);

    const docxDir = this.ensureDir(`${STEP_INTERMEDIATE}/docx`);

    for (const [relativePath, file] of Object.entries(zip.files)) {
      if (file.dir) {
        await fs.promises.mkdir(path.join(docxDir, relativePath), { recursive: true });
        continue;
      }
      const filePath = path.join(docxDir, relativePath);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      const content = await file.async('uint8array');
      await fs.promises.writeFile(filePath, content);
    }
  }

  /**
   * 03_intermediate/docx/ XML → AST → 02_parsed/ast.json
   */
  async readXml(): Promise<Root> {
    const docxDir = path.join(this._taskDir, STEP_INTERMEDIATE, 'docx');
    const documentPath = path.join(docxDir, 'word', 'document.xml');
    const stylesPath = path.join(docxDir, 'word', 'styles.xml');
    const numberingPath = path.join(docxDir, 'word', 'numbering.xml');

    if (!(await pathExists(documentPath))) {
      throw new Error(`document.xml not found: ${documentPath}`);
    }

    const documentXml = await fs.promises.readFile(documentPath, 'utf-8');
    const stylesXml = (await pathExists(stylesPath))
      ? await fs.promises.readFile(stylesPath, 'utf-8')
      : undefined;
    const numberingXml = (await pathExists(numberingPath))
      ? await fs.promises.readFile(numberingPath, 'utf-8')
      : undefined;

    const children = parseDocumentXml(documentXml, stylesXml, numberingXml);
    const tree: Root = { type: 'root', children: children as any[] };

    const parsedDir = this.ensureDir(STEP_PARSED);
    await fs.promises.writeFile(
      path.join(parsedDir, 'ast.json'),
      JSON.stringify(tree, null, 2),
      'utf-8',
    );

    return tree;
  }

  /**
   * AST → markdown → 01_source/input.md
   */
  async readMarkdown(ast: Root): Promise<string> {
    const processor = unified()
      .use(remarkStringify)
      .use(remarkGfm);

    const markdown = processor.stringify(ast);

    const sourceDir = this.ensureDir(STEP_SOURCE);
    await fs.promises.writeFile(path.join(sourceDir, 'input.md'), markdown, 'utf-8');

    return markdown;
  }

  /**
   * Full reverse pipeline: .docx → markdown string
   */
  async toMarkdown(docxPath: string): Promise<string> {
    await this.unpack(docxPath);
    const ast = await this.readXml();
    return this.readMarkdown(ast);
  }

  /**
   * Extract metadata from .docx file
   */
  async extractMetadata(docxPath: string): Promise<DocxMetadata> {
    const resolved = path.resolve(docxPath);
    const data = await fs.promises.readFile(resolved);
    const zip = await JSZip.loadAsync(data);

    const coreFile = zip.file('docProps/core.xml');
    if (!coreFile) {
      throw new Error('core.xml not found in DOCX archive');
    }

    const coreXml = await coreFile.async('string');
    return parseCoreXml(coreXml);
  }

  // ── Meta utility ────────────────────────────────────

  async getMeta(): Promise<Record<string, unknown>> {
    const metaPath = path.join(this._taskDir, 'meta.json');
    if (!(await pathExists(metaPath))) return {};
    const raw = await fs.promises.readFile(metaPath, 'utf-8');
    return JSON.parse(raw);
  }

  async setMeta(data: Record<string, unknown>): Promise<void> {
    await fs.promises.mkdir(this._taskDir, { recursive: true });
    const metaPath = path.join(this._taskDir, 'meta.json');
    let existing: Record<string, unknown> = {};
    if (await pathExists(metaPath)) {
      existing = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
    }
    const merged = { ...existing, ...data };
    await fs.promises.writeFile(metaPath, JSON.stringify(merged, null, 2), 'utf-8');
  }
}
