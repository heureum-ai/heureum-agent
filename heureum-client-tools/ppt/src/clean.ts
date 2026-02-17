/**
 * Remove unreferenced files from an unpacked PPTX directory.
 * Ported from skills/pptx/scripts/clean.py
 */
import * as fs from "fs";
import * as path from "path";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

type Relationship = {
  id: string;
  type: string;
  target: string;
};

const xmlParserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
};

const xmlBuilderOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: false,
};

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function parseRelationships(relsPath: string): Relationship[] {
  const xml = readText(relsPath);
  const parser = new XMLParser(xmlParserOptions);
  const parsed = parser.parse(xml);

  const rels = parsed?.Relationships?.Relationship;
  if (!rels) return [];

  const relArray = Array.isArray(rels) ? rels : [rels];
  return relArray.map((rel: any) => ({
    id: rel["@_Id"] ?? "",
    type: rel["@_Type"] ?? "",
    target: rel["@_Target"] ?? "",
  }));
}

function resolveTargetPath(relsFile: string, target: string): string {
  const relsDir = path.dirname(relsFile);
  const baseDir = path.dirname(relsDir);
  return path.resolve(baseDir, target);
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function getSlidesInSldIdLst(unpackedDir: string): Set<string> {
  const presPath = path.join(unpackedDir, "ppt", "presentation.xml");
  const presRelsPath = path.join(unpackedDir, "ppt", "_rels", "presentation.xml.rels");

  if (!fs.existsSync(presPath) || !fs.existsSync(presRelsPath)) {
    return new Set();
  }

  const ridToSlide = new Map<string, string>();
  for (const rel of parseRelationships(presRelsPath)) {
    if (rel.type.includes("slide") && rel.target.startsWith("slides/")) {
      ridToSlide.set(rel.id, rel.target.replace(/^slides\//, ""));
    }
  }

  const parser = new XMLParser(xmlParserOptions);
  const presContent = parser.parse(readText(presPath));

  const sldIdLst = presContent?.["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"];
  const sldIds = toArray(sldIdLst);

  const referenced = new Set<string>();
  for (const sldId of sldIds) {
    const rid = sldId?.["@_r:id"];
    if (rid) {
      const slide = ridToSlide.get(rid);
      if (slide) referenced.add(slide);
    }
  }
  return referenced;
}

function removeRelationshipsFromFile(
  relsPath: string,
  shouldRemove: (rel: { id: string; target: string; type: string }) => boolean
): void {
  const xml = readText(relsPath);
  const parser = new XMLParser(xmlParserOptions);
  const parsed = parser.parse(xml);

  const rels = parsed?.Relationships?.Relationship;
  if (!rels) return;

  const relArray = Array.isArray(rels) ? rels : [rels];
  const filtered = relArray.filter((rel: any) => {
    return !shouldRemove({
      id: rel["@_Id"] ?? "",
      target: rel["@_Target"] ?? "",
      type: rel["@_Type"] ?? "",
    });
  });

  parsed.Relationships.Relationship = filtered.length > 0 ? filtered : undefined;

  const builder = new XMLBuilder(xmlBuilderOptions);
  const result = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + builder.build(parsed);
  fs.writeFileSync(relsPath, result, "utf-8");
}

function removeOrphanedSlides(unpackedDir: string): string[] {
  const slidesDir = path.join(unpackedDir, "ppt", "slides");
  const slidesRelsDir = path.join(slidesDir, "_rels");
  const presRelsPath = path.join(unpackedDir, "ppt", "_rels", "presentation.xml.rels");

  if (!fs.existsSync(slidesDir)) return [];

  const referencedSlides = getSlidesInSldIdLst(unpackedDir);
  const removed: string[] = [];

  for (const fileName of fs.readdirSync(slidesDir)) {
    if (!/^slide\d+\.xml$/.test(fileName)) continue;
    if (referencedSlides.has(fileName)) continue;

    const slidePath = path.join(slidesDir, fileName);
    fs.unlinkSync(slidePath);
    removed.push(path.relative(unpackedDir, slidePath));

    const relsPath = path.join(slidesRelsDir, `${fileName}.rels`);
    if (fs.existsSync(relsPath)) {
      fs.unlinkSync(relsPath);
      removed.push(path.relative(unpackedDir, relsPath));
    }
  }

  if (removed.length > 0 && fs.existsSync(presRelsPath)) {
    removeRelationshipsFromFile(presRelsPath, (rel) => {
      if (!rel.target.startsWith("slides/")) return false;
      const slideName = rel.target.replace(/^slides\//, "");
      return !referencedSlides.has(slideName);
    });
  }

  return removed;
}

function removeTrashDirectory(unpackedDir: string): string[] {
  const trashDir = path.join(unpackedDir, "[trash]");
  const removed: string[] = [];

  if (!fs.existsSync(trashDir) || !fs.statSync(trashDir).isDirectory()) {
    return removed;
  }

  for (const fileName of fs.readdirSync(trashDir)) {
    const fullPath = path.join(trashDir, fileName);
    if (!fs.statSync(fullPath).isFile()) continue;
    fs.unlinkSync(fullPath);
    removed.push(path.relative(unpackedDir, fullPath));
  }

  fs.rmdirSync(trashDir);
  return removed;
}

function listRelsFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".rels")) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

function getSlideReferencedFiles(unpackedDir: string): Set<string> {
  const referenced = new Set<string>();
  const slidesRelsDir = path.join(unpackedDir, "ppt", "slides", "_rels");

  if (!fs.existsSync(slidesRelsDir)) return referenced;

  for (const relsFile of listRelsFiles(slidesRelsDir)) {
    for (const rel of parseRelationships(relsFile)) {
      if (!rel.target) continue;
      const resolved = resolveTargetPath(relsFile, rel.target);
      if (resolved.startsWith(path.resolve(unpackedDir))) {
        referenced.add(path.relative(unpackedDir, resolved));
      }
    }
  }

  return referenced;
}

function removeOrphanedRelsFiles(unpackedDir: string): string[] {
  const resourceDirs = ["charts", "diagrams", "drawings"];
  const removed: string[] = [];
  const slideReferenced = getSlideReferencedFiles(unpackedDir);

  for (const dirName of resourceDirs) {
    const relsDir = path.join(unpackedDir, "ppt", dirName, "_rels");
    if (!fs.existsSync(relsDir)) continue;

    for (const fileName of fs.readdirSync(relsDir)) {
      if (!fileName.endsWith(".rels")) continue;
      const relsFile = path.join(relsDir, fileName);
      const resourceFile = path.join(path.dirname(relsDir), fileName.replace(/\.rels$/, ""));
      const relResource = path.relative(unpackedDir, path.resolve(resourceFile));

      if (!fs.existsSync(resourceFile) || !slideReferenced.has(relResource)) {
        fs.unlinkSync(relsFile);
        removed.push(path.relative(unpackedDir, relsFile));
      }
    }
  }

  return removed;
}

function getReferencedFiles(unpackedDir: string): Set<string> {
  const referenced = new Set<string>();

  for (const relsFile of listRelsFiles(unpackedDir)) {
    for (const rel of parseRelationships(relsFile)) {
      if (!rel.target) continue;
      const resolved = resolveTargetPath(relsFile, rel.target);
      const root = path.resolve(unpackedDir);
      if (!resolved.startsWith(root)) continue;
      referenced.add(path.relative(unpackedDir, resolved));
    }
  }

  return referenced;
}

function removeOrphanedFiles(unpackedDir: string, referenced: Set<string>): string[] {
  const resourceDirs = ["media", "embeddings", "charts", "diagrams", "tags", "drawings", "ink"];
  const removed: string[] = [];

  for (const dirName of resourceDirs) {
    const dirPath = path.join(unpackedDir, "ppt", dirName);
    if (!fs.existsSync(dirPath)) continue;

    for (const fileName of fs.readdirSync(dirPath)) {
      const filePath = path.join(dirPath, fileName);
      if (!fs.statSync(filePath).isFile()) continue;
      const relPath = path.relative(unpackedDir, filePath);
      if (!referenced.has(relPath)) {
        fs.unlinkSync(filePath);
        removed.push(relPath);
      }
    }
  }

  const themeDir = path.join(unpackedDir, "ppt", "theme");
  if (fs.existsSync(themeDir)) {
    for (const fileName of fs.readdirSync(themeDir)) {
      if (!/^theme\d+\.xml$/.test(fileName)) continue;
      const filePath = path.join(themeDir, fileName);
      const relPath = path.relative(unpackedDir, filePath);
      if (!referenced.has(relPath)) {
        fs.unlinkSync(filePath);
        removed.push(relPath);
        const themeRels = path.join(themeDir, "_rels", `${fileName}.rels`);
        if (fs.existsSync(themeRels)) {
          fs.unlinkSync(themeRels);
          removed.push(path.relative(unpackedDir, themeRels));
        }
      }
    }
  }

  const notesDir = path.join(unpackedDir, "ppt", "notesSlides");
  if (fs.existsSync(notesDir)) {
    for (const fileName of fs.readdirSync(notesDir)) {
      if (!fileName.endsWith(".xml")) continue;
      const filePath = path.join(notesDir, fileName);
      if (!fs.statSync(filePath).isFile()) continue;
      const relPath = path.relative(unpackedDir, filePath);
      if (!referenced.has(relPath)) {
        fs.unlinkSync(filePath);
        removed.push(relPath);
      }
    }

    const notesRelsDir = path.join(notesDir, "_rels");
    if (fs.existsSync(notesRelsDir)) {
      for (const relsName of fs.readdirSync(notesRelsDir)) {
        if (!relsName.endsWith(".rels")) continue;
        const relsPath = path.join(notesRelsDir, relsName);
        const notesFile = path.join(notesDir, relsName.replace(/\.rels$/, ""));
        if (!fs.existsSync(notesFile)) {
          fs.unlinkSync(relsPath);
          removed.push(path.relative(unpackedDir, relsPath));
        }
      }
    }
  }

  return removed;
}

function updateContentTypes(unpackedDir: string, removedFiles: string[]): void {
  const contentTypesPath = path.join(unpackedDir, "[Content_Types].xml");
  if (!fs.existsSync(contentTypesPath)) return;

  const xml = readText(contentTypesPath);
  const parser = new XMLParser(xmlParserOptions);
  const parsed = parser.parse(xml);

  const overrides = parsed?.Types?.Override;
  if (!overrides) return;

  const removedSet = new Set(removedFiles.map((f) => f.replace(/\\/g, "/")));
  const overrideArray = Array.isArray(overrides) ? overrides : [overrides];
  const filtered = overrideArray.filter((override: any) => {
    const partName = (override["@_PartName"] ?? "").replace(/^\//, "");
    return !removedSet.has(partName);
  });

  parsed.Types.Override = filtered.length > 0 ? filtered : undefined;

  const builder = new XMLBuilder(xmlBuilderOptions);
  const result = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + builder.build(parsed);
  fs.writeFileSync(contentTypesPath, result, "utf-8");
}

export function cleanUnusedFiles(unpackedDir: string): string[] {
  const allRemoved: string[] = [];

  allRemoved.push(...removeOrphanedSlides(unpackedDir));
  allRemoved.push(...removeTrashDirectory(unpackedDir));

  while (true) {
    const removedRels = removeOrphanedRelsFiles(unpackedDir);
    const referenced = getReferencedFiles(unpackedDir);
    const removedFiles = removeOrphanedFiles(unpackedDir, referenced);
    const totalRemoved = [...removedRels, ...removedFiles];
    if (totalRemoved.length === 0) break;
    allRemoved.push(...totalRemoved);
  }

  if (allRemoved.length > 0) {
    updateContentTypes(unpackedDir, allRemoved);
  }

  return allRemoved;
}

export function cleanPptx(unpackedDir: string): { success: boolean; output: string } {
  if (!fs.existsSync(unpackedDir)) {
    return { success: false, output: `Error: ${unpackedDir} not found` };
  }

  try {
    const removed = cleanUnusedFiles(unpackedDir);
    if (removed.length === 0) {
      return { success: true, output: "No unreferenced files found" };
    }

    const lines = [`Removed ${removed.length} unreferenced files:`, ...removed.map((filePath) => `  ${filePath}`)];
    return { success: true, output: lines.join("\n") };
  } catch (error: any) {
    return { success: false, output: error?.message ?? String(error) };
  }
}
