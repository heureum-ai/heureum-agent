/**
 * Add a new slide to an unpacked PPTX directory.
 * Ported from skills/pptx/scripts/add_slide.py
 */
import * as fs from "fs";
import * as path from "path";

function getNextSlideNumber(slidesDir: string): number {
  const existing: number[] = [];
  for (const fileName of fs.readdirSync(slidesDir)) {
    const match = fileName.match(/^slide(\d+)\.xml$/);
    if (match) existing.push(Number(match[1]));
  }
  return existing.length > 0 ? Math.max(...existing) + 1 : 1;
}

function parseAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\S+)=(["'])(.*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrText)) !== null) {
    attrs[match[1]] = match[3];
  }
  return attrs;
}

function addToContentTypes(unpackedDir: string, destSlideName: string): void {
  const contentTypesPath = path.join(unpackedDir, "[Content_Types].xml");
  if (!fs.existsSync(contentTypesPath)) return;

  let content = fs.readFileSync(contentTypesPath, "utf-8");
  const partName = `/ppt/slides/${destSlideName}`;
  if (content.includes(partName)) return;

  const override =
    `<Override PartName="${partName}" ` +
    'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>';
  content = content.replace("</Types>", `  ${override}\n</Types>`);
  fs.writeFileSync(contentTypesPath, content, "utf-8");
}

function addToPresentationRels(unpackedDir: string, destSlideName: string): string {
  const relsPath = path.join(unpackedDir, "ppt", "_rels", "presentation.xml.rels");
  if (!fs.existsSync(relsPath)) {
    throw new Error(`Error: ${relsPath} not found`);
  }

  let rels = fs.readFileSync(relsPath, "utf-8");
  const ridMatches = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const nextRid = ridMatches.length > 0 ? Math.max(...ridMatches) + 1 : 1;
  const rid = `rId${nextRid}`;

  if (!rels.includes(`slides/${destSlideName}`)) {
    const newRel =
      `<Relationship Id="${rid}" ` +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" ' +
      `Target="slides/${destSlideName}"/>`;
    rels = rels.replace("</Relationships>", `  ${newRel}\n</Relationships>`);
    fs.writeFileSync(relsPath, rels, "utf-8");
  }

  return rid;
}

function getNextSlideId(unpackedDir: string): number {
  const presentationPath = path.join(unpackedDir, "ppt", "presentation.xml");
  if (!fs.existsSync(presentationPath)) {
    throw new Error(`Error: ${presentationPath} not found`);
  }

  const content = fs.readFileSync(presentationPath, "utf-8");
  const ids = [...content.matchAll(/<p:sldId[^>]*id="(\d+)"/g)].map((m) => Number(m[1]));
  return ids.length > 0 ? Math.max(...ids) + 1 : 256;
}

function removeNotesRelationship(relsXml: string): string {
  return relsXml.replace(/\s*<Relationship[^>]*Type="[^"]*notesSlide"[^>]*\/?>\s*/g, "\n");
}

function createSlideFromLayout(unpackedDir: string, layoutFile: string): string {
  const slidesDir = path.join(unpackedDir, "ppt", "slides");
  const relsDir = path.join(slidesDir, "_rels");
  const layoutsDir = path.join(unpackedDir, "ppt", "slideLayouts");

  const layoutPath = path.join(layoutsDir, layoutFile);
  if (!fs.existsSync(layoutPath)) {
    throw new Error(`Error: ${layoutPath} not found`);
  }

  const nextNum = getNextSlideNumber(slidesDir);
  const dest = `slide${nextNum}.xml`;
  const destSlide = path.join(slidesDir, dest);
  const destRels = path.join(relsDir, `${dest}.rels`);

  const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr>
    <a:masterClrMapping/>
  </p:clrMapOvr>
</p:sld>`;

  fs.mkdirSync(slidesDir, { recursive: true });
  fs.mkdirSync(relsDir, { recursive: true });

  fs.writeFileSync(destSlide, slideXml, "utf-8");

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/${layoutFile}"/>
</Relationships>`;
  fs.writeFileSync(destRels, relsXml, "utf-8");

  addToContentTypes(unpackedDir, dest);
  const rid = addToPresentationRels(unpackedDir, dest);
  const nextSlideId = getNextSlideId(unpackedDir);

  return `Created ${dest} from ${layoutFile}\nAdd to presentation.xml <p:sldIdLst>: <p:sldId id="${nextSlideId}" r:id="${rid}"/>`;
}

function duplicateSlide(unpackedDir: string, sourceSlideFile: string): string {
  const slidesDir = path.join(unpackedDir, "ppt", "slides");
  const relsDir = path.join(slidesDir, "_rels");

  const sourceSlide = path.join(slidesDir, sourceSlideFile);
  if (!fs.existsSync(sourceSlide)) {
    throw new Error(`Error: ${sourceSlide} not found`);
  }

  const nextNum = getNextSlideNumber(slidesDir);
  const dest = `slide${nextNum}.xml`;
  const destSlide = path.join(slidesDir, dest);

  const sourceRels = path.join(relsDir, `${sourceSlideFile}.rels`);
  const destRels = path.join(relsDir, `${dest}.rels`);

  fs.copyFileSync(sourceSlide, destSlide);

  if (fs.existsSync(sourceRels)) {
    fs.copyFileSync(sourceRels, destRels);
    const relsContent = fs.readFileSync(destRels, "utf-8");
    fs.writeFileSync(destRels, removeNotesRelationship(relsContent), "utf-8");
  }

  addToContentTypes(unpackedDir, dest);
  const rid = addToPresentationRels(unpackedDir, dest);
  const nextSlideId = getNextSlideId(unpackedDir);

  return `Created ${dest} from ${sourceSlideFile}\nAdd to presentation.xml <p:sldIdLst>: <p:sldId id="${nextSlideId}" r:id="${rid}"/>`;
}

export function parseSource(source: string): { kind: "layout" | "slide"; layoutFile: string | null } {
  if (source.startsWith("slideLayout") && source.endsWith(".xml")) {
    return { kind: "layout", layoutFile: source };
  }
  return { kind: "slide", layoutFile: null };
}

export function addSlide(unpackedDir: string, source: string): { success: boolean; output: string } {
  if (!fs.existsSync(unpackedDir)) {
    return { success: false, output: `Error: ${unpackedDir} not found` };
  }

  try {
    const parsed = parseSource(source);
    if (parsed.kind === "layout" && parsed.layoutFile) {
      return { success: true, output: createSlideFromLayout(unpackedDir, parsed.layoutFile) };
    }
    return { success: true, output: duplicateSlide(unpackedDir, source) };
  } catch (error: any) {
    return { success: false, output: error?.message ?? String(error) };
  }
}

export function parseRelationshipTagAttributes(tag: string): Record<string, string> {
  const m = tag.match(/^<Relationship\b([^>]*)\/?>$/);
  if (!m) return {};
  return parseAttrs(m[1]);
}
