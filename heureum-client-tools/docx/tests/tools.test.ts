import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { handleDocxTool, DOCX_TOOLS } from '../src/tool-schema.js';
import { createDocx } from '../src/writer.js';

function tmpFile(ext: string): string {
  return path.join(os.tmpdir(), `docx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

describe('DOCX_TOOLS', () => {
  it('should have 23 tools', () => {
    expect(DOCX_TOOLS).toHaveLength(23);
  });

  it('should have unique tool names', () => {
    const names = DOCX_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools should have type "function"', () => {
    for (const tool of DOCX_TOOLS) {
      expect(tool.type).toBe('function');
    }
  });
});

describe('handleDocxTool', () => {
  it('should handle unknown tool', async () => {
    const result = await handleDocxTool('unknown_tool', {});
    expect(result.success).toBe(false);
    expect(result.output).toContain('Unknown');
  });

  it('docx_create_markdown', async () => {
    const outputPath = tmpFile('docx');
    const result = await handleDocxTool('docx_create_markdown', {
      markdown: '# Test\n\nHello world.',
      output_path: outputPath,
    });
    expect(result.success).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
    fs.unlinkSync(outputPath);
  });

  it('docx_create_document', async () => {
    const outputPath = tmpFile('docx');
    const result = await handleDocxTool('docx_create_document', {
      output_path: outputPath,
      content: [
        { paragraph: { text: 'Hello', heading: 1 } },
        { paragraph: { text: 'World' } },
      ],
    });
    expect(result.success).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
    fs.unlinkSync(outputPath);
  });

  it('docx_find_replace', async () => {
    const inputPath = tmpFile('docx');
    const buffer = await createDocx('# Hello\n\nOriginal text here.');
    fs.writeFileSync(inputPath, buffer);

    const outputPath = tmpFile('docx');
    const result = await handleDocxTool('docx_find_replace', {
      path: inputPath,
      find: 'Original',
      replace: 'Modified',
      output_path: outputPath,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('1');

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('Modified');
    expect(docXml).not.toContain('Original');

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
  });

  it('docx_insert_text', async () => {
    const inputPath = tmpFile('docx');
    const buffer = await createDocx('# Title');
    fs.writeFileSync(inputPath, buffer);

    const outputPath = tmpFile('docx');
    const result = await handleDocxTool('docx_insert_text', {
      path: inputPath,
      text: 'New paragraph\nAnother paragraph',
      output_path: outputPath,
    });
    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('New paragraph');
    expect(docXml).toContain('Another paragraph');

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
  });

  it('docx_set_metadata', async () => {
    const inputPath = tmpFile('docx');
    const buffer = await createDocx('# Test');
    fs.writeFileSync(inputPath, buffer);

    const outputPath = tmpFile('docx');
    const result = await handleDocxTool('docx_set_metadata', {
      path: inputPath,
      title: 'New Title',
      author: 'New Author',
      output_path: outputPath,
    });
    expect(result.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const coreXml = await zip.file('docProps/core.xml')!.async('string');
    expect(coreXml).toContain('New Title');
    expect(coreXml).toContain('New Author');

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
  });

  it('docx_accept_changes', async () => {
    // Create a minimal DOCX with tracked changes
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>keep</w:t></w:r><w:del w:id="1"><w:r><w:t>remove</w:t></w:r></w:del><w:ins w:id="2"><w:r><w:t>add</w:t></w:r></w:ins></w:p>
</w:body>
</w:document>`);

    const inputPath = tmpFile('docx');
    const zipBuffer = await zip.generateAsync({ type: 'uint8array' });
    fs.writeFileSync(inputPath, zipBuffer);

    const outputPath = tmpFile('docx');
    const result = await handleDocxTool('docx_accept_changes', {
      path: inputPath,
      output_path: outputPath,
    });
    expect(result.success).toBe(true);

    const outZip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    const docXml = await outZip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('keep');
    expect(docXml).toContain('add');
    expect(docXml).not.toContain('remove');
    expect(docXml).not.toContain('w:del');
    expect(docXml).not.toContain('w:ins');

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
  });

  it('docx_init_task + pipeline steps', async () => {
    const initResult = await handleDocxTool('docx_init_task', {
      session_id: 'test',
      task_id: 'pipeline-test',
    });
    expect(initResult.success).toBe(true);
    const taskDir = initResult.output;

    const writeResult = await handleDocxTool('docx_write_markdown', {
      task_dir: taskDir,
      markdown: '# Pipeline Test\n\nContent.',
    });
    expect(writeResult.success).toBe(true);

    const xmlResult = await handleDocxTool('docx_write_xml', {
      task_dir: taskDir,
    });
    expect(xmlResult.success).toBe(true);

    const packResult = await handleDocxTool('docx_pack_document', {
      task_dir: taskDir,
    });
    expect(packResult.success).toBe(true);
    expect(packResult.outputPath).toBeTruthy();
  });
});
