/**
 * HwpxPipeline — bidirectional file-system-persisted pipeline.
 * Each step reads from / writes to a well-known folder structure:
 *   {workDir}/{sessionId}/{taskType}/{taskId}/output/
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
import { buildHeaderXml } from './header.js';
import { buildSectionXml } from './section.js';
import { HWPX_DEFAULTS } from './configs.js';
import {
  MIMETYPE,
  VERSION_XML,
  CONTAINER_XML,
  MANIFEST_XML,
  SETTINGS_XML,
  buildContainerRdf,
  buildContentHpf,
} from './template.js';
import { parseSectionXml, parseContentHpf } from './reader.js';
import type {
  TaskContext,
  HwpxXmlMap,
  HwpxMetadata,
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
    return path.join(cacheParent, HWPX_DEFAULTS.runtime.cacheDirName);
  }
  return path.join(os.tmpdir(), HWPX_DEFAULTS.runtime.cacheDirName);
}

// ── step directory names ────────────────────────────────

const STEP_SOURCE = 'output';
const STEP_PARSED = 'output';
const STEP_INTERMEDIATE = 'output';
const STEP_OUTPUT = 'output';

// ── HwpxPipeline ────────────────────────────────────────

export class HwpxPipeline {
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
   * Step 1-2: Save markdown → output/input.md,
   *           Parse → AST → output/ast.json
   */
  async writeMarkdown(markdown: string): Promise<Root> {
    // output
    const sourceDir = this.ensureDir(STEP_SOURCE);
    ;(await fs.promises.writeFile(path.join(sourceDir, 'input.md'), markdown, 'utf-8'));

    // Parse
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml']);
    const tree = processor.parse(markdown) as Root;

    // output
    const parsedDir = this.ensureDir(STEP_PARSED);
    ;(await fs.promises.writeFile(path.join(parsedDir, 'ast.json'), JSON.stringify(tree, null, 2), 'utf-8'));

    return tree;
  }

  /**
   * Step 3: AST → XML files → output/hwpx/
   */
  async writeXml(ast: Root, opts?: PipelineStepOptions): Promise<HwpxXmlMap> {
    const hwpxDir = this.ensureDir(`${STEP_INTERMEDIATE}/hwpx`);
    const docOpts = opts?.documentOptions;
    const sectionCount = 1;

    // Extract title
    let title: string | undefined;
    for (const node of (ast.children as any[])) {
      if (node.type === 'heading' && node.depth === 1) {
        title = node.children?.map((c: any) => c.value || '').join('') || undefined;
        break;
      }
    }

    const headerXml = buildHeaderXml(sectionCount);
    const sectionXml = buildSectionXml(ast.children as any[], docOpts);
    const contentHpf = buildContentHpf(sectionCount, title);
    const containerRdf = buildContainerRdf(sectionCount);

    // Write file structure
    ;(await fs.promises.writeFile(path.join(hwpxDir, 'mimetype'), MIMETYPE, 'utf-8'));
    ;(await fs.promises.writeFile(path.join(hwpxDir, 'version.xml'), VERSION_XML, 'utf-8'));
    ;(await fs.promises.writeFile(path.join(hwpxDir, 'settings.xml'), SETTINGS_XML, 'utf-8'));

    const metaInfDir = path.join(hwpxDir, 'META-INF');
    ;(await fs.promises.mkdir(metaInfDir, { recursive: true }));
    ;(await fs.promises.writeFile(path.join(metaInfDir, 'container.xml'), CONTAINER_XML, 'utf-8'));
    ;(await fs.promises.writeFile(path.join(metaInfDir, 'manifest.xml'), MANIFEST_XML, 'utf-8'));
    ;(await fs.promises.writeFile(path.join(metaInfDir, 'container.rdf'), containerRdf, 'utf-8'));

    const contentsDir = path.join(hwpxDir, 'Contents');
    ;(await fs.promises.mkdir(contentsDir, { recursive: true }));
    ;(await fs.promises.writeFile(path.join(contentsDir, 'content.hpf'), contentHpf, 'utf-8'));
    ;(await fs.promises.writeFile(path.join(contentsDir, 'header.xml'), headerXml, 'utf-8'));
    ;(await fs.promises.writeFile(path.join(contentsDir, 'section0.xml'), sectionXml, 'utf-8'));

    const previewDir = path.join(hwpxDir, 'Preview');
    ;(await fs.promises.mkdir(previewDir, { recursive: true }));
    ;(await fs.promises.writeFile(path.join(previewDir, 'PrvText.txt'), title || '', 'utf-8'));

    const xmlMap: HwpxXmlMap = {
      header: headerXml,
      sections: [sectionXml],
      contentHpf,
      meta: {
        'META-INF/container.xml': CONTAINER_XML,
        'META-INF/manifest.xml': MANIFEST_XML,
        'META-INF/container.rdf': containerRdf,
        'version.xml': VERSION_XML,
        'settings.xml': SETTINGS_XML,
      },
    };

    return xmlMap;
  }

  /**
   * Step 4: output/hwpx/ → ZIP → output/result.hwpx
   */
  async pack(): Promise<string> {
    const hwpxDir = path.join(this._taskDir, STEP_INTERMEDIATE, 'hwpx');
    if (!(await pathExists(hwpxDir))) {
      throw new Error(`Intermediate HWPX folder not found: ${hwpxDir}`);
    }

    const zip = new JSZip();

    // mimetype MUST be first, stored uncompressed
    const mimetypeContent = (await fs.promises.readFile(path.join(hwpxDir, 'mimetype'), 'utf-8'));
    zip.file('mimetype', mimetypeContent, { compression: 'STORE' });

    // Walk the hwpx directory and add all other files
    const addDir = async (dirPath: string, zipPath: string): Promise<void> => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        if (entry.name === 'mimetype' && zipPath === '') continue; // already added
        if (entry.isDirectory()) {
          await addDir(fullPath, entryZipPath);
        } else {
          zip.file(entryZipPath, await fs.promises.readFile(fullPath));
        }
      }
    };

    await addDir(hwpxDir, '');

    const buffer = await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const outputDir = this.ensureDir(STEP_OUTPUT);
    const outputPath = path.join(outputDir, 'result.hwpx');
    ;(await fs.promises.writeFile(outputPath, buffer));

    return outputPath;
  }

  /**
   * Full forward pipeline: markdown → result.hwpx path
   */
  async fromMarkdown(md: string, opts?: PipelineStepOptions): Promise<string> {
    const ast = await this.writeMarkdown(md);
    await this.writeXml(ast, opts);
    return this.pack();
  }

  // ── Reverse (read) ──────────────────────────────────

  /**
   * Unpack .hwpx → output/hwpx/
   */
  async unpack(hwpxPath: string): Promise<void> {
    const resolved = path.resolve(hwpxPath);
    const data = (await fs.promises.readFile(resolved));
    const zip = await JSZip.loadAsync(data);

    const hwpxDir = this.ensureDir(`${STEP_INTERMEDIATE}/hwpx`);

    for (const [relativePath, file] of Object.entries(zip.files)) {
      if (file.dir) {
        ;(await fs.promises.mkdir(path.join(hwpxDir, relativePath), { recursive: true }));
        continue;
      }
      const filePath = path.join(hwpxDir, relativePath);
      ;(await fs.promises.mkdir(path.dirname(filePath), { recursive: true }));
      const content = await file.async('uint8array');
      ;(await fs.promises.writeFile(filePath, content));
    }
  }

  /**
   * output/hwpx/ XML → AST → output/ast.json
   */
  async readXml(): Promise<Root> {
    const hwpxDir = path.join(this._taskDir, STEP_INTERMEDIATE, 'hwpx');
    const sectionPath = path.join(hwpxDir, 'Contents', 'section0.xml');
    const headerPath = path.join(hwpxDir, 'Contents', 'header.xml');

    if (!(await pathExists(sectionPath))) {
      throw new Error(`Section XML not found: ${sectionPath}`);
    }

    const sectionXml = (await fs.promises.readFile(sectionPath, 'utf-8'));
    const headerXml = (await pathExists(headerPath)) ? (await fs.promises.readFile(headerPath, 'utf-8')) : undefined;
    const children = parseSectionXml(sectionXml, headerXml);

    const tree: Root = { type: 'root', children: children as any[] };

    // Save to output
    const parsedDir = this.ensureDir(STEP_PARSED);
    ;(await fs.promises.writeFile(path.join(parsedDir, 'ast.json'), JSON.stringify(tree, null, 2), 'utf-8'));

    return tree;
  }

  /**
   * AST → markdown → output/input.md
   */
  async readMarkdown(ast: Root): Promise<string> {
    const processor = unified()
      .use(remarkStringify)
      .use(remarkGfm);

    const markdown = processor.stringify(ast);

    // Save to output
    const sourceDir = this.ensureDir(STEP_SOURCE);
    ;(await fs.promises.writeFile(path.join(sourceDir, 'input.md'), markdown, 'utf-8'));

    return markdown;
  }

  /**
   * Full reverse pipeline: .hwpx → markdown string
   */
  async toMarkdown(hwpxPath: string): Promise<string> {
    await this.unpack(hwpxPath);
    const ast = await this.readXml();
    return this.readMarkdown(ast);
  }

  /**
   * Extract metadata from .hwpx file
   */
  async extractMetadata(hwpxPath: string): Promise<HwpxMetadata> {
    const resolved = path.resolve(hwpxPath);
    const data = (await fs.promises.readFile(resolved));
    const zip = await JSZip.loadAsync(data);

    const hpfFile = zip.file('Contents/content.hpf');
    if (!hpfFile) {
      throw new Error('content.hpf not found in HWPX archive');
    }

    const hpfXml = await hpfFile.async('string');
    return parseContentHpf(hpfXml);
  }

  // ── Meta utility ────────────────────────────────────

  /**
   * Read meta.json from task directory
   */
  async getMeta(): Promise<Record<string, unknown>> {
    const metaPath = path.join(this._taskDir, 'meta.json');
    if (!(await pathExists(metaPath))) return {};
    const raw = (await fs.promises.readFile(metaPath, 'utf-8'));
    return JSON.parse(raw);
  }

  /**
   * Write/merge meta.json
   */
  async setMeta(data: Record<string, unknown>): Promise<void> {
    ;(await fs.promises.mkdir(this._taskDir, { recursive: true }));
    const metaPath = path.join(this._taskDir, 'meta.json');
    let existing: Record<string, unknown> = {};
    if ((await pathExists(metaPath))) {
      existing = JSON.parse((await fs.promises.readFile(metaPath, 'utf-8')));
    }
    const merged = { ...existing, ...data };
    ;(await fs.promises.writeFile(metaPath, JSON.stringify(merged, null, 2), 'utf-8'));
  }
}
