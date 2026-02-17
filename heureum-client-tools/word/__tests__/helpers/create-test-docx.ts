/**
 * Utility to create test .docx files programmatically using JSZip.
 */
import JSZip from "jszip";
import * as fs from "fs";
import * as path from "path";

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const WORD_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

export interface TestParagraph {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export interface TrackedChange {
  type: "ins" | "del";
  text: string;
  author?: string;
  date?: string;
}

export interface TestDocxOptions {
  paragraphs?: TestParagraph[];
  trackedChanges?: TrackedChange[];
  /** Raw document.xml body content (overrides paragraphs/trackedChanges) */
  rawBody?: string;
  /** Additional XML files to include, keyed by path */
  extraFiles?: Record<string, string>;
}

function buildRunXml(text: string, bold?: boolean, italic?: boolean): string {
  let rPr = "";
  if (bold || italic) {
    rPr = "<w:rPr>";
    if (bold) rPr += "<w:b/>";
    if (italic) rPr += "<w:i/>";
    rPr += "</w:rPr>";
  }
  const needsPreserve = text.startsWith(" ") || text.endsWith(" ");
  const spaceAttr = needsPreserve ? ' xml:space="preserve"' : "";
  return `<w:r>${rPr}<w:t${spaceAttr}>${text}</w:t></w:r>`;
}

function buildDocumentXml(opts: TestDocxOptions): string {
  let body: string;

  if (opts.rawBody) {
    body = opts.rawBody;
  } else {
    const parts: string[] = [];

    if (opts.paragraphs) {
      for (const p of opts.paragraphs) {
        parts.push(
          `<w:p w14:paraId="${randomHexId()}" w14:textId="77777777">${buildRunXml(p.text, p.bold, p.italic)}</w:p>`
        );
      }
    }

    if (opts.trackedChanges) {
      for (const tc of opts.trackedChanges) {
        const author = tc.author ?? "TestAuthor";
        const date = tc.date ?? "2024-01-01T00:00:00Z";
        const tag = tc.type === "ins" ? "w:ins" : "w:del";
        const textTag = tc.type === "del" ? "w:delText" : "w:t";
        parts.push(
          `<w:p w14:paraId="${randomHexId()}" w14:textId="77777777">` +
            `<${tag} w:id="${Math.floor(Math.random() * 1000)}" w:author="${author}" w:date="${date}">` +
            `<w:r><${textTag}>${tc.text}</${textTag}></w:r>` +
            `</${tag}>` +
            `</w:p>`
        );
      }
    }

    if (parts.length === 0) {
      parts.push(
        `<w:p w14:paraId="${randomHexId()}" w14:textId="77777777"><w:r><w:t>Hello World</w:t></w:r></w:p>`
      );
    }

    body = parts.join("\n    ");
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
    xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
    xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
    xmlns:v="urn:schemas-microsoft-com:vml"
    xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    xmlns:w10="urn:schemas-microsoft-com:office:word"
    xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
    xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
    xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"
    xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"
    xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
    xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
    mc:Ignorable="w14 w15 w16cex w16cid">
  <w:body>
    ${body}
  </w:body>
</w:document>`;
}

function randomHexId(): string {
  return Math.floor(Math.random() * 0x7ffffffe)
    .toString(16)
    .toUpperCase()
    .padStart(8, "0");
}

/**
 * Create a .docx buffer (Uint8Array) in memory.
 */
export async function createTestDocxBuffer(
  opts: TestDocxOptions = {}
): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", RELS_XML);
  zip.file("word/_rels/document.xml.rels", WORD_RELS_XML);
  zip.file("word/document.xml", buildDocumentXml(opts));

  if (opts.extraFiles) {
    for (const [filePath, content] of Object.entries(opts.extraFiles)) {
      zip.file(filePath, content);
    }
  }

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/**
 * Create a .docx file on disk.
 */
export async function createTestDocxFile(
  filePath: string,
  opts: TestDocxOptions = {}
): Promise<void> {
  const buffer = await createTestDocxBuffer(opts);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, buffer);
}

/**
 * Unpack a .docx buffer to a directory (for testing unpack-like functions).
 */
export async function unpackDocxToDir(
  docxBuffer: Uint8Array,
  outputDir: string
): Promise<void> {
  const zip = await JSZip.loadAsync(docxBuffer);
  fs.mkdirSync(outputDir, { recursive: true });

  for (const [relativePath, file] of Object.entries(zip.files)) {
    const fullPath = path.join(outputDir, relativePath);
    if (file.dir) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const content = await file.async("uint8array");
      fs.writeFileSync(fullPath, content);
    }
  }
}
