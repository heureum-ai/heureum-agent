/**
 * Validator for Word document XML files.
 * Ported from validators/docx.py
 */
import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";
import {
  BaseSchemaValidator,
  ValidationResult,
  parseXml,
  buildXml,
  getTagName,
  getLocalName,
} from "./base";

export class DOCXSchemaValidator extends BaseSchemaValidator {
  static WORD_2006_NAMESPACE =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  static W14_NAMESPACE =
    "http://schemas.microsoft.com/office/word/2010/wordml";
  static W16CID_NAMESPACE =
    "http://schemas.microsoft.com/office/word/2016/wordml/cid";

  async validate(): Promise<ValidationResult> {
    const xmlResult = this.validateXml();
    if (!xmlResult.valid) return xmlResult;

    const allErrors: string[] = [];

    for (const result of [
      this.validateNamespaces(),
      this.validateUniqueIds(),
      this.validateFileReferences(),
      this.validateContentTypes(),
      this.validateWhitespacePreservation(),
      this.validateDeletions(),
      this.validateInsertions(),
      this.validateAllRelationshipIds(),
      this.validateIdConstraints(),
      this.validateCommentMarkers(),
    ]) {
      if (!result.valid) allErrors.push(...result.errors);
    }

    // XSD validation
    const xsdResult = await this.validateAgainstXsd();
    if (!xsdResult.valid) allErrors.push(...xsdResult.errors);

    // Compare paragraph counts (informational)
    const comparison = await this.compareParagraphCounts();
    if (this.verbose && comparison) {
      console.log(comparison);
    }

    return { valid: allErrors.length === 0, errors: allErrors };
  }

  validateWhitespacePreservation(): ValidationResult {
    const errors: string[] = [];

    for (const xmlFile of this.xmlFiles) {
      if (path.basename(xmlFile) !== "document.xml") continue;

      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);

        const check = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;

            // Check w:t elements
            if (tag === "w:t" || (tag.endsWith(":t") && tag.includes("w"))) {
              const textArr = node[tag];
              if (Array.isArray(textArr) && textArr.length > 0) {
                const first = textArr[0];
                const text =
                  typeof first === "string"
                    ? first
                    : first?.["#text"] ?? "";
                if (text && /^[\s\t\n\r]|[\s\t\n\r]$/.test(text)) {
                  const attrs = node[":@"] || {};
                  if (attrs["@_xml:space"] !== "preserve") {
                    const rel = path.relative(this.unpackedDir, xmlFile);
                    const preview =
                      JSON.stringify(text).length > 50
                        ? JSON.stringify(text).slice(0, 50) + "..."
                        : JSON.stringify(text);
                    errors.push(
                      `  ${rel}: w:t element with whitespace missing xml:space='preserve': ${preview}`
                    );
                  }
                }
              }
            }

            if (Array.isArray(node[tag])) {
              check(node[tag]);
            }
          }
        };

        check(nodes);
      } catch (e: any) {
        const rel = path.relative(this.unpackedDir, xmlFile);
        errors.push(`  ${rel}: Error: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} whitespace preservation violations:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateDeletions(): ValidationResult {
    const errors: string[] = [];

    for (const xmlFile of this.xmlFiles) {
      if (path.basename(xmlFile) !== "document.xml") continue;

      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);

        // Find w:t and w:instrText inside w:del
        const findInDel = (
          nodeArr: any[],
          insideDel: boolean
        ): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;

            const localName = getLocalName(tag);
            const isDel = localName === "del";

            if (insideDel && (localName === "t" || localName === "instrText")) {
              const textArr = node[tag];
              const text =
                Array.isArray(textArr) && textArr.length > 0
                  ? String(
                      typeof textArr[0] === "string"
                        ? textArr[0]
                        : textArr[0]?.["#text"] ?? ""
                    )
                  : "";
              if (localName === "t" && text) {
                const rel = path.relative(this.unpackedDir, xmlFile);
                const preview =
                  JSON.stringify(text).length > 50
                    ? JSON.stringify(text).slice(0, 50) + "..."
                    : JSON.stringify(text);
                errors.push(
                  `  ${rel}: <w:t> found within <w:del>: ${preview}`
                );
              }
              if (localName === "instrText") {
                const rel = path.relative(this.unpackedDir, xmlFile);
                errors.push(
                  `  ${rel}: <w:instrText> found within <w:del> (use <w:delInstrText>)`
                );
              }
            }

            if (Array.isArray(node[tag])) {
              findInDel(node[tag], insideDel || isDel);
            }
          }
        };

        findInDel(nodes, false);
      } catch (e: any) {
        const rel = path.relative(this.unpackedDir, xmlFile);
        errors.push(`  ${rel}: Error: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} deletion validation violations:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateInsertions(): ValidationResult {
    const errors: string[] = [];

    for (const xmlFile of this.xmlFiles) {
      if (path.basename(xmlFile) !== "document.xml") continue;

      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);

        // Find w:delText inside w:ins but NOT inside w:del
        const findDelTextInIns = (
          nodeArr: any[],
          insideIns: boolean,
          insideDel: boolean
        ): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;

            const localName = getLocalName(tag);
            const isIns = localName === "ins";
            const isDel = localName === "del";

            if (insideIns && !insideDel && localName === "delText") {
              const rel = path.relative(this.unpackedDir, xmlFile);
              errors.push(
                `  ${rel}: <w:delText> within <w:ins>`
              );
            }

            if (Array.isArray(node[tag])) {
              findDelTextInIns(
                node[tag],
                insideIns || isIns,
                insideDel || isDel
              );
            }
          }
        };

        findDelTextInIns(nodes, false, false);
      } catch (e: any) {
        const rel = path.relative(this.unpackedDir, xmlFile);
        errors.push(`  ${rel}: Error: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} insertion validation violations:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateIdConstraints(): ValidationResult {
    const errors: string[] = [];

    for (const xmlFile of this.xmlFiles) {
      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);
        const fileName = path.basename(xmlFile);

        const check = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;
            const attrs = node[":@"] || {};

            // Check paraId (w14:paraId)
            const paraId = attrs["@_w14:paraId"];
            if (paraId) {
              const val = parseInt(paraId, 16);
              if (!isNaN(val) && val >= 0x80000000) {
                errors.push(
                  `  ${fileName}: paraId=${paraId} >= 0x80000000`
                );
              }
            }

            // Check durableId (w16cid:durableId)
            const durableId = attrs["@_w16cid:durableId"];
            if (durableId) {
              if (fileName === "numbering.xml") {
                const val = parseInt(durableId, 10);
                if (isNaN(val)) {
                  errors.push(
                    `  ${fileName}: durableId=${durableId} must be decimal in numbering.xml`
                  );
                } else if (val >= 0x7fffffff) {
                  errors.push(
                    `  ${fileName}: durableId=${durableId} >= 0x7FFFFFFF`
                  );
                }
              } else {
                const val = parseInt(durableId, 16);
                if (!isNaN(val) && val >= 0x7fffffff) {
                  errors.push(
                    `  ${fileName}: durableId=${durableId} >= 0x7FFFFFFF`
                  );
                }
              }
            }

            if (Array.isArray(node[tag])) {
              check(node[tag]);
            }
          }
        };

        check(nodes);
      } catch {
        // Skip
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`${errors.length} ID constraint violations:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  validateCommentMarkers(): ValidationResult {
    const errors: string[] = [];

    let documentXml: string | null = null;
    let commentsXml: string | null = null;

    for (const xmlFile of this.xmlFiles) {
      if (
        path.basename(xmlFile) === "document.xml" &&
        xmlFile.includes("word")
      )
        documentXml = xmlFile;
      if (path.basename(xmlFile) === "comments.xml") commentsXml = xmlFile;
    }

    if (!documentXml) {
      return { valid: true, errors: [] };
    }

    try {
      const docContent = fs.readFileSync(documentXml, "utf-8");
      const docNodes = parseXml(docContent);

      const rangeStarts = new Set<string>();
      const rangeEnds = new Set<string>();
      const references = new Set<string>();

      const collectMarkers = (nodeArr: any[]): void => {
        for (const node of nodeArr) {
          const tag = getTagName(node);
          if (!tag) continue;
          const localName = getLocalName(tag);
          const attrs = node[":@"] || {};

          if (localName === "commentRangeStart") {
            const id = attrs["@_w:id"];
            if (id) rangeStarts.add(id);
          } else if (localName === "commentRangeEnd") {
            const id = attrs["@_w:id"];
            if (id) rangeEnds.add(id);
          } else if (localName === "commentReference") {
            const id = attrs["@_w:id"];
            if (id) references.add(id);
          }

          if (Array.isArray(node[tag])) {
            collectMarkers(node[tag]);
          }
        }
      };
      collectMarkers(docNodes);

      // Check orphaned ends
      for (const id of rangeEnds) {
        if (!rangeStarts.has(id)) {
          errors.push(
            `  document.xml: commentRangeEnd id="${id}" has no matching commentRangeStart`
          );
        }
      }

      // Check orphaned starts
      for (const id of rangeStarts) {
        if (!rangeEnds.has(id)) {
          errors.push(
            `  document.xml: commentRangeStart id="${id}" has no matching commentRangeEnd`
          );
        }
      }

      // Check references against comments.xml
      if (commentsXml && fs.existsSync(commentsXml)) {
        const commentsContent = fs.readFileSync(commentsXml, "utf-8");
        const commentsNodes = parseXml(commentsContent);

        const commentIds = new Set<string>();
        const collectCommentIds = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;
            if (getLocalName(tag) === "comment") {
              const attrs = node[":@"] || {};
              const id = attrs["@_w:id"];
              if (id) commentIds.add(id);
            }
            if (Array.isArray(node[tag])) {
              collectCommentIds(node[tag]);
            }
          }
        };
        collectCommentIds(commentsNodes);

        const allMarkerIds = new Set([
          ...rangeStarts,
          ...rangeEnds,
          ...references,
        ]);
        for (const id of allMarkerIds) {
          if (id && !commentIds.has(id)) {
            errors.push(
              `  document.xml: marker id="${id}" references non-existent comment`
            );
          }
        }
      }
    } catch (e: any) {
      errors.push(`  Error parsing XML: ${e.message}`);
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`${errors.length} comment marker violations:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  /** Parse a string ID value with configurable base. Ported from docx.py:251-252 */
  private _parseIdValue(val: string, base: number = 16): number {
    const result = parseInt(val, base);
    if (isNaN(result)) throw new Error(`Invalid ID value: ${val}`);
    return result;
  }

  countParagraphsInUnpacked(): number {
    let count = 0;
    for (const xmlFile of this.xmlFiles) {
      if (path.basename(xmlFile) !== "document.xml") continue;
      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);

        const countP = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;
            if (getLocalName(tag) === "p") count++;
            if (Array.isArray(node[tag])) {
              countP(node[tag]);
            }
          }
        };
        countP(nodes);
      } catch {
        // Skip
      }
    }
    return count;
  }

  async countParagraphsInOriginal(): Promise<number> {
    if (!this.originalFile) return 0;

    try {
      const buffer = (await fs.promises.readFile(this.originalFile));
      const zip = await JSZip.loadAsync(buffer);
      const docFile = zip.file("word/document.xml");
      if (!docFile) return 0;

      const content = await docFile.async("string");
      const nodes = parseXml(content);

      let count = 0;
      const countP = (nodeArr: any[]): void => {
        for (const node of nodeArr) {
          const tag = getTagName(node);
          if (!tag) continue;
          if (getLocalName(tag) === "p") count++;
          if (Array.isArray(node[tag])) {
            countP(node[tag]);
          }
        }
      };
      countP(nodes);
      return count;
    } catch {
      return 0;
    }
  }

  async compareParagraphCounts(): Promise<string> {
    const originalCount = await this.countParagraphsInOriginal();
    const newCount = this.countParagraphsInUnpacked();
    const diff = newCount - originalCount;
    const diffStr = diff > 0 ? `+${diff}` : String(diff);
    return `\nParagraphs: ${originalCount} → ${newCount} (${diffStr})`;
  }

  repair(): number {
    let repairs = super.repair();
    repairs += this.repairDurableId();
    return repairs;
  }

  repairDurableId(): number {
    let repairs = 0;

    for (const xmlFile of this.xmlFiles) {
      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);
        let modified = false;
        const fileName = path.basename(xmlFile);

        const fix = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;
            const attrs = node[":@"] || {};
            const durableId = attrs["@_w16cid:durableId"];

            if (durableId !== undefined) {
              let needsRepair = false;

              if (fileName === "numbering.xml") {
                const val = parseInt(durableId, 10);
                needsRepair = isNaN(val) || val >= 0x7fffffff;
              } else {
                const val = parseInt(durableId, 16);
                needsRepair = isNaN(val) || val >= 0x7fffffff;
              }

              if (needsRepair) {
                const value = Math.floor(
                  Math.random() * 0x7ffffffe
                ) + 1;
                const newId =
                  fileName === "numbering.xml"
                    ? String(value)
                    : value.toString(16).toUpperCase().padStart(8, "0");
                attrs["@_w16cid:durableId"] = newId;
                console.log(`  Repaired: ${fileName}: durableId ${durableId} → ${newId}`);
                repairs++;
                modified = true;
              }
            }

            if (Array.isArray(node[tag])) {
              fix(node[tag]);
            }
          }
        };

        fix(nodes);

        if (modified) {
          fs.writeFileSync(xmlFile, buildXml(nodes), "utf-8");
        }
      } catch {
        // Skip
      }
    }

    return repairs;
  }
}
