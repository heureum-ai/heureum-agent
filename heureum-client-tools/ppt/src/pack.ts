/**
 * Pack a directory into a DOCX, PPTX, or XLSX file.
 *
 * Validates with auto-repair, condenses XML formatting, and creates the Office file.
 *
 * Ported from pack.py
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { PARSER_OPTIONS, BUILDER_OPTIONS, getTagName } from "./xml-utils";
import { DOCXSchemaValidator } from "./validators/docx";
import { RedliningValidator } from "./validators/redlining";
import { PPTXSchemaValidator } from "./validators/pptx";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


const VALID_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx"]);

export type InferAuthorFunc = (
  unpackedDir: string,
  originalFile: string
) => Promise<string>;

export interface PackOptions {
  originalFile?: string;
  validate?: boolean;
  inferAuthorFunc?: InferAuthorFunc;
}

/** @internal Exported for testing only */
export const _internal = {
  condenseXml,
};

/**
 * Pack a directory into an Office file.
 *
 * @param inputDirectory - Path to the unpacked directory
 * @param outputFile - Output file path (.docx, .pptx, or .xlsx)
 * @param options - Pack options
 * @returns [null, message] tuple
 */
export async function pack(
  inputDirectory: string,
  outputFile: string,
  options: PackOptions = {}
): Promise<[null, string]> {
  const { originalFile, validate = true, inferAuthorFunc } = options;
  const suffix = path.extname(outputFile).toLowerCase();

  if (!(await pathExists(inputDirectory)) || !(await fs.promises.stat(inputDirectory)).isDirectory()) {
    return [null, `Error: ${inputDirectory} is not a directory`];
  }

  if (!VALID_EXTENSIONS.has(suffix)) {
    return [null, `Error: ${outputFile} must be a .docx, .pptx, or .xlsx file`];
  }

  // Run validation if requested
  if (validate && originalFile && (await pathExists(originalFile))) {
    const [success, output] = await runValidation(
      inputDirectory,
      originalFile,
      suffix,
      inferAuthorFunc
    );
    if (output) console.log(output);
    if (!success) {
      return [null, `Error: Validation failed for ${inputDirectory}`];
    }
  }

  // Create a temp copy and condense XML
  const tmpDir = (await fs.promises.mkdtemp(path.join(os.tmpdir(), "pack-")));
  const tmpContentDir = path.join(tmpDir, "content");

  try {
    await copyDir(inputDirectory, tmpContentDir);

    // Condense XML files
    const xmlFiles = findFiles(tmpContentDir, [".xml", ".rels"]);
    for (const xmlFile of xmlFiles) {
      condenseXml(xmlFile);
    }

    // Create ZIP file
    const zip = new JSZip();
    const allFiles = findAllFiles(tmpContentDir);

    for (const filePath of allFiles) {
      const relativePath = path.relative(tmpContentDir, filePath);
      const content = (await fs.promises.readFile(filePath));
      zip.file(relativePath.replace(/\\/g, "/"), content, {
        compression: "DEFLATE",
      });
    }

    const outputDir = path.dirname(outputFile);
    if (outputDir) (await fs.promises.mkdir(outputDir, { recursive: true }));

    const buffer = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
    ;(await fs.promises.writeFile(outputFile, buffer));

    return [null, `Successfully packed ${inputDirectory} to ${outputFile}`];
  } finally {
    ;(await fs.promises.rm(tmpDir, { recursive: true, force: true }));
  }
}

async function runValidation(
  unpackedDir: string,
  originalFile: string,
  suffix: string,
  inferAuthorFunc?: InferAuthorFunc
): Promise<[boolean, string | null]> {
  const outputLines: string[] = [];

  if (suffix === ".docx") {
    let author = "Claude";
    if (inferAuthorFunc) {
      try {
        author = await inferAuthorFunc(unpackedDir, originalFile);
      } catch (e: any) {
        console.error(
          `Warning: ${e.message} Using default author 'Claude'.`
        );
      }
    }

    const docxValidator = new DOCXSchemaValidator(
      unpackedDir,
      originalFile
    );
    const redliningValidator = new RedliningValidator(
      unpackedDir,
      originalFile,
      false,
      author
    );

    const totalRepairs =
      docxValidator.repair() + redliningValidator.repair();
    if (totalRepairs) {
      outputLines.push(`Auto-repaired ${totalRepairs} issue(s)`);
    }

    const [docxResult, redliningResult] = await Promise.all([
      docxValidator.validate(),
      redliningValidator.validate(),
    ]);

    if (docxResult.valid && redliningResult.valid) {
      outputLines.push("All validations PASSED!");
    }

    return [
      docxResult.valid && redliningResult.valid,
      outputLines.length > 0 ? outputLines.join("\n") : null,
    ];
  }

  if (suffix === ".pptx") {
    const pptxValidator = new PPTXSchemaValidator(unpackedDir, originalFile);
    const totalRepairs = pptxValidator.repair();
    if (totalRepairs) {
      outputLines.push(`Auto-repaired ${totalRepairs} issue(s)`);
    }
    const pptxResult = await pptxValidator.validate();
    if (pptxResult.valid) {
      outputLines.push("All validations PASSED!");
    }
    return [
      pptxResult.valid,
      outputLines.length > 0 ? outputLines.join("\n") : null,
    ];
  }

  // For non-DOCX/PPTX, skip validation
  return [true, null];
}

/**
 * Condense XML by removing whitespace-only text nodes and comments.
 * Preserves text content in :t elements.
 */
function condenseXml(xmlFile: string): void {
  try {
    const content = fs.readFileSync(xmlFile, "utf-8");
    const parser = new XMLParser(PARSER_OPTIONS);
    const parsed = parser.parse(content);
    const nodes = Array.isArray(parsed)
      ? parsed.filter((n: any) => !("?xml" in n))
      : [parsed];

    // Remove whitespace-only text nodes (except in :t elements)
    const condense = (nodeArr: any[], parentTag?: string): void => {
      for (let i = nodeArr.length - 1; i >= 0; i--) {
        const node = nodeArr[i];
        if (typeof node !== "object" || node === null) continue;

        // Remove whitespace-only #text nodes (but not inside :t elements)
        if ("#text" in node) {
          const text = String(node["#text"]);
          if (text.trim() === "" && !parentTag?.endsWith(":t")) {
            nodeArr.splice(i, 1);
          }
          continue;
        }

        // Remove comment nodes
        if ("__comment" in node) {
          nodeArr.splice(i, 1);
          continue;
        }

        const tag = getTagName(node);
        if (tag && Array.isArray(node[tag])) {
          // Don't remove text from :t elements
          if (!tag.endsWith(":t")) {
            condense(node[tag], tag);
          }
        }
      }
    };

    condense(nodes);

    const builder = new XMLBuilder(BUILDER_OPTIONS);
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' + builder.build(nodes);
    fs.writeFileSync(xmlFile, xml, "utf-8");
  } catch (e: any) {
    console.error(
      `ERROR: Failed to parse ${path.basename(xmlFile)}: ${e.message}`
    );
    throw e;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

function findAllFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}
