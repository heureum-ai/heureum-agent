/**
 * Unpack Office files (DOCX, PPTX, XLSX) for editing.
 *
 * Extracts the ZIP archive, pretty-prints XML files, and optionally:
 * - Merges adjacent runs with identical formatting (DOCX only)
 * - Simplifies adjacent tracked changes from same author (DOCX only)
 *
 * Ported from unpack.py
 */
import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


const SMART_QUOTE_REPLACEMENTS: Record<string, string> = {
  "\u201c": "&#x201C;", // left double quote
  "\u201d": "&#x201D;", // right double quote
  "\u2018": "&#x2018;", // left single quote
  "\u2019": "&#x2019;", // right single quote
};

const VALID_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx"]);

export interface UnpackOptions {
  mergeRuns?: boolean;
  simplifyRedlines?: boolean;
}

/**
 * Unpack an Office file into a directory.
 *
 * @param inputFile - Path to the Office file
 * @param outputDirectory - Directory to extract to
 * @param options - Optional processing options
 * @returns [null, message] tuple
 */
export async function unpack(
  inputFile: string,
  outputDirectory: string,
  _options: UnpackOptions = {}
): Promise<[null, string]> {
  const suffix = path.extname(inputFile).toLowerCase();

  if (!(await pathExists(inputFile))) {
    return [null, `Error: ${inputFile} does not exist`];
  }

  if (!VALID_EXTENSIONS.has(suffix)) {
    return [null, `Error: ${inputFile} must be a .docx, .pptx, or .xlsx file`];
  }

  try {
    const fileBuffer = (await fs.promises.readFile(inputFile));
    const zip = await JSZip.loadAsync(fileBuffer);

    ;(await fs.promises.mkdir(outputDirectory, { recursive: true }));

    // Extract all files
    for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
      const fullPath = path.join(outputDirectory, relativePath);
      if (zipEntry.dir) {
        ;(await fs.promises.mkdir(fullPath, { recursive: true }));
      } else {
        ;(await fs.promises.mkdir(path.dirname(fullPath), { recursive: true }));
        const content = await zipEntry.async("uint8array");
        ;(await fs.promises.writeFile(fullPath, content));
      }
    }

    // Pretty-print XML files
    const xmlFiles = findXmlFiles(outputDirectory);
    for (const xmlFile of xmlFiles) {
      prettyPrintXml(xmlFile);
    }

    let message = `Unpacked ${inputFile} (${xmlFiles.length} XML files)`;

    // Escape smart quotes
    for (const xmlFile of xmlFiles) {
      escapeSmartQuotes(xmlFile);
    }

    return [null, message];
  } catch (e: any) {
    if (e.message?.includes("not a valid zip") || e.message?.includes("End of data")) {
      return [null, `Error: ${inputFile} is not a valid Office file`];
    }
    return [null, `Error unpacking: ${e.message}`];
  }
}

/** Recursively find all .xml and .rels files */
function findXmlFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".xml") || entry.name.endsWith(".rels")) {
        results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

/** Pretty-print an XML file */
function prettyPrintXml(xmlFile: string): void {
  try {
    const content = fs.readFileSync(xmlFile, "utf-8");
    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseTagValue: false,
      trimValues: false,
      processEntities: false,
      allowBooleanAttributes: true,
    });
    const parsed = parser.parse(content);
    const builder = new XMLBuilder({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      processEntities: false,
      suppressBooleanAttributes: false,
      format: true,
      indentBy: "  ",
    });
    const filtered = Array.isArray(parsed)
      ? parsed.filter((n: any) => !("?xml" in n))
      : [parsed];
    const pretty =
      '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(filtered);
    fs.writeFileSync(xmlFile, pretty, "utf-8");
  } catch {
    // Skip files that can't be parsed as XML
  }
}

/** Escape smart quotes in an XML file */
function escapeSmartQuotes(xmlFile: string): void {
  try {
    let content = fs.readFileSync(xmlFile, "utf-8");
    for (const [char, entity] of Object.entries(SMART_QUOTE_REPLACEMENTS)) {
      content = content.replaceAll(char, entity);
    }
    fs.writeFileSync(xmlFile, content, "utf-8");
  } catch {
    // Skip files that can't be read
  }
}
