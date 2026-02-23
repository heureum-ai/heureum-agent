import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MD_TOOLS, handleMdTool } from "../src/tool-schema";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "md-test-"));
}

function tmpFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("MD_TOOLS", () => {
  it("should have 19 tools", () => {
    expect(MD_TOOLS).toHaveLength(19);
  });

  it("should have unique tool names", () => {
    const names = MD_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tools should have type "function"', () => {
    for (const tool of MD_TOOLS) {
      expect(tool.type).toBe("function");
    }
  });
});

describe("handleMdTool", () => {
  it("should handle unknown tool", async () => {
    const result = await handleMdTool("md_nonexistent", {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown");
  });

  describe("md_create_document", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should create a markdown file with title", async () => {
      const outPath = path.join(dir, "doc.md");
      const result = await handleMdTool("md_create_document", {
        output_path: outPath,
        title: "Hello World",
        content: [
          { paragraph: { text: "This is a test paragraph." } },
        ],
      });
      expect(result.success).toBe(true);
      expect(result.outputPath).toBe(outPath);

      const content = fs.readFileSync(outPath, "utf-8");
      expect(content).toContain("# Hello World");
      expect(content).toContain("This is a test paragraph.");
    });

    it("should refuse overwrite without flag", async () => {
      const outPath = path.join(dir, "existing.md");
      fs.writeFileSync(outPath, "existing content", "utf-8");
      const result = await handleMdTool("md_create_document", {
        output_path: outPath,
        title: "New",
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("already exists");
    });
  });

  describe("md_read_document", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should read a markdown file", async () => {
      const filePath = tmpFile(dir, "read.md", "# Title\n\nBody text\n\n## Section\n\nMore text\n");
      const result = await handleMdTool("md_read_document", { path: filePath });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Title");
      expect(result.output).toContain("Headings: 2");
    });

    it("should return json format", async () => {
      const filePath = tmpFile(dir, "read-json.md", "# Doc\n\nParagraph\n");
      const result = await handleMdTool("md_read_document", {
        path: filePath,
        output_format: "json",
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.headings).toHaveLength(1);
      expect(parsed.headings[0].text).toBe("Doc");
    });

    it("should fail for missing file", async () => {
      const result = await handleMdTool("md_read_document", {
        path: path.join(dir, "nope.md"),
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("not found");
    });
  });

  describe("md_extract_outline", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should extract headings outline", async () => {
      const md = "# A\n\n## B\n\n### C\n\n## D\n";
      const filePath = tmpFile(dir, "outline.md", md);
      const result = await handleMdTool("md_extract_outline", { path: filePath });
      expect(result.success).toBe(true);
      // Output is plain text with one heading per line
      expect(result.output).toContain("A");
      expect(result.output).toContain("B");
      expect(result.output).toContain("C");
      expect(result.output).toContain("D");
    });
  });

  describe("md_append_content", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should append paragraph to existing file", async () => {
      const filePath = tmpFile(dir, "append.md", "# Existing\n\nOriginal.\n");
      const outPath = path.join(dir, "appended.md");
      const result = await handleMdTool("md_append_content", {
        path: filePath,
        output_path: outPath,
        content: [{ paragraph: { text: "Added paragraph." } }],
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(outPath, "utf-8");
      expect(content).toContain("Original");
      expect(content).toContain("Added paragraph");
    });
  });

  describe("md_format_document", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should normalize whitespace", async () => {
      const messy = "# Title\n\n\n\n\nToo many blanks.   \n\n\n\n";
      const filePath = tmpFile(dir, "messy.md", messy);
      const outPath = path.join(dir, "formatted.md");
      const result = await handleMdTool("md_format_document", {
        path: filePath,
        output_path: outPath,
        collapse_blank_lines: true,
        trim_trailing_spaces: true,
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(outPath, "utf-8");
      expect(content).not.toMatch(/\n{4,}/);
      expect(content).not.toMatch(/  +$/m);
    });
  });

  describe("md_manage_frontmatter", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should get frontmatter", async () => {
      const md = "---\ntitle: Hello\nauthor: Bob\n---\n\n# Doc\n";
      const filePath = tmpFile(dir, "fm.md", md);
      const result = await handleMdTool("md_manage_frontmatter", {
        path: filePath,
        action: "get",
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.frontmatter.title).toBe("Hello");
      expect(parsed.frontmatter.author).toBe("Bob");
    });

    it("should set frontmatter", async () => {
      const md = "# Doc\n\nBody\n";
      const filePath = tmpFile(dir, "fm-set.md", md);
      const outPath = path.join(dir, "fm-set-out.md");
      const result = await handleMdTool("md_manage_frontmatter", {
        path: filePath,
        action: "set",
        frontmatter: { title: "New Title", tags: ["a", "b"] },
        output_path: outPath,
      });
      expect(result.success).toBe(true);
      const content = fs.readFileSync(outPath, "utf-8");
      expect(content).toContain("title: New Title");
      expect(content).toContain("# Doc");
    });
  });

  describe("md_validate_document", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should validate a clean markdown document", async () => {
      const md = "# Title\n\nA clean paragraph.\n";
      const filePath = tmpFile(dir, "clean.md", md);
      const result = await handleMdTool("md_validate_document", { path: filePath });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.issue_count).toBe(0);
    });

    it("should flag raw HTML", async () => {
      const md = "# Title\n\n<div>Custom HTML</div>\n";
      const filePath = tmpFile(dir, "html.md", md);
      const result = await handleMdTool("md_validate_document", { path: filePath });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.issues.some((i: any) => i.code === "raw-html")).toBe(true);
    });
  });

  describe("md_generate_toc", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should generate table of contents", async () => {
      const md = "# Main\n\n## Intro\n\n## Details\n\n### Sub A\n\n## Conclusion\n";
      const filePath = tmpFile(dir, "toc.md", md);
      const outPath = path.join(dir, "toc_modified.md");
      const result = await handleMdTool("md_generate_toc", {
        path: filePath,
        output_path: outPath,
      });
      expect(result.success).toBe(true);
      // Tool saves TOC-inserted file and returns a message
      expect(result.output).toContain("saved to");
      const content = fs.readFileSync(outPath, "utf-8");
      expect(content).toContain("Intro");
      expect(content).toContain("Details");
      expect(content).toContain("Conclusion");
    });
  });

  describe("md_update_section", () => {
    let dir: string;
    beforeAll(() => { dir = tmpDir(); });
    afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("should replace section content", async () => {
      const md = "# Title\n\n## Section A\n\nOld content.\n\n## Section B\n\nKeep this.\n";
      const filePath = tmpFile(dir, "update.md", md);
      const outPath = path.join(dir, "updated.md");
      const result = await handleMdTool("md_update_section", {
        path: filePath,
        output_path: outPath,
        action: "replace_section",
        selector: { text: "Section A" },
        content: [{ paragraph: { text: "New content here." } }],
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain("Updated section");
      const content = fs.readFileSync(outPath, "utf-8");
      expect(content).toContain("New content here");
      expect(content).not.toContain("Old content");
    });
  });
});
