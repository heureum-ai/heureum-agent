import * as fs from "fs";
import * as path from "path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { fixture } from "../helpers";

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_TYPE_WORKSHEET = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const REL_TYPE_DRAWING = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const REL_TYPE_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const CONTENT_TYPE_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
const CONTENT_TYPE_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
  processEntities: false,
});

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function buildXml(doc: Record<string, unknown>): string {
  return `${XML_DECL}\n${builder.build(doc)}`;
}

function normalizeTargetPath(target: string): string {
  const withoutLeadingSlash = target.replace(/^\//, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);
  return normalized.replace(/^\.\//, "");
}

function quoteSheetName(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  return `'${name.replaceAll("'", "''")}'`;
}

function decodeXmlEntity(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function parseRid(value: string | undefined): number {
  if (!value) return 0;
  const m = /^rId(\d+)$/.exec(value);
  return m ? Number(m[1]) : 0;
}

function nextPartIndex(zip: JSZip, dir: string, baseName: string): number {
  const prefix = `${dir}/${baseName}`;
  const suffix = ".xml";
  let max = 0;
  for (const fileName of Object.keys(zip.files)) {
    if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) continue;
    const between = fileName.slice(prefix.length, fileName.length - suffix.length);
    const n = Number(between);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

async function resolveWorksheetPath(
  zip: JSZip,
  sheetName: string
): Promise<string> {
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !workbookRelsXml) {
    throw new Error("Missing workbook.xml or workbook.xml.rels");
  }

  const workbook = parser.parse(workbookXml) as Record<string, any>;
  const workbookRels = parser.parse(workbookRelsXml) as Record<string, any>;

  const sheets = toArray((workbook.workbook?.sheets as Record<string, unknown> | undefined)?.sheet as any);
  const relEntries = toArray((workbookRels.Relationships as Record<string, unknown> | undefined)?.Relationship as any);
  const ridToTarget = new Map<string, string>();
  for (const relEntry of relEntries) {
    const rel = relEntry as Record<string, string>;
    const rid = rel["@_Id"];
    const target = rel["@_Target"];
    const type = rel["@_Type"];
    if (rid && target && type === REL_TYPE_WORKSHEET) {
      ridToTarget.set(rid, normalizeTargetPath(target));
    }
  }

  for (const sheetEntry of sheets) {
    const sheet = sheetEntry as Record<string, string>;
    const rawName = sheet["@_name"] ?? "";
    const normalizedName = decodeXmlEntity(rawName);
    if (normalizedName !== sheetName) continue;
    const rid = sheet["@_r:id"];
    const target = rid ? ridToTarget.get(rid) : undefined;
    if (target) return path.posix.join("xl", target);
  }

  throw new Error(`Sheet not found: ${sheetName}`);
}

function ensureContentTypeOverrides(
  contentTypesXml: string,
  overrides: Array<{ partName: string; contentType: string }>
): string {
  const parsed = parser.parse(contentTypesXml) as Record<string, any>;
  const types = (parsed.Types ?? {}) as Record<string, unknown>;
  const overrideItems = toArray(types.Override as any) as Array<Record<string, string>>;

  for (const item of overrides) {
    const exists = overrideItems.some(
      (entry) =>
        entry["@_PartName"] === item.partName &&
        entry["@_ContentType"] === item.contentType
    );
    if (!exists) {
      overrideItems.push({
        "@_PartName": item.partName,
        "@_ContentType": item.contentType,
      });
    }
  }

  types["@_xmlns"] = CONTENT_TYPES_NS;
  types.Override = overrideItems;
  parsed.Types = types;
  return buildXml(parsed);
}

function ensureDrawingRelationship(
  relsXml: string | undefined,
  drawingTarget: string
): { relsXml: string; drawingRelId: string } {
  const parsed = relsXml
    ? (parser.parse(relsXml) as Record<string, any>)
    : ({ Relationships: { "@_xmlns": REL_NS, Relationship: [] } } as Record<string, any>);

  const relationships = (parsed.Relationships ?? {}) as Record<string, unknown>;
  const relItems = toArray(relationships.Relationship as any) as Array<Record<string, string>>;

  const existing = relItems.find(
    (entry) =>
      entry["@_Type"] === REL_TYPE_DRAWING && entry["@_Target"] === drawingTarget
  );
  if (existing) {
    relationships["@_xmlns"] = REL_NS;
    relationships.Relationship = relItems;
    parsed.Relationships = relationships;
    return { relsXml: buildXml(parsed), drawingRelId: existing["@_Id"] };
  }

  const maxRid = relItems.reduce((max, entry) => {
    const n = parseRid(entry["@_Id"]);
    return n > max ? n : max;
  }, 0);
  const drawingRelId = `rId${maxRid + 1}`;

  relItems.push({
    "@_Id": drawingRelId,
    "@_Type": REL_TYPE_DRAWING,
    "@_Target": drawingTarget,
  });

  relationships["@_xmlns"] = REL_NS;
  relationships.Relationship = relItems;
  parsed.Relationships = relationships;
  return { relsXml: buildXml(parsed), drawingRelId };
}

function appendWorksheetDrawing(sheetXml: string, drawingRelId: string): string {
  if (sheetXml.includes("<drawing ")) return sheetXml;
  const insert = `  <drawing r:id="${drawingRelId}"/>\n`;
  if (sheetXml.includes("</worksheet>")) {
    return sheetXml.replace("</worksheet>", `${insert}</worksheet>`);
  }
  throw new Error("Invalid worksheet XML: missing </worksheet>");
}

function buildChartXml(params: {
  sheetName: string;
  categoryRange: string;
  valueRange: string;
  title: string;
}): string {
  const qualifiedSheet = quoteSheetName(params.sheetName);
  const catFormula = `${qualifiedSheet}!${params.categoryRange}`;
  const valFormula = `${qualifiedSheet}!${params.valueRange}`;
  return `${XML_DECL}
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    <c:title>
      <c:tx>
        <c:rich>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:r><a:t>${params.title}</a:t></a:r>
          </a:p>
        </c:rich>
      </c:tx>
    </c:title>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:v>Series 1</c:v></c:tx>
          <c:cat><c:strRef><c:f>${catFormula}</c:f></c:strRef></c:cat>
          <c:val><c:numRef><c:f>${valFormula}</c:f></c:numRef></c:val>
        </c:ser>
        <c:axId val="48650112"/>
        <c:axId val="48672768"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="48650112"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:axPos val="b"/>
        <c:tickLblPos val="nextTo"/>
        <c:crossAx val="48672768"/>
        <c:crosses val="autoZero"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="48672768"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:axPos val="l"/>
        <c:majorGridlines/>
        <c:numFmt formatCode="General" sourceLinked="1"/>
        <c:tickLblPos val="nextTo"/>
        <c:crossAx val="48650112"/>
        <c:crosses val="autoZero"/>
      </c:valAx>
    </c:plotArea>
    <c:plotVisOnly val="1"/>
  </c:chart>
</c:chartSpace>`;
}

function buildDrawingXml(chartRelId: string): string {
  return `${XML_DECL}
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <xdr:twoCellAnchor>
    <xdr:from>
      <xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff>
      <xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff>
    </xdr:from>
    <xdr:to>
      <xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff>
      <xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff>
    </xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="Chart 1"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${chartRelId}"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;
}

function buildDrawingRelsXml(chartTarget: string): string {
  return `${XML_DECL}
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${REL_TYPE_CHART}" Target="${chartTarget}"/>
</Relationships>`;
}

async function injectBarChartByOoxml(
  xlsxPath: string,
  params: {
    sheetName: string;
    categoryRange: string;
    valueRange: string;
    title: string;
  }
): Promise<{ chartPath: string; drawingPath: string }> {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(xlsxPath));

  const worksheetPath = await resolveWorksheetPath(zip, params.sheetName);
  const worksheetDir = path.posix.dirname(worksheetPath);
  const worksheetFile = path.posix.basename(worksheetPath);
  const worksheetRelsPath = path.posix.join(worksheetDir, "_rels", `${worksheetFile}.rels`);

  const drawingIndex = nextPartIndex(zip, "xl/drawings", "drawing");
  const chartIndex = nextPartIndex(zip, "xl/charts", "chart");
  const drawingPath = `xl/drawings/drawing${drawingIndex}.xml`;
  const drawingRelsPath = `xl/drawings/_rels/drawing${drawingIndex}.xml.rels`;
  const chartPath = `xl/charts/chart${chartIndex}.xml`;

  const contentTypesXml = await zip.file("[Content_Types].xml")?.async("string");
  if (!contentTypesXml) throw new Error("Missing [Content_Types].xml");
  zip.file(
    "[Content_Types].xml",
    ensureContentTypeOverrides(contentTypesXml, [
      { partName: `/${drawingPath}`, contentType: CONTENT_TYPE_DRAWING },
      { partName: `/${chartPath}`, contentType: CONTENT_TYPE_CHART },
    ])
  );

  const drawingTarget = path.posix.relative(worksheetDir, drawingPath);
  const worksheetRelsXml = await zip.file(worksheetRelsPath)?.async("string");
  const { relsXml, drawingRelId } = ensureDrawingRelationship(worksheetRelsXml, drawingTarget);
  zip.file(worksheetRelsPath, relsXml);

  const worksheetXml = await zip.file(worksheetPath)?.async("string");
  if (!worksheetXml) throw new Error(`Missing ${worksheetPath}`);
  zip.file(worksheetPath, appendWorksheetDrawing(worksheetXml, drawingRelId));

  const chartTarget = path.posix.relative(path.posix.dirname(drawingPath), chartPath);
  zip.file(chartPath, buildChartXml(params));
  zip.file(drawingPath, buildDrawingXml("rId1"));
  zip.file(drawingRelsPath, buildDrawingRelsXml(chartTarget));

  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.promises.writeFile(xlsxPath, output);
  return { chartPath, drawingPath };
}

describe("Preview: no-soffice chart injection", () => {
  it("can inject chart OOXML directly without soffice", async () => {
    const outputPath = fixture("preview_chart_ooxml.xlsx");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Category", "Value"]);
    ws.addRow(["A", 10]);
    ws.addRow(["B", 20]);
    ws.addRow(["C", 30]);
    await wb.xlsx.writeFile(outputPath);

    const inserted = await injectBarChartByOoxml(outputPath, {
      sheetName: "Sheet1",
      categoryRange: "$A$2:$A$4",
      valueRange: "$B$2:$B$4",
      title: "Preview Chart",
    });

    const zip = await JSZip.loadAsync(await fs.promises.readFile(outputPath));
    const chartXml = await zip.file(inserted.chartPath)?.async("string");
    const drawingXml = await zip.file(inserted.drawingPath)?.async("string");
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")?.async("string");
    const sheetRelsXml = await zip.file("xl/worksheets/_rels/sheet1.xml.rels")?.async("string");
    const contentTypesXml = await zip.file("[Content_Types].xml")?.async("string");

    expect(chartXml).toContain("<c:barChart>");
    expect(drawingXml).toContain("graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"");
    expect(sheetXml).toContain("<drawing r:id=");
    expect(sheetRelsXml).toContain(REL_TYPE_DRAWING);
    expect(contentTypesXml).toContain(CONTENT_TYPE_CHART);
    expect(contentTypesXml).toContain(CONTENT_TYPE_DRAWING);

    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(outputPath);
    expect(reopened.getWorksheet("Sheet1")).toBeDefined();
  });

  it("quotes worksheet names correctly in chart formulas", async () => {
    const outputPath = fixture("preview_chart_ooxml_quoted_sheet.xlsx");

    const wb = new ExcelJS.Workbook();
    const sheetName = "Sales O'Brien 2026";
    const ws = wb.addWorksheet(sheetName);
    ws.addRow(["Category", "Value"]);
    ws.addRow(["A", 100]);
    ws.addRow(["B", 200]);
    ws.addRow(["C", 300]);
    await wb.xlsx.writeFile(outputPath);

    const inserted = await injectBarChartByOoxml(outputPath, {
      sheetName,
      categoryRange: "$A$2:$A$4",
      valueRange: "$B$2:$B$4",
      title: "Quoted Sheet Name",
    });

    const zip = await JSZip.loadAsync(await fs.promises.readFile(outputPath));
    const chartXml = await zip.file(inserted.chartPath)?.async("string");
    expect(chartXml).toContain("<c:f>'Sales O''Brien 2026'!$A$2:$A$4</c:f>");
    expect(chartXml).toContain("<c:f>'Sales O''Brien 2026'!$B$2:$B$4</c:f>");
  });
});
