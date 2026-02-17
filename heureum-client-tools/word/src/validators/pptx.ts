/**
 * Validator for PowerPoint presentation XML files.
 * Ported from validators/pptx.py
 */
import * as fs from "fs";
import * as path from "path";
import {
  BaseSchemaValidator,
  ValidationResult,
  parseXml,
  getTagName,
  getLocalName,
} from "./base";

export class PPTXSchemaValidator extends BaseSchemaValidator {
  static PRESENTATIONML_NAMESPACE =
    "http://schemas.openxmlformats.org/presentationml/2006/main";

  static override ELEMENT_RELATIONSHIP_TYPES: Record<string, string> = {
    sldid: "slide",
    sldmasterid: "slidemaster",
    notesmasterid: "notesmaster",
    sldlayoutid: "slidelayout",
    themeid: "theme",
    tablestyleid: "tablestyles",
  };

  async validate(): Promise<ValidationResult> {
    const xmlResult = this.validateXml();
    if (!xmlResult.valid) return xmlResult;

    const allErrors: string[] = [];

    for (const result of [
      this.validateNamespaces(),
      this.validateUniqueIds(),
      this.validateUuidIds(),
      this.validateFileReferences(),
      this.validateSlideLayoutIds(),
      this.validateContentTypes(),
      this.validateAllRelationshipIds(),
      this.validateNoDuplicateSlideLayouts(),
      this.validateNotesSlideReferences(),
    ]) {
      if (!result.valid) allErrors.push(...result.errors);
    }

    // XSD validation
    const xsdResult = await this.validateAgainstXsd();
    if (!xsdResult.valid) allErrors.push(...xsdResult.errors);

    return { valid: allErrors.length === 0, errors: allErrors };
  }

  /** Check if a value looks like a UUID (32 hex chars after removing dashes and braces). */
  private _looksLikeUuid(value: string): boolean {
    const clean = value.replace(/[{}\(\)\-]/g, "");
    return clean.length === 32 && /^[0-9a-fA-F]+$/.test(clean);
  }

  /** Validate UUID-like IDs contain valid hex characters. Ported from pptx.py:62-98 */
  validateUuidIds(): ValidationResult {
    const errors: string[] = [];
    const uuidPattern = /^[\{\(]?[0-9A-Fa-f]{8}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{12}[\}\)]?$/;

    for (const xmlFile of this.xmlFiles) {
      try {
        const content = fs.readFileSync(xmlFile, "utf-8");
        const nodes = parseXml(content);
        const rel = path.relative(this.unpackedDir, xmlFile);

        const check = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;
            const attrs = node[":@"] || {};

            for (const [key, value] of Object.entries(attrs)) {
              if (!key.startsWith("@_")) continue;
              const attrName = getLocalName(key.slice(2)).toLowerCase();
              if (attrName === "id" || attrName.endsWith("id")) {
                const strVal = String(value);
                if (this._looksLikeUuid(strVal) && !uuidPattern.test(strVal)) {
                  errors.push(
                    `  ${rel}: ID '${strVal}' appears to be a UUID but contains invalid hex characters`
                  );
                }
              }
            }

            if (Array.isArray(node[tag])) check(node[tag]);
          }
        };
        check(nodes);
      } catch (e: any) {
        errors.push(`  ${path.relative(this.unpackedDir, xmlFile)}: Error: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} UUID ID validation errors:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  /** Validate slide layout IDs reference valid layouts. Ported from pptx.py:104-170 */
  validateSlideLayoutIds(): ValidationResult {
    const errors: string[] = [];

    // Find slide master files
    const slideMastersDir = path.join(this.unpackedDir, "ppt", "slideMasters");
    if (!fs.existsSync(slideMastersDir)) {
      return { valid: true, errors: [] };
    }

    const slideMasters = fs.readdirSync(slideMastersDir)
      .filter(f => f.endsWith(".xml"))
      .map(f => path.join(slideMastersDir, f));

    for (const masterFile of slideMasters) {
      try {
        const content = fs.readFileSync(masterFile, "utf-8");
        const nodes = parseXml(content);
        const rel = path.relative(this.unpackedDir, masterFile);

        // Find rels file
        const relsFile = path.join(
          path.dirname(masterFile), "_rels", `${path.basename(masterFile)}.rels`
        );

        if (!fs.existsSync(relsFile)) {
          errors.push(`  ${rel}: Missing relationships file`);
          continue;
        }

        const relsContent = fs.readFileSync(relsFile, "utf-8");
        const relsNodes = parseXml(relsContent);

        // Collect valid layout rIds from rels
        const validLayoutRids = new Set<string>();
        const collectRels = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (tag === "Relationship") {
              const attrs = node[":@"] || {};
              const relType = attrs["@_Type"] || "";
              if (relType.includes("slideLayout")) {
                const rid = attrs["@_Id"];
                if (rid) validLayoutRids.add(rid);
              }
            }
            if (tag && Array.isArray(node[tag])) collectRels(node[tag]);
          }
        };
        collectRels(relsNodes);

        // Check sldLayoutId references
        const checkLayouts = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (!tag) continue;
            if (getLocalName(tag) === "sldLayoutId") {
              const attrs = node[":@"] || {};
              // Look for r:id attribute
              const rId = attrs["@_r:id"];
              const layoutId = attrs["@_id"];
              if (rId && !validLayoutRids.has(rId)) {
                errors.push(
                  `  ${rel}: sldLayoutId with id='${layoutId}' references r:id='${rId}' which is not found in slide layout relationships`
                );
              }
            }
            if (Array.isArray(node[tag])) checkLayouts(node[tag]);
          }
        };
        checkLayouts(nodes);
      } catch (e: any) {
        errors.push(`  ${path.relative(this.unpackedDir, masterFile)}: Error: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found ${errors.length} slide layout ID errors:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }

  /** Check no slide has duplicate slideLayout references. Ported from pptx.py:172-208 */
  validateNoDuplicateSlideLayouts(): ValidationResult {
    const errors: string[] = [];
    const relsDir = path.join(this.unpackedDir, "ppt", "slides", "_rels");

    if (!fs.existsSync(relsDir)) {
      return { valid: true, errors: [] };
    }

    const relsFiles = fs.readdirSync(relsDir)
      .filter(f => f.endsWith(".xml.rels"))
      .map(f => path.join(relsDir, f));

    for (const relsFile of relsFiles) {
      try {
        const content = fs.readFileSync(relsFile, "utf-8");
        const nodes = parseXml(content);
        const rel = path.relative(this.unpackedDir, relsFile);

        let layoutCount = 0;
        const countLayouts = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (tag === "Relationship") {
              const attrs = node[":@"] || {};
              if ((attrs["@_Type"] || "").includes("slideLayout")) {
                layoutCount++;
              }
            }
            if (tag && Array.isArray(node[tag])) countLayouts(node[tag]);
          }
        };
        countLayouts(nodes);

        if (layoutCount > 1) {
          errors.push(`  ${rel}: has ${layoutCount} slideLayout references`);
        }
      } catch (e: any) {
        errors.push(`  ${path.relative(this.unpackedDir, relsFile)}: Error: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: ["Slides with duplicate slideLayout references:", ...errors] };
    }
    return { valid: true, errors: [] };
  }

  /** Validate notes slide references are unique. Ported from pptx.py:210-271 */
  validateNotesSlideReferences(): ValidationResult {
    const errors: string[] = [];
    const noteReferences: Record<string, Array<{ slide: string; relsFile: string }>> = {};

    const relsDir = path.join(this.unpackedDir, "ppt", "slides", "_rels");
    if (!fs.existsSync(relsDir)) {
      return { valid: true, errors: [] };
    }

    const relsFiles = fs.readdirSync(relsDir)
      .filter(f => f.endsWith(".xml.rels"))
      .map(f => path.join(relsDir, f));

    for (const relsFile of relsFiles) {
      try {
        const content = fs.readFileSync(relsFile, "utf-8");
        const nodes = parseXml(content);
        const slideName = path.basename(relsFile, ".xml.rels");

        const findNotes = (nodeArr: any[]): void => {
          for (const node of nodeArr) {
            const tag = getTagName(node);
            if (tag === "Relationship") {
              const attrs = node[":@"] || {};
              const relType = attrs["@_Type"] || "";
              if (relType.includes("notesSlide")) {
                const target = (attrs["@_Target"] || "").replace("../", "");
                if (target) {
                  if (!noteReferences[target]) noteReferences[target] = [];
                  noteReferences[target].push({ slide: slideName, relsFile });
                }
              }
            }
            if (tag && Array.isArray(node[tag])) findNotes(node[tag]);
          }
        };
        findNotes(nodes);
      } catch (e: any) {
        errors.push(`  ${path.relative(this.unpackedDir, relsFile)}: Error: ${e.message}`);
      }
    }

    // Check for duplicates
    for (const [target, refs] of Object.entries(noteReferences)) {
      if (refs.length > 1) {
        const slideNames = refs.map(r => r.slide).join(", ");
        errors.push(`  Notes slide '${target}' is referenced by multiple slides: ${slideNames}`);
        for (const ref of refs) {
          errors.push(`    - ${path.relative(this.unpackedDir, ref.relsFile)}`);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors: [`Found notes slide reference errors:`, ...errors] };
    }
    return { valid: true, errors: [] };
  }
}
