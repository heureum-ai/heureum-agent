import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { DocxPipeline } from '../src/pipeline.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docx-pipeline-test-'));
}

describe('DocxPipeline', () => {
  it('should forward pipeline: markdown → AST → XML → DOCX', async () => {
    const workDir = makeTmpDir();
    const pipeline = new DocxPipeline({
      sessionId: 'test-session',
      taskType: 'docx',
      taskId: 'test-task',
      workDir,
    });

    const markdown = '# Hello World\n\nThis is a test paragraph.\n\n- Item 1\n- Item 2';
    const outputPath = await pipeline.fromMarkdown(markdown);

    expect(fs.existsSync(outputPath)).toBe(true);

    const data = fs.readFileSync(outputPath);
    const zip = await JSZip.loadAsync(data);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('Hello World');
    expect(docXml).toContain('This is a test paragraph');
  });

  it('should reverse pipeline: DOCX → XML → AST → markdown', async () => {
    const workDir = makeTmpDir();
    const pipeline = new DocxPipeline({
      sessionId: 'test-session',
      taskType: 'docx',
      taskId: 'forward',
      workDir,
    });

    const originalMd = '# Title\n\nParagraph content here.\n\n- Bullet A\n- Bullet B';
    const docxPath = await pipeline.fromMarkdown(originalMd);

    const reversePipeline = new DocxPipeline({
      sessionId: 'test-session',
      taskType: 'docx',
      taskId: 'reverse',
      workDir,
    });

    const roundTrippedMd = await reversePipeline.toMarkdown(docxPath);

    expect(roundTrippedMd).toContain('Title');
    expect(roundTrippedMd).toContain('Paragraph content here');
    expect(roundTrippedMd).toContain('Bullet A');
    expect(roundTrippedMd).toContain('Bullet B');
  });

  it('should step-by-step forward pipeline', async () => {
    const workDir = makeTmpDir();
    const pipeline = new DocxPipeline({
      sessionId: 's',
      taskType: 'docx',
      taskId: 't',
      workDir,
    });

    const markdown = '## Section\n\nBody text.';
    const ast = await pipeline.writeMarkdown(markdown);
    expect(ast.type).toBe('root');
    expect(ast.children.length).toBeGreaterThan(0);

    const xmlMap = await pipeline.writeXml(ast);
    expect(xmlMap.document).toContain('Heading2');

    const outputPath = await pipeline.pack();
    expect(fs.existsSync(outputPath)).toBe(true);
  });

  it('should extract metadata from DOCX', async () => {
    const workDir = makeTmpDir();
    const pipeline = new DocxPipeline({
      sessionId: 's',
      taskType: 'docx',
      taskId: 't',
      workDir,
    });

    const docxPath = await pipeline.fromMarkdown('# My Document\n\nContent');
    const metadata = await pipeline.extractMetadata(docxPath);
    expect(metadata.title).toBe('My Document');
  });

  it('should support meta read/write', async () => {
    const workDir = makeTmpDir();
    const pipeline = new DocxPipeline({
      sessionId: 's',
      taskType: 'docx',
      taskId: 't',
      workDir,
    });

    await pipeline.setMeta({ key: 'value' });
    const meta = await pipeline.getMeta();
    expect(meta.key).toBe('value');
  });
});
