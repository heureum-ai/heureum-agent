import { describe, expect, it } from 'vitest';
import { HWPX_TOOLS, handleHwpxTool } from '../src/tool-schema.js';

describe('HWPX tool visibility', () => {
  it('does not expose hwpx_create_markdown in tool list', () => {
    const names = HWPX_TOOLS.map((tool) => tool.name);
    expect(names).not.toContain('hwpx_create_markdown');
  });

  it('does not expose hwpx_create_document in tool list', () => {
    const names = HWPX_TOOLS.map((tool) => tool.name);
    expect(names).not.toContain('hwpx_create_document');
  });

  it('rejects direct dispatch of hwpx_create_markdown', async () => {
    const result = await handleHwpxTool('hwpx_create_markdown', {});
    expect(result.success).toBe(false);
    expect(result.output).toContain('Unknown HWPX tool');
  });

  it('rejects direct dispatch of hwpx_create_document', async () => {
    const result = await handleHwpxTool('hwpx_create_document', {});
    expect(result.success).toBe(false);
    expect(result.output).toContain('Unknown HWPX tool');
  });
});
