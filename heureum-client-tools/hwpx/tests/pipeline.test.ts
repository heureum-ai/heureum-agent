import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HwpxPipeline, resolveWorkDir } from '../src/pipeline.js';
import type { TaskContext } from '../src/types.js';

const TEST_WORK_DIR = path.join(os.tmpdir(), 'heureum-hwpx-test-' + Date.now());

function makeCtx(overrides?: Partial<TaskContext>): TaskContext {
  return {
    sessionId: 'test-session',
    taskType: 'hwpx',
    taskId: 'test-task-' + Math.random().toString(36).slice(2, 8),
    workDir: TEST_WORK_DIR,
    ...overrides,
  };
}

const SAMPLE_MD = `# Test Document

This is a **bold** and *italic* paragraph.

## Section Two

- bullet one
- bullet two

1. first
2. second

> This is a quote

\`\`\`
const x = 1;
\`\`\`

---

| Col A | Col B |
|-------|-------|
| a1    | b1    |
| a2    | b2    |
`;

describe('HwpxPipeline', () => {
  afterEach(() => {
    // Cleanup test directory
    if (fs.existsSync(TEST_WORK_DIR)) {
      fs.rmSync(TEST_WORK_DIR, { recursive: true, force: true });
    }
  });

  // ── Test 1: fromMarkdown() full forward ───────────────

  it('fromMarkdown creates all step artifacts', async () => {
    const ctx = makeCtx();
    const pipeline = new HwpxPipeline(ctx);
    const resultPath = await pipeline.fromMarkdown(SAMPLE_MD);

    // 01_source/input.md
    const sourceFile = path.join(pipeline.taskDir, 'output/input.md');
    expect(fs.existsSync(sourceFile)).toBe(true);
    expect(fs.readFileSync(sourceFile, 'utf-8')).toBe(SAMPLE_MD);

    // 02_parsed/ast.json
    const astFile = path.join(pipeline.taskDir, 'output/ast.json');
    expect(fs.existsSync(astFile)).toBe(true);
    const ast = JSON.parse(fs.readFileSync(astFile, 'utf-8'));
    expect(ast.type).toBe('root');
    expect(ast.children.length).toBeGreaterThan(0);

    // 03_intermediate/hwpx/Contents/section0.xml
    const sectionFile = path.join(pipeline.taskDir, 'output/hwpx/Contents/section0.xml');
    expect(fs.existsSync(sectionFile)).toBe(true);

    // 03_intermediate/hwpx/Contents/header.xml
    const headerFile = path.join(pipeline.taskDir, 'output/hwpx/Contents/header.xml');
    expect(fs.existsSync(headerFile)).toBe(true);

    // 03_intermediate/hwpx/Contents/content.hpf
    const hpfFile = path.join(pipeline.taskDir, 'output/hwpx/Contents/content.hpf');
    expect(fs.existsSync(hpfFile)).toBe(true);

    // 03_intermediate/hwpx/mimetype
    const mimetypeFile = path.join(pipeline.taskDir, 'output/hwpx/mimetype');
    expect(fs.existsSync(mimetypeFile)).toBe(true);

    // 04_output/result.hwpx
    expect(fs.existsSync(resultPath)).toBe(true);
    expect(resultPath).toContain('result.hwpx');

    // Result should be a valid ZIP (starts with PK)
    const zipData = fs.readFileSync(resultPath);
    expect(zipData[0]).toBe(0x50); // P
    expect(zipData[1]).toBe(0x4B); // K
  }, 30000);

  // ── Test 2: toMarkdown() reverse ──────────────────────

  it('toMarkdown extracts readable markdown from hwpx', async () => {
    const ctx1 = makeCtx();
    const pipeline1 = new HwpxPipeline(ctx1);
    const hwpxPath = await pipeline1.fromMarkdown(SAMPLE_MD);

    const ctx2 = makeCtx({ taskId: 'reverse-task' });
    const pipeline2 = new HwpxPipeline(ctx2);
    const md = await pipeline2.toMarkdown(hwpxPath);

    // Should contain key content
    expect(md).toContain('Test Document');
    expect(md).toContain('bold');
    expect(md).toContain('italic');
    expect(md).toContain('Section Two');
    expect(md).toContain('bullet');
    expect(md).toContain('quote');
  }, 30000);

  // ── Test 3: roundtrip ─────────────────────────────────

  it('fromMarkdown → toMarkdown roundtrip preserves content', async () => {
    const simpleMd = '# Hello World\n\nThis is a simple document.\n';
    const ctx1 = makeCtx();
    const pipeline1 = new HwpxPipeline(ctx1);
    const hwpxPath = await pipeline1.fromMarkdown(simpleMd);

    const ctx2 = makeCtx({ taskId: 'roundtrip-task' });
    const pipeline2 = new HwpxPipeline(ctx2);
    const result = await pipeline2.toMarkdown(hwpxPath);

    expect(result).toContain('Hello World');
    expect(result).toContain('simple document');
  }, 30000);

  // ── Test 4: individual step calls ─────────────────────

  it('writeMarkdown → writeXml → pack individual steps', async () => {
    const ctx = makeCtx();
    const pipeline = new HwpxPipeline(ctx);

    const ast = await pipeline.writeMarkdown('# Step Test\n\nParagraph here.\n');
    expect(ast.type).toBe('root');

    const xmlMap = await pipeline.writeXml(ast);
    expect(xmlMap.header).toContain('hh:head');
    expect(xmlMap.sections).toHaveLength(1);
    expect(xmlMap.sections[0]).toContain('hs:sec');

    const outputPath = await pipeline.pack();
    expect(fs.existsSync(outputPath)).toBe(true);
  }, 30000);

  // ── Test 5: metadata extraction ───────────────────────

  it('extractMetadata returns title and sectionCount', async () => {
    const ctx = makeCtx();
    const pipeline = new HwpxPipeline(ctx);
    const hwpxPath = await pipeline.fromMarkdown('# My Title\n\nContent.\n');

    const meta = await pipeline.extractMetadata(hwpxPath);
    expect(meta.title).toBe('My Title');
    expect(meta.sectionCount).toBe(1);
    expect(meta.language).toBe('ko');
    expect(meta.creator).toBe('heureum');
  }, 30000);

  // ── Test 6: workDir default logic ─────────────────────

  it('resolveWorkDir uses provided workDir', () => {
    const result = resolveWorkDir('/custom/path');
    expect(result).toBe('/custom/path');
  });

  it('resolveWorkDir falls back to cache or tmp', () => {
    const result = resolveWorkDir();
    // Should be either ~/.cache/heureum-hwpx or /tmp/heureum-hwpx
    expect(result).toContain('heureum-hwpx');
  });

  // ── Test 7: meta.json read/write ──────────────────────

  it('getMeta/setMeta round-trips', async () => {
    const ctx = makeCtx();
    const pipeline = new HwpxPipeline(ctx);

    await pipeline.setMeta({ foo: 'bar', count: 42 });
    const meta = await pipeline.getMeta();
    expect(meta.foo).toBe('bar');
    expect(meta.count).toBe(42);

    // Merge additional data
    await pipeline.setMeta({ extra: true });
    const meta2 = await pipeline.getMeta();
    expect(meta2.foo).toBe('bar');
    expect(meta2.extra).toBe(true);
  });

  // ── Test: taskDir path structure ──────────────────────

  it('taskDir follows convention: workDir/sessionId/taskType/taskId', () => {
    const ctx = makeCtx({
      sessionId: 's1',
      taskType: 'hwpx',
      taskId: 't1',
    });
    const pipeline = new HwpxPipeline(ctx);
    expect(pipeline.taskDir).toBe(path.join(TEST_WORK_DIR, 's1', 'hwpx', 't1'));
  });

  // ── Test: unpack + readXml + readMarkdown individual ──

  it('unpack → readXml → readMarkdown individual reverse steps', async () => {
    // First create a hwpx file
    const ctx1 = makeCtx();
    const pipeline1 = new HwpxPipeline(ctx1);
    const hwpxPath = await pipeline1.fromMarkdown('# Reverse\n\nStep by step.\n');

    // Now reverse it step by step
    const ctx2 = makeCtx({ taskId: 'reverse-steps' });
    const pipeline2 = new HwpxPipeline(ctx2);

    await pipeline2.unpack(hwpxPath);
    const hwpxDir = path.join(pipeline2.taskDir, 'output/hwpx');
    expect(fs.existsSync(path.join(hwpxDir, 'Contents/section0.xml'))).toBe(true);

    const ast = await pipeline2.readXml();
    expect(ast.type).toBe('root');
    expect(ast.children.length).toBeGreaterThan(0);

    const md = await pipeline2.readMarkdown(ast);
    expect(md).toContain('Reverse');
    expect(md).toContain('Step by step');
  }, 30000);
});
