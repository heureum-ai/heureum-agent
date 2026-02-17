/**
 * Base validator with common validation logic for document files.
 * Ported from validators/base.py
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { XMLParser, XMLBuilder } from "fast-xml-parser";
// libxmljs2 is optional — native module may not load in Electron
let _libxmljs: any | null | undefined = undefined;
async function getLibxmljs(): Promise<any | null> {
  if (_libxmljs !== undefined) return _libxmljs;
  try {
    const dynamicImport = new Function("m", "return import(m)") as (
      moduleName: string
    ) => Promise<any>;
    _libxmljs = await dynamicImport("libxmljs2");
  } catch {
    _libxmljs = null;
  }
  return _libxmljs;
}
import JSZip from "jszip";

const PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
  allowBooleanAttributes: true,
};

const BUILDER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  suppressBooleanAttributes: false,
  format: false,
};

export function parseXml(xmlStr: string): any[] {
  const parser = new XMLParser(PARSER_OPTIONS);
  const result = parser.parse(xmlStr);
  return Array.isArray(result)
    ? result.filter((n: any) => !("?xml" in n))
    : [result];
}

export function buildXml(nodes: any[]): string {
  const builder = new XMLBuilder(BUILDER_OPTIONS);
  const filtered = nodes.filter((n: any) => !("?xml" in n));
  return '<?xml version="1.0" encoding="UTF-8"?>' + builder.build(filtered);
}

export function getTagName(node: any): string | null {
  if (typeof node !== "object" || node === null) return null;
  for (const key of Object.keys(node)) {
    if (!key.startsWith("@_") && !key.startsWith("#") && key !== ":@") {
      return key;
    }
  }
  return null;
}

/** Get local name from a possibly namespaced tag */
export function getLocalName(tag: string): string {
  const colonIdx = tag.lastIndexOf(":");
  return colonIdx >= 0 ? tag.slice(colonIdx + 1) : tag;
}

/** Recursively find all XML and .rels files in a directory */
export function findXmlFiles(dir: string): string[] {
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
  if (fs.existsSync(dir)) walk(dir);
  return results;
}

/** Recursively find all files in a directory */
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
  if (fs.existsSync(dir)) walk(dir);
  return results;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export type UniqueIdRequirement = {
  attrName: string;
  scope: "file" | "global";
};

export class BaseSchemaValidator {
  static IGNORED_VALIDATION_ERRORS = ["hyphenationZone", "purl.org/dc/terms"];

  static UNIQUE_ID_REQUIREMENTS: Record<string, UniqueIdRequirement> = {
    comment: { attrName: "id", scope: "file" },
    commentrangestart: { attrName: "id", scope: "file" },
    commentrangeend: { attrName: "id", scope: "file" },
    bookmarkstart: { attrName: "id", scope: "file" },
    bookmarkend: { attrName: "id", scope: "file" },
    sldid: { attrName: "id", scope: "file" },
    sldmasterid: { attrName: "id", scope: "global" },
    sldlayoutid: { attrName: "id", scope: "global" },
    cm: { attrName: "authorid", scope: "file" },
    sheet: { attrName: "sheetid", scope: "file" },
    definedname: { attrName: "id", scope: "file" },
    cxnsp: { attrName: "id", scope: "file" },
    sp: { attrName: "id", scope: "file" },
    pic: { attrName: "id", scope: "file" },
    grpsp: { attrName: "id", scope: "file" },
  };

  static EXCLUDED_ID_CONTAINERS = new Set(["sectionlst"]);

  static PACKAGE_RELATIONSHIPS_NAMESPACE =
    "http://schemas.openxmlformats.org/package/2006/relationships";
  static OFFICE_RELATIONSHIPS_NAMESPACE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  static CONTENT_TYPES_NAMESPACE =
    "http://schemas.openxmlformats.org/package/2006/content-types";

  static MAIN_CONTENT_FOLDERS = new Set(["word", "ppt", "xl"]);

  static SCHEMA_MAPPINGS: Record<string, string> = {
    "word": "ISO-IEC29500-4_2016/wml.xsd",
    "ppt": "ISO-IEC29500-4_2016/pml.xsd",
    "xl": "ISO-IEC29500-4_2016/sml.xsd",
    "[Content_Types].xml": "ecma/fouth-edition/opc-contentTypes.xsd",
    "app.xml": "ISO-IEC29500-4_2016/shared-documentPropertiesExtended.xsd",
    "core.xml": "ecma/fouth-edition/opc-coreProperties.xsd",
    "custom.xml": "ISO-IEC29500-4_2016/shared-documentPropertiesCustom.xsd",
    ".rels": "ecma/fouth-edition/opc-relationships.xsd",
    "people.xml": "microsoft/wml-2012.xsd",
    "commentsIds.xml": "microsoft/wml-cid-2016.xsd",
    "commentsExtensible.xml": "microsoft/wml-cex-2018.xsd",
    "commentsExtended.xml": "microsoft/wml-2012.xsd",
    "chart": "ISO-IEC29500-4_2016/dml-chart.xsd",
    "theme": "ISO-IEC29500-4_2016/dml-main.xsd",
    "drawing": "ISO-IEC29500-4_2016/dml-main.xsd",
  };

  static MC_NAMESPACE = "http://schemas.openxmlformats.org/markup-compatibility/2006";
  static XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

  static OOXML_NAMESPACES = new Set([
    "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://schemas.openxmlformats.org/schemaLibrary/2006/main",
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "http://schemas.openxmlformats.org/drawingml/2006/chartDrawing",
    "http://schemas.openxmlformats.org/drawingml/2006/diagram",
    "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://schemas.openxmlformats.org/officeDocument/2006/sharedTypes",
    "http://www.w3.org/XML/1998/namespace",
  ]);

  static ELEMENT_RELATIONSHIP_TYPES: Record<string, string> = {};

  unpackedDir: string;
  originalFile: string | null;
  verbose: boolean;
  xmlFiles: string[];
  schemasDir: string;

  constructor(
    unpackedDir: string,
    originalFile?: string | null,
    verbose: boolean = false
  ) {
    this.unpackedDir = path.resolve(unpackedDir);
    this.originalFile = originalFile ? path.resolve(originalFile) : null;
    this.verbose = verbose;
    this.xmlFiles = findXmlFiles(this.unpackedDir);
    const schemaCandidates = [
      path.resolve(__dirname, "../schemas"),
      path.resolve(__dirname, "../../assets/skills/skills/pptx/scripts/office/schemas"),
      path.resolve(__dirname, "../../../assets/skills/skills/pptx/scripts/office/schemas"),
    ];
    this.schemasDir =
      schemaCandidates.find((candidate) => fs.existsSync(candidate)) ??
      schemaCandidates[0];

    if (this.xmlFiles.length === 0) {
      console.warn(`Warning: No XML files found in ${this.unpackedDir}`);
    }
  }

  validate(): ValidationResult | Promise<ValidationResult> {
    throw new Error("Subclasses must implement the validate method");
  }

  repair(): number {
    return this.repairWhitespacePreservation();
  }

  repairWhitespacePreservation(): number {
    let repairs = 0;

    for (const xmlFile of this.xmlFiles) {
      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);
        let modified = false;

        const repair = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;

            // Check if this is a :t element
            if (tag.endsWith(":t") || tag === "t") {
              const textArr = node[tag];
              if (Array.isArray(textArr) && textArr.length > 0) {
                const firstChild = textArr[0];
                const text =
                  typeof firstChild === "string"
                    ? firstChild
                    : firstChild?.["#text"] ?? "";
                if (
                  text &&
                  (text.startsWith(" ") ||
                    text.startsWith("\t") ||
                    text.endsWith(" ") ||
                    text.endsWith("\t"))
                ) {
                  const attrs = node[":@"] || {};
                  if (attrs["@_xml:space"] !== "preserve") {
                    if (!node[":@"]) node[":@"] = {};
                    node[":@"]["@_xml:space"] = "preserve";
                    repairs++;
                    modified = true;
                  }
                }
              }
            }

            if (Array.isArray(node[tag])) {
              repair(node[tag]);
            }
          }
        };

        repair(nodes);

        if (modified) {
          fs.writeFileSync(xmlFile, buildXml(nodes), "utf-8");
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    return repairs;
  }

  validateXml(): ValidationResult {
    const errors: string[] = [];

    for (const xmlFile of this.xmlFiles) {
      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        parseXml(content);
      } catch (e: any) {
        const rel = path.relative(this.unpackedDir, xmlFile);
        errors.push(`  ${rel}: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} XML violations:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateNamespaces(): ValidationResult {
    const errors: string[] = [];

    for (const xmlFile of this.xmlFiles) {
      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);

        // Find root element
        const root = nodes[0];
        if (!root) continue;
        const attrs = root[":@"] || {};

        // Collect declared namespace prefixes
        const declared = new Set<string>();
        for (const key of Object.keys(attrs)) {
          const match = key.match(/^@_xmlns:(.+)$/);
          if (match) declared.add(match[1]);
        }

        // Check Ignorable attribute
        for (const key of Object.keys(attrs)) {
          if (key.endsWith("Ignorable")) {
            const prefixes = (attrs[key] as string).split(/\s+/);
            for (const prefix of prefixes) {
              if (prefix && !declared.has(prefix)) {
                const rel = path.relative(this.unpackedDir, xmlFile);
                errors.push(
                  `  ${rel}: Namespace '${prefix}' in Ignorable but not declared`
                );
              }
            }
          }
        }
      } catch {
        continue;
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`${errors.length} namespace issues:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateUniqueIds(): ValidationResult {
    const errors: string[] = [];
    const globalIds: Record<
      string,
      { file: string; tag: string }
    > = {};

    for (const xmlFile of this.xmlFiles) {
      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);
        const fileIds: Record<string, Record<string, boolean>> = {};
        const rel = path.relative(this.unpackedDir, xmlFile);

        const checkNode = (
          node: any,
          ancestors: string[]
        ): void => {
          const tag = getTagName(node);
          if (!tag) return;

          const localName = getLocalName(tag).toLowerCase();

          // Check if in excluded container
          const inExcluded = ancestors.some((a) =>
            BaseSchemaValidator.EXCLUDED_ID_CONTAINERS.has(a)
          );
          if (inExcluded) return;

          const req =
            BaseSchemaValidator.UNIQUE_ID_REQUIREMENTS[localName];
          if (req) {
            const attrs = node[":@"] || {};
            // Find the matching attribute
            let idValue: string | null = null;
            for (const attrKey of Object.keys(attrs)) {
              const attrLocal = getLocalName(
                attrKey.replace("@_", "")
              ).toLowerCase();
              if (attrLocal === req.attrName) {
                idValue = String(attrs[attrKey]);
                break;
              }
            }

            if (idValue !== null) {
              if (req.scope === "global") {
                if (globalIds[idValue]) {
                  const prev = globalIds[idValue];
                  errors.push(
                    `  ${rel}: Global ID '${idValue}' in <${localName}> already used in ${prev.file} in <${prev.tag}>`
                  );
                } else {
                  globalIds[idValue] = {
                    file: rel,
                    tag: localName,
                  };
                }
              } else {
                const key = `${localName}:${req.attrName}`;
                if (!fileIds[key]) fileIds[key] = {};
                if (fileIds[key][idValue]) {
                  errors.push(
                    `  ${rel}: Duplicate ${req.attrName}='${idValue}' in <${localName}>`
                  );
                } else {
                  fileIds[key][idValue] = true;
                }
              }
            }
          }

          if (Array.isArray(node[tag])) {
            for (const child of node[tag]) {
              if (typeof child === "object" && child !== null) {
                checkNode(child, [...ancestors, localName]);
              }
            }
          }
        };

        for (const node of nodes) {
          checkNode(node, []);
        }
      } catch (e: any) {
        const rel = path.relative(this.unpackedDir, xmlFile);
        errors.push(`  ${rel}: Error: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} ID uniqueness violations:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateFileReferences(): ValidationResult {
    const errors: string[] = [];
    const relsFiles = this.xmlFiles.filter((f) => f.endsWith(".rels"));

    if (relsFiles.length === 0) {
      return { valid: true, errors: [] };
    }

    const allFiles = new Set(
      findAllFiles(this.unpackedDir)
        .filter(
          (f) =>
            !f.endsWith("[Content_Types].xml") && !f.endsWith(".rels")
        )
        .map((f) => path.resolve(f))
    );

    const allReferencedFiles = new Set<string>();

    for (const relsFile of relsFiles) {
      try {
        const content = fs.readFileSync(relsFile, "utf-8");
        const nodes = parseXml(content);
        const relsDir = path.dirname(relsFile);

        const checkRel = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (tag === "Relationship") {
              const attrs = node[":@"] || {};
              const target = attrs["@_Target"];
              if (
                target &&
                !target.startsWith("http") &&
                !target.startsWith("mailto:")
              ) {
                let targetPath: string;
                if (target.startsWith("/")) {
                  targetPath = path.join(
                    this.unpackedDir,
                    target.replace(/^\//, "")
                  );
                } else if (path.basename(relsFile) === ".rels") {
                  targetPath = path.join(this.unpackedDir, target);
                } else {
                  const baseDir = path.dirname(relsDir);
                  targetPath = path.join(baseDir, target);
                }

                targetPath = path.resolve(targetPath);
                if (fs.existsSync(targetPath)) {
                  allReferencedFiles.add(targetPath);
                } else {
                  const rel = path.relative(this.unpackedDir, relsFile);
                  errors.push(
                    `  ${rel}: Broken reference to ${target}`
                  );
                }
              }
            }
            if (tag && Array.isArray(node[tag])) {
              checkRel(node[tag]);
            }
          }
        };

        checkRel(nodes);
      } catch (e: any) {
        const rel = path.relative(this.unpackedDir, relsFile);
        errors.push(`  Error parsing ${rel}: ${e.message}`);
      }
    }

    // Check for unreferenced files
    for (const filePath of allFiles) {
      if (!allReferencedFiles.has(filePath)) {
        const rel = path.relative(this.unpackedDir, filePath);
        errors.push(`  Unreferenced file: ${rel}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} relationship validation errors:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateAllRelationshipIds(): ValidationResult {
    const errors: string[] = [];

    for (const xmlFile of this.xmlFiles) {
      if (xmlFile.endsWith(".rels")) continue;

      const relsDir = path.join(path.dirname(xmlFile), "_rels");
      const relsFile = path.join(
        relsDir,
        `${path.basename(xmlFile)}.rels`
      );

      if (!fs.existsSync(relsFile)) continue;

      try {
        const relsContent = fs.readFileSync(relsFile, "utf-8");
        const relsNodes = parseXml(relsContent);

        const ridToType: Record<string, string> = {};
        const collectRids = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (tag === "Relationship") {
              const attrs = node[":@"] || {};
              const rid = attrs["@_Id"];
              const relType = attrs["@_Type"] || "";
              if (rid) {
                if (ridToType[rid]) {
                  const rel = path.relative(
                    this.unpackedDir,
                    relsFile
                  );
                  errors.push(
                    `  ${rel}: Duplicate relationship ID '${rid}'`
                  );
                }
                const typeName = relType.includes("/")
                  ? relType.split("/").pop()!
                  : relType;
                ridToType[rid] = typeName;
              }
            }
            if (tag && Array.isArray(node[tag])) {
              collectRids(node[tag]);
            }
          }
        };
        collectRids(relsNodes);

        // Check r:id, r:embed, r:link references in the XML file
        const xmlContent = fs.readFileSync(xmlFile, "utf-8");
        const xmlNodes = parseXml(xmlContent);

        const checkRefs = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;
            const attrs = node[":@"] || {};
            const elemName = getLocalName(tag);

            for (const attrKey of Object.keys(attrs)) {
              const cleanKey = attrKey.replace("@_", "");
              // Match r:id, r:embed, r:link
              if (
                cleanKey === "r:id" ||
                cleanKey === "r:embed" ||
                cleanKey === "r:link"
              ) {
                const ridAttr = attrs[attrKey];
                if (ridAttr && !ridToType[ridAttr]) {
                  const rel = path.relative(
                    this.unpackedDir,
                    xmlFile
                  );
                  errors.push(
                    `  ${rel}: <${elemName}> ${cleanKey} references non-existent relationship '${ridAttr}'`
                  );
                } else if (
                  ridAttr &&
                  cleanKey === "r:id" &&
                  Object.keys(
                    (this.constructor as typeof BaseSchemaValidator).ELEMENT_RELATIONSHIP_TYPES
                  ).length > 0
                ) {
                  // Validate relationship type matches expected type for element
                  const expectedType = this.getExpectedRelationshipType(elemName);
                  if (expectedType) {
                    const actualType = ridToType[ridAttr];
                    if (!actualType.toLowerCase().includes(expectedType)) {
                      const rel = path.relative(
                        this.unpackedDir,
                        xmlFile
                      );
                      errors.push(
                        `  ${rel}: <${elemName}> references '${ridAttr}' which points to '${actualType}' but should point to a '${expectedType}' relationship`
                      );
                    }
                  }
                }
              }
            }

            if (Array.isArray(node[tag])) {
              checkRefs(node[tag]);
            }
          }
        };
        checkRefs(xmlNodes);
      } catch (e: any) {
        const rel = path.relative(this.unpackedDir, xmlFile);
        errors.push(`  Error processing ${rel}: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} relationship ID reference errors:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateContentTypes(): ValidationResult {
    const errors: string[] = [];
    const ctFile = path.join(this.unpackedDir, "[Content_Types].xml");

    if (!fs.existsSync(ctFile)) {
      return { valid: false, errors: ["[Content_Types].xml file not found"] };
    }

    try {
      const content = fs.readFileSync(ctFile, "utf-8");
      const nodes = parseXml(content);

      const declaredParts = new Set<string>();
      const declaredExtensions = new Set<string>();

      const declarableRoots = new Set([
        "sld",
        "sldLayout",
        "sldMaster",
        "presentation",
        "document",
        "workbook",
        "worksheet",
        "theme",
      ]);

      const mediaExtensions: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        bmp: "image/bmp",
        tiff: "image/tiff",
        wmf: "image/x-wmf",
        emf: "image/x-emf",
      };

      // Collect declared parts and extensions
      const collect = (nodeArr: any[]): void => {
        for (const node of nodeArr) {
          const tag = getTagName(node);
          if (tag === "Override") {
            const attrs = node[":@"] || {};
            const partName = attrs["@_PartName"];
            if (partName) declaredParts.add(partName.replace(/^\//, ""));
          } else if (tag === "Default") {
            const attrs = node[":@"] || {};
            const ext = attrs["@_Extension"];
            if (ext) declaredExtensions.add(ext.toLowerCase());
          }
          if (tag && Array.isArray(node[tag])) {
            collect(node[tag]);
          }
        }
      };
      collect(nodes);

      // Check XML files with declarable root elements
      for (const xmlFile of this.xmlFiles) {
        const pathStr = path
          .relative(this.unpackedDir, xmlFile)
          .replace(/\\/g, "/");

        if (
          pathStr.includes(".rels") ||
          pathStr.includes("[Content_Types]") ||
          pathStr.includes("docProps/") ||
          pathStr.includes("_rels/")
        )
          continue;

        try {
          const xmlContent = fs.readFileSync(xmlFile, "utf-8");
          const xmlNodes = parseXml(xmlContent);
          if (xmlNodes.length === 0) continue;

          const rootTag = getTagName(xmlNodes[0]);
          if (!rootTag) continue;
          const rootName = getLocalName(rootTag);

          if (
            declarableRoots.has(rootName) &&
            !declaredParts.has(pathStr)
          ) {
            errors.push(
              `  ${pathStr}: File with <${rootName}> root not declared in [Content_Types].xml`
            );
          }
        } catch {
          continue;
        }
      }

      // Check media files
      for (const filePath of findAllFiles(this.unpackedDir)) {
        const ext = path.extname(filePath).replace(".", "").toLowerCase();
        if (ext === "xml" || ext === "rels") continue;
        if (path.basename(filePath) === "[Content_Types].xml") continue;

        const rel = path.relative(this.unpackedDir, filePath);
        if (rel.includes("_rels") || rel.includes("docProps")) continue;

        if (ext && !declaredExtensions.has(ext) && ext in mediaExtensions) {
          errors.push(
            `  ${rel}: File with extension '${ext}' not declared in [Content_Types].xml`
          );
        }
      }
    } catch (e: any) {
      errors.push(`  Error parsing [Content_Types].xml: ${e.message}`);
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} content type declaration errors:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  /** Derive expected relationship type from element name. Ported from base.py:469-490 */
  getExpectedRelationshipType(elementName: string): string | null {
    const elemLower = elementName.toLowerCase();
    const types = (this.constructor as typeof BaseSchemaValidator).ELEMENT_RELATIONSHIP_TYPES;

    if (types[elemLower]) return types[elemLower];

    if (elemLower.endsWith("id") && elemLower.length > 2) {
      const prefix = elemLower.slice(0, -2);
      if (prefix.endsWith("master")) return prefix.toLowerCase();
      if (prefix.endsWith("layout")) return prefix.toLowerCase();
      if (prefix === "sld") return "slide";
      return prefix.toLowerCase();
    }

    if (elemLower.endsWith("reference") && elemLower.length > 9) {
      const prefix = elemLower.slice(0, -9);
      return prefix.toLowerCase();
    }

    return null;
  }

  /** Map file name/path to XSD schema file path. Ported from base.py:685-701 */
  getSchemaPath(xmlFile: string): string | null {
    const fileName = path.basename(xmlFile);
    const ext = path.extname(xmlFile);
    const parentName = path.basename(path.dirname(xmlFile));

    if (BaseSchemaValidator.SCHEMA_MAPPINGS[fileName]) {
      return BaseSchemaValidator.SCHEMA_MAPPINGS[fileName];
    }
    if (ext === ".rels") {
      return BaseSchemaValidator.SCHEMA_MAPPINGS[".rels"];
    }
    if (xmlFile.includes("charts/") && fileName.startsWith("chart")) {
      return BaseSchemaValidator.SCHEMA_MAPPINGS["chart"];
    }
    if (xmlFile.includes("theme/") && fileName.startsWith("theme")) {
      return BaseSchemaValidator.SCHEMA_MAPPINGS["theme"];
    }
    if (BaseSchemaValidator.MAIN_CONTENT_FOLDERS.has(parentName)) {
      return BaseSchemaValidator.SCHEMA_MAPPINGS[parentName] ?? null;
    }
    return null;
  }

  /** Remove mc:Ignorable attribute from root. Ported from base.py:742-748 */
  preprocessForMcIgnorable(nodes: any[]): any[] {
    if (nodes.length === 0) return nodes;
    const root = nodes[0];
    if (root && root[":@"]) {
      const mcKey = Object.keys(root[":@"]).find(k => k.endsWith("Ignorable"));
      if (mcKey) {
        delete root[":@"][mcKey];
      }
    }
    return nodes;
  }

  /** Remove {{...}} template tags from text nodes (not inside :t). Ported from base.py:814-843 */
  removeTemplateTags(nodes: any[]): { nodes: any[]; warnings: string[] } {
    const warnings: string[] = [];
    const templatePattern = /\{\{[^}]*\}\}/g;

    const process = (nodeArr: any[], insideT: boolean): void => {
      for (const node of nodeArr) {
        const tag = getTagName(node);
        if (!tag) {
          // Check #text nodes
          if ("#text" in node && !insideT) {
            const text = String(node["#text"]);
            const matches = text.match(templatePattern);
            if (matches) {
              for (const m of matches) {
                warnings.push(`Found template tag in text content: ${m}`);
              }
              node["#text"] = text.replace(templatePattern, "");
            }
          }
          continue;
        }

        const isT = tag.endsWith(":t") || tag === "t";
        if (isT) continue; // Skip :t elements entirely

        if (Array.isArray(node[tag])) {
          process(node[tag], isT);
        }
      }
    };

    // Deep clone to avoid mutation
    const cloned = JSON.parse(JSON.stringify(nodes));
    process(cloned, false);
    return { nodes: cloned, warnings };
  }

  /**
   * Build a prefix→URI mapping from xmlns: declarations on a node.
   * Walks the `:@` attributes and collects entries like `@_xmlns:w14` → `http://...`.
   */
  private _collectNamespaceMap(nodeArr: any[]): Record<string, string> {
    const nsMap: Record<string, string> = {};
    for (const node of nodeArr) {
      const attrs = node[":@"] || {};
      for (const key of Object.keys(attrs)) {
        const match = key.match(/^@_xmlns:(.+)$/);
        if (match) {
          nsMap[match[1]] = attrs[key] as string;
        }
      }
    }
    return nsMap;
  }

  /** Remove non-OOXML namespace elements recursively. Ported from base.py:723-740 */
  removeIgnorableElements(nodeArr: any[], nsMap?: Record<string, string>): any[] {
    const map = nsMap ?? this._collectNamespaceMap(nodeArr);

    return nodeArr.filter(node => {
      const tag = getTagName(node);
      if (!tag) return true; // Keep text nodes

      if (tag.includes(":")) {
        const prefix = tag.split(":")[0];
        const uri = map[prefix];
        if (uri && !BaseSchemaValidator.OOXML_NAMESPACES.has(uri)) {
          return false; // Remove element with non-OOXML namespace
        }
      }

      if (Array.isArray(node[tag])) {
        node[tag] = this.removeIgnorableElements(node[tag], map);
      }
      return true;
    });
  }

  /** Clean ignorable namespace attributes and elements. Ported from base.py:703-721 */
  cleanIgnorableNamespaces(nodes: any[]): any[] {
    const cloned: any[] = JSON.parse(JSON.stringify(nodes));
    const nsMap = this._collectNamespaceMap(cloned);

    const clean = (nodeArr: any[]): void => {
      for (const node of nodeArr) {
        const tag = getTagName(node);
        if (!tag) continue;

        // Remove non-OOXML namespace attributes
        if (node[":@"]) {
          const keysToRemove: string[] = [];
          for (const key of Object.keys(node[":@"])) {
            if (!key.startsWith("@_")) continue;
            const attrName = key.slice(2);
            if (attrName.startsWith("xmlns:")) continue; // keep namespace declarations
            if (attrName.includes(":")) {
              const prefix = attrName.split(":")[0];
              const uri = nsMap[prefix];
              if (uri && !BaseSchemaValidator.OOXML_NAMESPACES.has(uri)) {
                keysToRemove.push(key);
              }
            }
          }
          for (const key of keysToRemove) {
            delete node[":@"][key];
          }
        }

        if (Array.isArray(node[tag])) {
          clean(node[tag]);
        }
      }
    };

    clean(cloned);
    // Also remove non-OOXML elements
    return this.removeIgnorableElements(cloned, nsMap);
  }

  /**
   * Validate a single XML file against its XSD schema.
   * Ported from base.py:750-785 (_validate_single_file_xsd)
   * Returns [null, null] if no schema found, [true, Set()] if valid, [false, Set(errors)] if invalid.
   */
  private async _validateSingleFileXsd(
    xmlFile: string,
    basePath: string
  ): Promise<[boolean | null, Set<string> | null]> {
    const libxmljs = await getLibxmljs();
    if (!libxmljs) return [null, null]; // XSD validation requires libxmljs2

    const schemaPath = this.getSchemaPath(xmlFile);
    if (!schemaPath) return [null, null];

    const fullSchemaPath = path.join(this.schemasDir, schemaPath);
    if (!fs.existsSync(fullSchemaPath)) return [null, null];

    try {
      const xsdStr = fs.readFileSync(fullSchemaPath, "utf-8");
      const xsdDoc = libxmljs.parseXml(xsdStr, { baseUrl: fullSchemaPath });

      let xmlStr = fs.readFileSync(xmlFile, "utf-8");

      // Preprocess: remove template tags
      const { nodes: cleanedNodes } = this.removeTemplateTags(parseXml(xmlStr));
      // Preprocess: remove mc:Ignorable
      const preprocessed = this.preprocessForMcIgnorable(cleanedNodes);

      // Check if file is in main content folder → clean ignorable namespaces
      const relativePath = path.relative(basePath, xmlFile);
      const parts = relativePath.split(path.sep);
      let finalNodes = preprocessed;
      if (parts.length > 0 && BaseSchemaValidator.MAIN_CONTENT_FOLDERS.has(parts[0])) {
        finalNodes = this.cleanIgnorableNamespaces(preprocessed);
      }

      // Rebuild the XML string from the cleaned nodes
      xmlStr = buildXml(finalNodes);

      const xmlDoc = libxmljs.parseXml(xmlStr);
      const valid = xmlDoc.validate(xsdDoc);

      if (valid) {
        return [true, new Set()];
      } else {
        const errors = new Set<string>();
        for (const error of xmlDoc.validationErrors) {
          errors.add(error.message?.trim() || String(error));
        }
        if (
          [...errors].some((error) =>
            error.toLowerCase().includes("invalid xsd schema")
          )
        ) {
          return [null, null];
        }
        return [false, errors];
      }
    } catch (e: any) {
      const message = String(e?.message ?? e ?? "");
      if (message.toLowerCase().includes("invalid xsd schema")) {
        return [null, null];
      }
      return [false, new Set([e.message || String(e)])];
    }
  }

  /**
   * Get validation errors from the original file for comparison.
   * Ported from base.py:787-812 (_get_original_file_errors)
   */
  private async _getOriginalFileErrors(xmlFile: string): Promise<Set<string>> {
    if (!this.originalFile) return new Set();

    const xmlFilePath = path.resolve(xmlFile);
    const relativePath = path.relative(this.unpackedDir, xmlFilePath);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xsd-orig-"));
    try {
      const buffer = fs.readFileSync(this.originalFile);
      const zip = await JSZip.loadAsync(buffer);

      for (const [zipPath, zipEntry] of Object.entries(zip.files)) {
        if (zipEntry.dir) {
          fs.mkdirSync(path.join(tmpDir, zipPath), { recursive: true });
        } else {
          const content = await zipEntry.async("uint8array");
          const destPath = path.join(tmpDir, zipPath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.writeFileSync(destPath, content);
        }
      }

      const originalXmlFile = path.join(tmpDir, relativePath);
      if (!fs.existsSync(originalXmlFile)) return new Set();

      const [, errors] = await this._validateSingleFileXsd(originalXmlFile, tmpDir);
      return errors ?? new Set();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * Validate a single file against XSD with original-error diffing.
   * Ported from base.py:598-634 (validate_file_against_xsd)
   */
  async validateFileAgainstXsd(
    xmlFile: string,
    verbose: boolean = false
  ): Promise<[boolean | null, Set<string>]> {
    const xmlFilePath = path.resolve(xmlFile);

    const [isValid, currentErrors] = await this._validateSingleFileXsd(
      xmlFilePath,
      this.unpackedDir
    );

    if (isValid === null) return [null, new Set()];
    if (isValid) return [true, new Set()];

    // Compare against original file's errors
    const originalErrors = await this._getOriginalFileErrors(xmlFilePath);
    let newErrors = new Set<string>();
    for (const e of currentErrors!) {
      if (!originalErrors.has(e)) {
        newErrors.add(e);
      }
    }

    // Filter out ignored validation errors
    newErrors = new Set(
      [...newErrors].filter(
        e => !BaseSchemaValidator.IGNORED_VALIDATION_ERRORS.some(pattern => e.includes(pattern))
      )
    );

    if (newErrors.size > 0) {
      if (verbose) {
        const rel = path.relative(this.unpackedDir, xmlFilePath);
        console.log(`FAILED - ${rel}: ${newErrors.size} new error(s)`);
      }
      return [false, newErrors];
    }

    return [true, new Set()];
  }

  /**
   * Validate all XML files against their XSD schemas.
   * Ported from base.py:636-683 (validate_against_xsd)
   */
  async validateAgainstXsd(): Promise<ValidationResult> {
    const newErrors: string[] = [];
    let validCount = 0;
    let skippedCount = 0;

    for (const xmlFile of this.xmlFiles) {
      const relativePath = path.relative(this.unpackedDir, xmlFile);
      const [isValid, fileErrors] = await this.validateFileAgainstXsd(xmlFile);

      if (isValid === null) {
        skippedCount++;
        continue;
      }
      if (isValid) {
        validCount++;
        continue;
      }

      newErrors.push(`  ${relativePath}: ${fileErrors.size} new error(s)`);
      let count = 0;
      for (const error of fileErrors) {
        if (count >= 3) break;
        const truncated = error.length > 250 ? error.slice(0, 250) + "..." : error;
        newErrors.push(`    - ${truncated}`);
        count++;
      }
    }

    if (this.verbose) {
      console.log(`Validated ${this.xmlFiles.length} files:`);
      console.log(`  - Valid: ${validCount}`);
      console.log(`  - Skipped (no schema): ${skippedCount}`);
    }

    if (newErrors.length > 0) {
      return {
        valid: false,
        errors: ["Found NEW XSD validation errors:", ...newErrors],
      };
    }
    return { valid: true, errors: [] };
  }
}
