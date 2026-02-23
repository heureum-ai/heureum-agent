import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import {
  PdfPipeline,
  PDF_STEP_INTERMEDIATE,
  PDF_STEP_OUTPUT,
  PDF_STEP_PARSED,
  PDF_STEP_SOURCE,
  pdfPipelineFromTaskDir,
} from "./pipeline";
import type { PdfHandlerResult, PdfToolResult } from "./types";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


export type { PdfHandlerResult, PdfToolResult } from "./types";

type BaseFieldInfo = {
  field_id: string;
  page: number;
};

type TextFieldInfo = BaseFieldInfo & {
  type: "text";
  rect: [number, number, number, number];
};

type CheckboxFieldInfo = BaseFieldInfo & {
  type: "checkbox";
  checked_value: string;
  unchecked_value: string;
  rect: [number, number, number, number];
};

type ChoiceFieldInfo = BaseFieldInfo & {
  type: "choice";
  choice_options: Array<{ value: string; text: string }>;
  rect: [number, number, number, number];
};

type RadioGroupFieldInfo = BaseFieldInfo & {
  type: "radio_group";
  radio_options: Array<{ value: string; rect: [number, number, number, number] }>;
};

type UnknownFieldInfo = BaseFieldInfo & {
  type: `unknown (${string})`;
  rect: [number, number, number, number];
};

export type FieldInfo =
  | TextFieldInfo
  | CheckboxFieldInfo
  | ChoiceFieldInfo
  | RadioGroupFieldInfo
  | UnknownFieldInfo;

function toNum(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value && typeof (value as { asNumber?: () => number }).asNumber === "function") {
    const num = (value as { asNumber: () => number }).asNumber();
    if (Number.isFinite(num)) {
      return num;
    }
  }

  const num = Number(value);
  if (Number.isFinite(num)) {
    return num;
  }

  const parsed = parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

type RawFieldNode = {
  field_id: string;
  field_type: string | null;
  has_kids: boolean;
  field: PDFDict;
};

function toPdfValueString(value: unknown): string {
  if (value instanceof PDFName) {
    return value.toString();
  }
  if (value instanceof PDFHexString || value instanceof PDFString) {
    return value.decodeText();
  }
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    return (value as { toString: () => string }).toString();
  }
  return String(value ?? "");
}

function decodeFieldName(value: unknown): string | null {
  if (value instanceof PDFHexString || value instanceof PDFString) {
    return value.decodeText();
  }
  return null;
}

function asPdfArray(value: unknown): PDFArray | null {
  return value instanceof PDFArray ? value : null;
}

function asPdfDict(value: unknown): PDFDict | null {
  return value instanceof PDFDict ? value : null;
}

function getRectFromPdfArray(value: unknown): [number, number, number, number] {
  const arr = asPdfArray(value);
  if (!arr || arr.size() < 4) {
    return [0, 0, 0, 0];
  }
  return [
    toNum(arr.get(0)),
    toNum(arr.get(1)),
    toNum(arr.get(2)),
    toNum(arr.get(3)),
  ];
}

function collectRawFieldNodes(
  context: PDFDocument["context"],
  fieldDict: PDFDict,
  parentParts: string[],
  inheritedFieldType: string | null,
  out: RawFieldNode[]
): void {
  const ownName = decodeFieldName(fieldDict.lookup(PDFName.of("T")));
  const ownTypeObj = fieldDict.lookup(PDFName.of("FT"));
  const fieldType = ownTypeObj ? toPdfValueString(ownTypeObj) : inheritedFieldType;
  const nameParts = ownName ? [...parentParts, ownName] : parentParts;

  const kids = asPdfArray(fieldDict.lookup(PDFName.of("Kids")));
  const hasKids = !!kids && kids.size() > 0;

  if (ownName) {
    out.push({
      field_id: nameParts.join("."),
      field_type: fieldType,
      has_kids: hasKids,
      field: fieldDict,
    });
  }

  if (!kids) {
    return;
  }

  for (let i = 0; i < kids.size(); i++) {
    const kidRef = kids.get(i);
    const kidDict = asPdfDict(context.lookup(kidRef));
    if (!kidDict) {
      continue;
    }
    collectRawFieldNodes(context, kidDict, nameParts, fieldType, out);
  }
}

function getRawFieldNodes(pdfDoc: PDFDocument): RawFieldNode[] {
  const acroForm = asPdfDict(pdfDoc.catalog.lookup(PDFName.of("AcroForm")));
  if (!acroForm) {
    return [];
  }

  const fields = asPdfArray(acroForm.lookup(PDFName.of("Fields")));
  if (!fields) {
    return [];
  }

  const out: RawFieldNode[] = [];
  for (let i = 0; i < fields.size(); i++) {
    const fieldDict = asPdfDict(pdfDoc.context.lookup(fields.get(i)));
    if (!fieldDict) {
      continue;
    }
    collectRawFieldNodes(pdfDoc.context, fieldDict, [], null, out);
  }
  return out;
}

function getButtonStates(field: PDFDict): string[] {
  const ap = asPdfDict(field.lookup(PDFName.of("AP")));
  if (!ap) {
    return [];
  }

  const normal = asPdfDict(ap.lookup(PDFName.of("N")));
  if (!normal) {
    return [];
  }

  return normal.keys().map((key) => key.toString());
}

function getChoiceStates(field: PDFDict): Array<[string, string]> {
  const options = asPdfArray(field.lookup(PDFName.of("Opt")));
  if (!options) {
    return [];
  }

  const out: Array<[string, string]> = [];
  for (let i = 0; i < options.size(); i++) {
    const option = options.get(i);
    const pair = asPdfArray(option);
    if (pair && pair.size() >= 2) {
      out.push([toPdfValueString(pair.get(0)), toPdfValueString(pair.get(1))]);
      continue;
    }
    const value = toPdfValueString(option);
    out.push([value, value]);
  }
  return out;
}

function makeFieldDict(rawField: RawFieldNode): Record<string, any> {
  const fieldDict: Record<string, any> = { field_id: rawField.field_id };
  const fieldType = rawField.field_type;

  if (fieldType === "/Tx") {
    fieldDict.type = "text";
    return fieldDict;
  }

  if (fieldType === "/Btn") {
    fieldDict.type = "checkbox";
    const states = getButtonStates(rawField.field);
    if (states.length === 2) {
      if (states.includes("/Off")) {
        fieldDict.checked_value = states[0] !== "/Off" ? states[0] : states[1];
        fieldDict.unchecked_value = "/Off";
      } else {
        fieldDict.checked_value = states[0];
        fieldDict.unchecked_value = states[1];
      }
    }
    return fieldDict;
  }

  if (fieldType === "/Ch") {
    fieldDict.type = "choice";
    fieldDict.choice_options = getChoiceStates(rawField.field).map(([value, text]) => ({
      value,
      text,
    }));
    return fieldDict;
  }

  fieldDict.type = `unknown (${fieldType})`;
  return fieldDict;
}

function getFullAnnotationFieldId(annotation: PDFDict, context: PDFDocument["context"]): string | null {
  const parts: string[] = [];
  let current: PDFDict | null = annotation;

  while (current) {
    const fieldName = decodeFieldName(current.lookup(PDFName.of("T")));
    if (fieldName) {
      parts.push(fieldName);
    }
    const parent = current.lookup(PDFName.of("Parent"));
    current = asPdfDict(parent ? context.lookup(parent) : null);
  }

  if (parts.length === 0) {
    return null;
  }
  return parts.reverse().join(".");
}

function getAnnotationOnValues(annotation: PDFDict): string[] {
  const ap = asPdfDict(annotation.lookup(PDFName.of("AP")));
  if (!ap) {
    return [];
  }
  const normal = asPdfDict(ap.lookup(PDFName.of("N")));
  if (!normal) {
    return [];
  }
  return normal
    .keys()
    .map((key) => key.toString())
    .filter((value) => value !== "/Off");
}

function getFieldRect(field: FieldInfo): [number, number, number, number] {
  if (field.type === "radio_group") {
    return field.radio_options[0]?.rect ?? [0, 0, 0, 0];
  }
  return field.rect;
}

function compareByPageAndPosition(a: FieldInfo, b: FieldInfo): number {
  const aRect = getFieldRect(a);
  const bRect = getFieldRect(b);

  if (a.page !== b.page) return a.page - b.page;
  if (aRect[1] !== bRect[1]) return bRect[1] - aRect[1];
  return aRect[0] - bRect[0];
}

async function loadPdfjs(pdfPath: string): Promise<any> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array((await fs.promises.readFile(pdfPath)));
  return pdfjsLib.getDocument({ data }).promise;
}

export async function getFieldInfo(pdfPath: string): Promise<FieldInfo[]> {
  const pdfDoc = await PDFDocument.load((await fs.promises.readFile(pdfPath)));
  const rawFields = getRawFieldNodes(pdfDoc);

  const fieldInfoById = new Map<string, any>();
  const possibleRadioNames = new Set<string>();
  const radioFieldsById = new Map<string, Extract<FieldInfo, { type: "radio_group" }>>();

  for (const rawField of rawFields) {
    if (rawField.has_kids) {
      if (rawField.field_type === "/Btn") {
        possibleRadioNames.add(rawField.field_id);
      }
      continue;
    }
    fieldInfoById.set(rawField.field_id, makeFieldDict(rawField));
  }

  const pages = pdfDoc.getPages();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const annots = asPdfArray(pages[pageIndex].node.lookup(PDFName.of("Annots")));
    if (!annots) {
      continue;
    }

    for (let i = 0; i < annots.size(); i++) {
      const annotation = asPdfDict(pdfDoc.context.lookup(annots.get(i)));
      if (!annotation) {
        continue;
      }

      const fieldId = getFullAnnotationFieldId(annotation, pdfDoc.context);
      if (!fieldId) {
        continue;
      }

      if (fieldInfoById.has(fieldId)) {
        const existing = fieldInfoById.get(fieldId);
        existing.page = pageIndex + 1;
        existing.rect = getRectFromPdfArray(annotation.lookup(PDFName.of("Rect")));
        continue;
      }

      if (possibleRadioNames.has(fieldId)) {
        const onValues = getAnnotationOnValues(annotation);
        if (onValues.length !== 1) {
          continue;
        }
        if (!radioFieldsById.has(fieldId)) {
          radioFieldsById.set(fieldId, {
            field_id: fieldId,
            type: "radio_group",
            page: pageIndex + 1,
            radio_options: [],
          });
        }
        radioFieldsById.get(fieldId)!.radio_options.push({
          value: onValues[0],
          rect: getRectFromPdfArray(annotation.lookup(PDFName.of("Rect"))),
        });
      }
    }
  }

  const fieldsWithLocation = [...fieldInfoById.values()].filter((field) => field.page !== undefined);
  const all = [...fieldsWithLocation, ...radioFieldsById.values()] as FieldInfo[];
  all.sort(compareByPageAndPosition);
  return all;
}

export async function checkFillableFields(inputPdfPath: string): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const hasFillableFields = getRawFieldNodes(pdfDoc).length > 0;
    const output =
      hasFillableFields
        ? "This PDF has fillable form fields"
        : "This PDF does not have fillable form fields; you will need to visually determine where to enter data";
    return { success: true, output, statusCode: 0 };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function extractFormFieldInfo(
  inputPdfPath: string,
  outputJsonPath: string
): Promise<PdfToolResult> {
  try {
    const fieldInfo = await getFieldInfo(inputPdfPath);
    ;(await fs.promises.writeFile(outputJsonPath, JSON.stringify(fieldInfo, null, 2)));
    return {
      success: true,
      output: `Wrote ${fieldInfo.length} fields to ${outputJsonPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

type FieldValueInput = {
  field_id: string;
  page: number;
  value?: string;
};

function validationErrorForFieldValue(
  fieldInfo: FieldInfo,
  fieldValue: string
): string | null {
  const fieldType = fieldInfo.type;
  const fieldId = fieldInfo.field_id;

  if (fieldType === "checkbox") {
    const checkedVal = fieldInfo.checked_value;
    const uncheckedVal = fieldInfo.unchecked_value;
    if (fieldValue !== checkedVal && fieldValue !== uncheckedVal) {
      return `ERROR: Invalid value "${fieldValue}" for checkbox field "${fieldId}". The checked value is "${checkedVal}" and the unchecked value is "${uncheckedVal}"`;
    }
  } else if (fieldType === "radio_group") {
    const optionValues = fieldInfo.radio_options.map((option) => option.value);
    if (!optionValues.includes(fieldValue)) {
      const optionsText = `[${optionValues.map((value) => `'${value}'`).join(", ")}]`;
      return `ERROR: Invalid value "${fieldValue}" for radio group field "${fieldId}". Valid values are: ${optionsText}`;
    }
  } else if (fieldType === "choice") {
    const choiceValues = fieldInfo.choice_options.map((option) => option.value);
    if (!choiceValues.includes(fieldValue)) {
      const optionsText = `[${choiceValues.map((value) => `'${value}'`).join(", ")}]`;
      return `ERROR: Invalid value "${fieldValue}" for choice field "${fieldId}". Valid values are: ${optionsText}`;
    }
  }

  return null;
}

function removeNeedAppearances(pdfDoc: PDFDocument): void {
  const acroForm = pdfDoc.catalog.lookup(PDFName.of("AcroForm"));
  if (!acroForm || typeof (acroForm as any).delete !== "function") {
    return;
  }
  (acroForm as any).delete(PDFName.of("NeedAppearances"));
}

export async function fillFillableFields(
  inputPdfPath: string,
  fieldValuesJsonPath: string,
  outputPdfPath: string
): Promise<PdfToolResult> {
  try {
    const parsed = JSON.parse((await fs.promises.readFile(fieldValuesJsonPath, "utf-8"))) as FieldValueInput[];
    const fields = Array.isArray(parsed) ? parsed : [];

    const fieldInfo = await getFieldInfo(inputPdfPath);
    const fieldsById = new Map(fieldInfo.map((field) => [field.field_id, field]));

    const errors: string[] = [];
    for (const field of fields) {
      const existingField = fieldsById.get(field.field_id);
      if (!existingField) {
        errors.push(`ERROR: \`${field.field_id}\` is not a valid field ID`);
        continue;
      }

      if (field.page !== existingField.page) {
        errors.push(
          `ERROR: Incorrect page number for \`${field.field_id}\` (got ${field.page}, expected ${existingField.page})`
        );
        continue;
      }

      if (field.value !== undefined) {
        const validationError = validationErrorForFieldValue(existingField, field.value);
        if (validationError) {
          errors.push(validationError);
        }
      }
    }

    if (errors.length > 0) {
      return { success: false, output: errors.join("\n"), statusCode: 1 };
    }

    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const form = pdfDoc.getForm();

    const valueById = new Map<string, string>();
    for (const field of fields) {
      if (field.value !== undefined) {
        valueById.set(field.field_id, field.value);
      }
    }

    for (const formField of form.getFields()) {
      const name = formField.getName();
      if (!valueById.has(name)) continue;

      const value = valueById.get(name)!;
      const info = fieldsById.get(name);

      if (formField instanceof PDFTextField) {
        formField.setText(value);
      } else if (formField instanceof PDFCheckBox) {
        if (info && info.type === "checkbox" && value === info.checked_value) {
          formField.check();
        } else {
          formField.uncheck();
        }
      } else if (formField instanceof PDFRadioGroup) {
        const options = formField.getOptions();
        let selectedValue = value;

        if (!options.includes(selectedValue)) {
          const normalized = selectedValue.startsWith("/") ? selectedValue.slice(1) : selectedValue;
          if (options.includes(normalized)) {
            selectedValue = normalized;
          } else if (options.includes(`/${normalized}`)) {
            selectedValue = `/${normalized}`;
          } else if (/^\d+$/.test(normalized)) {
            const idx = Number(normalized);
            if (idx >= 0 && idx < options.length) {
              selectedValue = options[idx];
            } else if (idx >= 1 && idx <= options.length) {
              selectedValue = options[idx - 1];
            }
          }
        }

        formField.select(selectedValue);
      } else if (formField instanceof PDFDropdown || formField instanceof PDFOptionList) {
        formField.select(value);
      }
    }

    form.updateFieldAppearances();
    removeNeedAppearances(pdfDoc);

    ;(await fs.promises.writeFile(outputPdfPath, await pdfDoc.save()));

    return { success: true, output: "", statusCode: 0 };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

type EntryText = {
  text?: string;
  font?: string;
  font_size?: number;
  font_color?: string;
};

type AnnotationField = {
  page_number: number;
  label_bounding_box: [number, number, number, number];
  entry_bounding_box: [number, number, number, number];
  description?: string;
  entry_text?: EntryText;
};

type AnnotationJson = {
  pages: Array<{
    page_number: number;
    image_width?: number;
    image_height?: number;
    pdf_width?: number;
    pdf_height?: number;
  }>;
  form_fields: AnnotationField[];
  font_path?: string;
};

function transformFromImageCoords(
  bbox: [number, number, number, number],
  imageWidth: number,
  imageHeight: number,
  pdfWidth: number,
  pdfHeight: number
): [number, number, number, number] {
  const xScale = pdfWidth / imageWidth;
  const yScale = pdfHeight / imageHeight;

  const left = bbox[0] * xScale;
  const right = bbox[2] * xScale;
  const top = pdfHeight - bbox[1] * yScale;
  const bottom = pdfHeight - bbox[3] * yScale;

  return [left, bottom, right, top];
}

function transformFromPdfCoords(
  bbox: [number, number, number, number],
  pdfHeight: number
): [number, number, number, number] {
  const left = bbox[0];
  const right = bbox[2];
  const top = pdfHeight - bbox[1];
  const bottom = pdfHeight - bbox[3];
  return [left, bottom, right, top];
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "").padEnd(6, "0").slice(0, 6);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function hasNonAscii(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

function addFreeTextAnnotation(
  pdfDoc: PDFDocument,
  page: any,
  rect: [number, number, number, number],
  text: string,
  fontSize: number,
  fontColorHex: string,
  fontName: string,
  embeddedFont?: any,
  embeddedFontKey?: string
): void {
  const [r, g, b] = hexToRgb01(fontColorHex);
  const [x1, y1, x2, y2] = rect;

  const daFontRef = embeddedFontKey ?? fontName;
  const daString = `/${daFontRef} ${fontSize} Tf ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)} rg`;

  const annotDict: Record<string, any> = {
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("FreeText"),
    Rect: pdfDoc.context.obj([
      PDFNumber.of(x1),
      PDFNumber.of(y1),
      PDFNumber.of(x2),
      PDFNumber.of(y2),
    ]),
    Contents: PDFHexString.fromText(text),
    DA: PDFHexString.fromText(daString),
    Border: pdfDoc.context.obj([PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0)]),
    C: pdfDoc.context.obj([PDFNumber.of(r), PDFNumber.of(g), PDFNumber.of(b)]),
  };

  if (embeddedFont && embeddedFontKey) {
    const boxWidth = Math.abs(x2 - x1);
    const boxHeight = Math.abs(y2 - y1);
    const lines: string[] = [];
    let currentLine = "";
    for (const char of text) {
      const testLine = currentLine + char;
      const testWidth = embeddedFont.widthOfTextAtSize(testLine, fontSize);
      if (testWidth > boxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineHeight = fontSize * 1.2;
    const totalTextHeight = lines.length * lineHeight;
    const startY = boxHeight - fontSize;

    let streamContent = `BT\n/${embeddedFontKey} ${fontSize} Tf\n${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)} rg\n`;
    for (let i = 0; i < lines.length; i++) {
      const lineY = startY - i * lineHeight;
      if (lineY < 0) break;
      const encodedText = embeddedFont.encodeText(lines[i]);
      streamContent += `0 ${lineY.toFixed(2)} Td\n<${Buffer.from(encodedText).toString("hex")}> Tj\n`;
      if (i < lines.length - 1) {
        streamContent += `0 ${(-lineHeight).toFixed(2)} Td\n`;
      }
    }
    streamContent += "ET";

    const fontDictRef = (embeddedFont as any).ref;
    const resources = pdfDoc.context.obj({
      Font: pdfDoc.context.obj({
        [embeddedFontKey]: fontDictRef,
      }),
    });

    const apStream = pdfDoc.context.stream(streamContent, {
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Form"),
      BBox: pdfDoc.context.obj([PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(boxWidth), PDFNumber.of(boxHeight)]),
      Resources: resources,
    });
    const apStreamRef = pdfDoc.context.register(apStream);

    annotDict.AP = pdfDoc.context.obj({ N: apStreamRef });
  }

  const annotation = pdfDoc.context.obj(annotDict);
  const annotationRef = pdfDoc.context.register(annotation);
  page.node.addAnnot(annotationRef);
}

export async function fillPdfFormWithAnnotations(
  inputPdfPath: string,
  fieldsJsonPath: string,
  outputPdfPath: string,
  fontPath?: string
): Promise<PdfToolResult> {
  try {
    const fieldsData = JSON.parse((await fs.promises.readFile(fieldsJsonPath, "utf-8"))) as AnnotationJson;
    const effectiveFontPath = fontPath ?? fieldsData.font_path;

    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const pages = pdfDoc.getPages();

    const needsCustomFont = fieldsData.form_fields.some((field) => {
      const text = String(field.entry_text?.text ?? "");
      return hasNonAscii(text);
    });

    let embeddedFont: any = undefined;
    let embeddedFontKey: string | undefined = undefined;

    if (needsCustomFont && effectiveFontPath) {
      pdfDoc.registerFontkit(fontkit);
      const fontBytes = (await fs.promises.readFile(effectiveFontPath));
      embeddedFont = await pdfDoc.embedFont(fontBytes, { subset: false });
      embeddedFontKey = "F1";
    } else if (needsCustomFont && !effectiveFontPath) {
      return {
        success: false,
        output: "Non-ASCII characters detected in text but no font_path provided. Please provide a font_path for CJK/non-ASCII text rendering.",
        statusCode: 1,
      };
    }

    let annotationCount = 0;

    for (const field of fieldsData.form_fields) {
      const pageNum = field.page_number;
      const page = pages[pageNum - 1];
      if (!page) continue;

      const pageInfo = fieldsData.pages.find((pageItem) => pageItem.page_number === pageNum);
      if (!pageInfo) continue;

      const { width: pdfWidth, height: pdfHeight } = page.getSize();

      let transformedEntryBox: [number, number, number, number];
      if ("pdf_width" in pageInfo) {
        transformedEntryBox = transformFromPdfCoords(field.entry_bounding_box, pdfHeight);
      } else {
        const imageWidth = toNum(pageInfo.image_width);
        const imageHeight = toNum(pageInfo.image_height);
        if (imageWidth <= 0 || imageHeight <= 0) continue;

        transformedEntryBox = transformFromImageCoords(
          field.entry_bounding_box,
          imageWidth,
          imageHeight,
          pdfWidth,
          pdfHeight
        );
      }

      const entryText = field.entry_text;
      const text = String(entryText?.text ?? "");
      if (!text) continue;

      const fontSize = toNum(entryText?.font_size, 14);
      const fontColor = String(entryText?.font_color ?? "000000");
      const fontName = String(entryText?.font ?? "Helvetica");

      const useCustomFont = hasNonAscii(text) && embeddedFont;

      addFreeTextAnnotation(
        pdfDoc,
        page,
        transformedEntryBox,
        text,
        fontSize,
        fontColor,
        fontName,
        useCustomFont ? embeddedFont : undefined,
        useCustomFont ? embeddedFontKey : undefined
      );
      annotationCount += 1;
    }

    ;(await fs.promises.writeFile(outputPdfPath, await pdfDoc.save()));

    return {
      success: true,
      output:
        `Successfully filled PDF form and saved to ${outputPdfPath}\n` +
        `Added ${annotationCount} text annotations`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

type FormStructure = {
  pages: Array<{ page_number: number; width: number; height: number }>;
  labels: Array<{ page: number; text: string; x0: number; top: number; x1: number; bottom: number }>;
  lines: Array<{ page: number; y: number; x0: number; x1: number }>;
  checkboxes: Array<{
    page: number;
    x0: number;
    top: number;
    x1: number;
    bottom: number;
    center_x: number;
    center_y: number;
  }>;
  row_boundaries: Array<{ page: number; row_top: number; row_bottom: number; row_height: number }>;
};

function multiplyMatrix(
  m1: [number, number, number, number, number, number],
  m2: [number, number, number, number, number, number]
): [number, number, number, number, number, number] {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function applyMatrix(
  m: [number, number, number, number, number, number],
  x: number,
  y: number
): [number, number] {
  const [a, b, c, d, e, f] = m;
  return [a * x + c * y + e, b * x + d * y + f];
}

export async function extractFormStructure(
  inputPdfPath: string,
  outputJsonPath: string
): Promise<PdfToolResult> {
  try {
    const structure: FormStructure = {
      pages: [],
      labels: [],
      lines: [],
      checkboxes: [],
      row_boundaries: [],
    };

    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array((await fs.promises.readFile(inputPdfPath))) }).promise;

    try {
      const lineKeys = new Set<string>();
      const checkboxKeys = new Set<string>();

      for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex++) {
        const pageNum = pageIndex + 1;
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const pageWidth = viewport.width;
        const pageHeight = viewport.height;

        structure.pages.push({
          page_number: pageNum,
          width: Number(pageWidth),
          height: Number(pageHeight),
        });

        const textContent = await page.getTextContent();
        const textItems = (textContent.items ?? []) as any[];

        for (const item of textItems) {
          const fullText = String(item?.str ?? "");
          if (!fullText.trim()) continue;

          const transform = Array.isArray(item?.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
          const x = toNum(transform[4]);
          const y = toNum(transform[5]);
          const itemWidth = toNum(item?.width, fullText.length * 6);
          const itemHeight = toNum(item?.height, Math.abs(toNum(transform[3], 10)) || 10);

          for (const match of fullText.matchAll(/\S+/g)) {
            const token = match[0];
            const start = match.index ?? 0;
            const end = start + token.length;

            const ratioStart = fullText.length > 0 ? start / fullText.length : 0;
            const ratioEnd = fullText.length > 0 ? end / fullText.length : 1;

            const x0 = x + ratioStart * itemWidth;
            const x1 = x + ratioEnd * itemWidth;
            const top = pageHeight - y;
            const bottom = top + itemHeight;

            structure.labels.push({
              page: pageNum,
              text: token,
              x0: round1(x0),
              top: round1(top),
              x1: round1(x1),
              bottom: round1(bottom),
            });
          }
        }

        const annotationMode = (pdfjsLib as any).AnnotationMode?.DISABLE ?? 0;
        const operatorList = await page.getOperatorList({ annotationMode });
        const reverseOps: Record<number, string> = {};
        for (const [name, code] of Object.entries(pdfjsLib.OPS as Record<string, number>)) {
          reverseOps[code] = name;
        }

        let currentMatrix: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
        const matrixStack: Array<[number, number, number, number, number, number]> = [];

        for (let i = 0; i < operatorList.fnArray.length; i++) {
          const fn = reverseOps[operatorList.fnArray[i]];
          if (!fn) continue;
          const args = operatorList.argsArray[i] as any[];

          if (fn === "save") {
            matrixStack.push([...currentMatrix] as [number, number, number, number, number, number]);
            continue;
          }

          if (fn === "restore") {
            currentMatrix = matrixStack.pop() ?? [1, 0, 0, 1, 0, 0];
            continue;
          }

          if (fn === "transform") {
            const m: [number, number, number, number, number, number] = [
              toNum(args?.[0]),
              toNum(args?.[1]),
              toNum(args?.[2]),
              toNum(args?.[3]),
              toNum(args?.[4]),
              toNum(args?.[5]),
            ];
            currentMatrix = multiplyMatrix(currentMatrix, m);
            continue;
          }

          if (fn !== "constructPath") continue;

          const bbox = args?.[2];
          if (!bbox || bbox.length < 4) continue;

          const bx0 = toNum(bbox[0]);
          const by0 = toNum(bbox[1]);
          const bx1 = toNum(bbox[2]);
          const by1 = toNum(bbox[3]);

          const corners = [
            applyMatrix(currentMatrix, bx0, by0),
            applyMatrix(currentMatrix, bx0, by1),
            applyMatrix(currentMatrix, bx1, by0),
            applyMatrix(currentMatrix, bx1, by1),
          ];

          const xs = corners.map((point) => point[0]);
          const ys = corners.map((point) => point[1]);

          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          const y0 = Math.min(...ys);
          const y1 = Math.max(...ys);

          const width = Math.abs(x1 - x0);
          const height = Math.abs(y1 - y0);

          if (width > pageWidth * 0.5 && height <= 2.0) {
            const yTop = round1(pageHeight - (y0 + y1) / 2);
            const lineKey = `${pageNum}:${round1(x0)}:${yTop}:${round1(x1)}`;
            if (!lineKeys.has(lineKey)) {
              lineKeys.add(lineKey);
              structure.lines.push({
                page: pageNum,
                y: yTop,
                x0: round1(x0),
                x1: round1(x1),
              });
            }
          }

          if (width >= 5 && width <= 15 && height >= 5 && height <= 15 && Math.abs(width - height) < 2) {
            const top = round1(pageHeight - y1);
            const bottom = round1(pageHeight - y0);
            const x0r = round1(x0);
            const x1r = round1(x1);
            const checkboxKey = `${pageNum}:${x0r}:${top}:${x1r}:${bottom}`;

            if (!checkboxKeys.has(checkboxKey)) {
              checkboxKeys.add(checkboxKey);
              structure.checkboxes.push({
                page: pageNum,
                x0: x0r,
                top,
                x1: x1r,
                bottom,
                center_x: round1((x0 + x1) / 2),
                center_y: round1((top + bottom) / 2),
              });
            }
          }
        }
      }

      const linesByPage = new Map<number, number[]>();
      for (const line of structure.lines) {
        if (!linesByPage.has(line.page)) {
          linesByPage.set(line.page, []);
        }
        linesByPage.get(line.page)!.push(line.y);
      }

      for (const [pageNum, yCoords] of linesByPage.entries()) {
        const uniqueSorted = [...new Set(yCoords)].sort((a, b) => a - b);
        for (let i = 0; i < uniqueSorted.length - 1; i++) {
          structure.row_boundaries.push({
            page: pageNum,
            row_top: uniqueSorted[i],
            row_bottom: uniqueSorted[i + 1],
            row_height: round1(uniqueSorted[i + 1] - uniqueSorted[i]),
          });
        }
      }

      ;(await fs.promises.writeFile(outputJsonPath, JSON.stringify(structure, null, 2)));

      const outputLines = [
        `Extracting structure from ${inputPdfPath}...`,
        "Found:",
        `  - ${structure.pages.length} pages`,
        `  - ${structure.labels.length} text labels`,
        `  - ${structure.lines.length} horizontal lines`,
        `  - ${structure.checkboxes.length} checkboxes`,
        `  - ${structure.row_boundaries.length} row boundaries`,
        `Saved to ${outputJsonPath}`,
      ];

      return { success: true, output: outputLines.join("\n"), statusCode: 0 };
    } finally {
      await doc.destroy();
    }
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

type RectAndField = {
  rect: [number, number, number, number];
  rect_type: "label" | "entry";
  field: AnnotationField;
};

function rectsIntersect(
  r1: [number, number, number, number],
  r2: [number, number, number, number]
): boolean {
  const disjointHorizontal = r1[0] >= r2[2] || r1[2] <= r2[0];
  const disjointVertical = r1[1] >= r2[3] || r1[3] <= r2[1];
  return !(disjointHorizontal || disjointVertical);
}

export function checkBoundingBoxes(fieldsJsonPath: string): PdfToolResult {
  try {
    const fields = JSON.parse(fs.readFileSync(fieldsJsonPath, "utf-8")) as AnnotationJson;
    const messages: string[] = [];

    messages.push(`Read ${fields.form_fields.length} fields`);

    const rectsAndFields: RectAndField[] = [];
    for (const field of fields.form_fields) {
      rectsAndFields.push({ rect: field.label_bounding_box, rect_type: "label", field });
      rectsAndFields.push({ rect: field.entry_bounding_box, rect_type: "entry", field });
    }

    let hasError = false;

    for (let i = 0; i < rectsAndFields.length; i++) {
      const ri = rectsAndFields[i];

      for (let j = i + 1; j < rectsAndFields.length; j++) {
        const rj = rectsAndFields[j];
        if (ri.field.page_number === rj.field.page_number && rectsIntersect(ri.rect, rj.rect)) {
          hasError = true;
          if (ri.field === rj.field) {
            messages.push(
              `FAILURE: intersection between label and entry bounding boxes for \`${ri.field.description}\` (${JSON.stringify(ri.rect)}, ${JSON.stringify(rj.rect)})`
            );
          } else {
            messages.push(
              `FAILURE: intersection between ${ri.rect_type} bounding box for \`${ri.field.description}\` (${JSON.stringify(ri.rect)}) and ${rj.rect_type} bounding box for \`${rj.field.description}\` (${JSON.stringify(rj.rect)})`
            );
          }

          if (messages.length >= 20) {
            messages.push("Aborting further checks; fix bounding boxes and try again");
            return { success: true, output: messages.join("\n"), statusCode: 0 };
          }
        }
      }

      if (ri.rect_type === "entry" && ri.field.entry_text) {
        const fontSize = toNum(ri.field.entry_text.font_size, 14);
        const entryHeight = ri.rect[3] - ri.rect[1];
        if (entryHeight < fontSize) {
          hasError = true;
          messages.push(
            `FAILURE: entry bounding box height (${entryHeight}) for \`${ri.field.description}\` is too short for the text content (font size: ${fontSize}). Increase the box height or decrease the font size.`
          );

          if (messages.length >= 20) {
            messages.push("Aborting further checks; fix bounding boxes and try again");
            return { success: true, output: messages.join("\n"), statusCode: 0 };
          }
        }
      }
    }

    if (!hasError) {
      messages.push("SUCCESS: All bounding boxes are valid");
    }

    return { success: true, output: messages.join("\n"), statusCode: 0 };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

function decodeBmp(buffer: Buffer): RgbaImage {
  const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const pixelOffset = dataView.getUint32(10, true);
  const headerSize = dataView.getUint32(14, true);
  const width = dataView.getInt32(18, true);
  const rawHeight = dataView.getInt32(22, true);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bitsPerPixel = dataView.getUint16(28, true);
  const compression = headerSize >= 20 ? dataView.getUint32(30, true) : 0;

  if (compression !== 0 && compression !== 3) {
    throw new Error(`Unsupported BMP compression: ${compression}`);
  }

  const data = new Uint8Array(width * height * 4);
  const bytesPerPixel = bitsPerPixel / 8;
  const rowStride = Math.ceil((width * bitsPerPixel) / 32) * 4;

  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    const rowOffset = pixelOffset + srcRow * rowStride;
    for (let x = 0; x < width; x++) {
      const srcIdx = rowOffset + x * bytesPerPixel;
      const dstIdx = (y * width + x) * 4;
      if (bitsPerPixel === 32) {
        data[dstIdx] = buffer[srcIdx + 2];
        data[dstIdx + 1] = buffer[srcIdx + 1];
        data[dstIdx + 2] = buffer[srcIdx];
        data[dstIdx + 3] = buffer[srcIdx + 3];
      } else if (bitsPerPixel === 24) {
        data[dstIdx] = buffer[srcIdx + 2];
        data[dstIdx + 1] = buffer[srcIdx + 1];
        data[dstIdx + 2] = buffer[srcIdx];
        data[dstIdx + 3] = 255;
      } else {
        throw new Error(`Unsupported BMP bit depth: ${bitsPerPixel}`);
      }
    }
  }

  return { width, height, data };
}

function decodeImage(imagePath: string): RgbaImage {
  const ext = path.extname(imagePath).toLowerCase();
  const buffer = fs.readFileSync(imagePath);

  if (ext === ".png") {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }

  if (ext === ".jpg" || ext === ".jpeg") {
    const decoded = jpeg.decode(buffer, { useTArray: true });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }

  if (ext === ".bmp") {
    return decodeBmp(buffer);
  }

  throw new Error(`Unsupported image format: ${ext}. Supported formats: .png, .jpg, .jpeg, .bmp`);
}

function encodeImage(image: RgbaImage, outputPath: string): void {
  const ext = path.extname(outputPath).toLowerCase();

  if (ext === ".png") {
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.data);
    fs.writeFileSync(outputPath, PNG.sync.write(png));
    return;
  }

  if (ext === ".jpg" || ext === ".jpeg") {
    fs.writeFileSync(outputPath, jpeg.encode({ width: image.width, height: image.height, data: image.data }, 95).data);
    return;
  }

  throw new Error(`Unsupported output image format: ${ext}`);
}

function setPixel(image: RgbaImage, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const idx = (y * image.width + x) * 4;
  image.data[idx] = r;
  image.data[idx + 1] = g;
  image.data[idx + 2] = b;
  image.data[idx + 3] = a;
}

function drawRectOutline(
  image: RgbaImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: [number, number, number],
  width = 1
): void {
  const left = Math.round(Math.min(x0, x1));
  const right = Math.round(Math.max(x0, x1));
  const top = Math.round(Math.min(y0, y1));
  const bottom = Math.round(Math.max(y0, y1));

  for (let offset = 0; offset < width; offset++) {
    const yTop = top + offset;
    const yBottom = bottom - offset;
    const xLeft = left + offset;
    const xRight = right - offset;

    for (let x = xLeft; x <= xRight; x++) {
      setPixel(image, x, yTop, color[0], color[1], color[2]);
      setPixel(image, x, yBottom, color[0], color[1], color[2]);
    }

    for (let y = yTop; y <= yBottom; y++) {
      setPixel(image, xLeft, y, color[0], color[1], color[2]);
      setPixel(image, xRight, y, color[0], color[1], color[2]);
    }
  }
}

export function createValidationImage(
  pageNumber: number,
  fieldsJsonPath: string,
  inputImagePath: string,
  outputImagePath: string
): PdfToolResult {
  try {
    const data = JSON.parse(fs.readFileSync(fieldsJsonPath, "utf-8")) as AnnotationJson;
    const image = decodeImage(inputImagePath);

    let numBoxes = 0;

    for (const field of data.form_fields) {
      if (field.page_number !== pageNumber) continue;
      drawRectOutline(
        image,
        field.entry_bounding_box[0],
        field.entry_bounding_box[1],
        field.entry_bounding_box[2],
        field.entry_bounding_box[3],
        [255, 0, 0],
        2
      );
      drawRectOutline(
        image,
        field.label_bounding_box[0],
        field.label_bounding_box[1],
        field.label_bounding_box[2],
        field.label_bounding_box[3],
        [0, 0, 255],
        2
      );
      numBoxes += 2;
    }

    encodeImage(image, outputImagePath);

    return {
      success: true,
      output: `Created validation image at ${outputImagePath} with ${numBoxes} bounding boxes`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cubicWeight(distance: number): number {
  const a = -0.5;
  const x = Math.abs(distance);

  if (x <= 1) {
    return (a + 2) * x * x * x - (a + 3) * x * x + 1;
  }
  if (x < 2) {
    return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
  }
  return 0;
}

const PRECISION_BITS = 32 - 8 - 2;
const FIXED_SCALE = 1 << PRECISION_BITS;
const FIXED_ROUND = 1 << (PRECISION_BITS - 1);

type PrecomputedKernel = {
  ksize: number;
  bounds: Int32Array;
  coeffs: Float64Array;
};

function precomputeKernel(inSize: number, outSize: number): PrecomputedKernel {
  const scale = inSize / outSize;
  const filterScale = Math.max(1, scale);
  const support = 2 * filterScale;
  const ksize = Math.ceil(support) * 2 + 1;

  const bounds = new Int32Array(outSize * 2);
  const coeffs = new Float64Array(outSize * ksize);

  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let ww = 0;
    const ss = 1 / filterScale;

    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;

    const rowOffset = xx * ksize;
    for (let x = 0; x < xmax; x++) {
      const w = cubicWeight((x + xmin - center + 0.5) * ss);
      coeffs[rowOffset + x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      if (ww !== 0) {
        coeffs[rowOffset + x] /= ww;
      }
    }
    for (let x = xmax; x < ksize; x++) {
      coeffs[rowOffset + x] = 0;
    }

    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }

  return { ksize, bounds, coeffs };
}

function normalizeFixedCoefficients(coeffs: Float64Array): Int32Array {
  const normalized = new Int32Array(coeffs.length);
  for (let i = 0; i < coeffs.length; i++) {
    const scaled = coeffs[i] * FIXED_SCALE;
    normalized[i] = scaled < 0 ? Math.trunc(-0.5 + scaled) : Math.trunc(0.5 + scaled);
  }
  return normalized;
}

function clip8Fixed(value: number): number {
  const shifted = Math.floor(value / FIXED_SCALE);
  return clamp(shifted, 0, 255);
}

function resizePngBicubic(inputPath: string, outputPath: string, width: number, height: number): void {
  const src = PNG.sync.read(fs.readFileSync(inputPath));
  if (src.width === width && src.height === height) {
    fs.writeFileSync(outputPath, PNG.sync.write(src));
    return;
  }

  const dst = new PNG({ width, height });
  const srcData = src.data;
  const dstData = dst.data;
  const kx = precomputeKernel(src.width, width);
  const ky = precomputeKernel(src.height, height);
  const kxFixed = normalizeFixedCoefficients(kx.coeffs);
  const kyFixed = normalizeFixedCoefficients(ky.coeffs);

  const tmp = new Uint8Array(src.height * width * 4);

  // Horizontal pass (matches Pillow: compute 8bpc intermediate)
  for (let y = 0; y < src.height; y++) {
    for (let xx = 0; xx < width; xx++) {
      const xmin = kx.bounds[xx * 2];
      const xmax = kx.bounds[xx * 2 + 1];
      const kOffset = xx * kx.ksize;
      let ss0 = FIXED_ROUND;
      let ss1 = FIXED_ROUND;
      let ss2 = FIXED_ROUND;
      let ss3 = FIXED_ROUND;

      for (let x = 0; x < xmax; x++) {
        const coeff = kxFixed[kOffset + x];
        const srcIdx = (y * src.width + (x + xmin)) * 4;
        ss0 += srcData[srcIdx] * coeff;
        ss1 += srcData[srcIdx + 1] * coeff;
        ss2 += srcData[srcIdx + 2] * coeff;
        ss3 += srcData[srcIdx + 3] * coeff;
      }

      const outIdx = (y * width + xx) * 4;
      tmp[outIdx] = clip8Fixed(ss0);
      tmp[outIdx + 1] = clip8Fixed(ss1);
      tmp[outIdx + 2] = clip8Fixed(ss2);
      tmp[outIdx + 3] = clip8Fixed(ss3);
    }
  }

  // Vertical pass on 8bpc intermediate
  for (let yy = 0; yy < height; yy++) {
    const ymin = ky.bounds[yy * 2];
    const ymax = ky.bounds[yy * 2 + 1];
    const kOffset = yy * ky.ksize;

    for (let x = 0; x < width; x++) {
      let ss0 = FIXED_ROUND;
      let ss1 = FIXED_ROUND;
      let ss2 = FIXED_ROUND;
      let ss3 = FIXED_ROUND;

      for (let y = 0; y < ymax; y++) {
        const coeff = kyFixed[kOffset + y];
        const tmpIdx = ((y + ymin) * width + x) * 4;
        ss0 += tmp[tmpIdx] * coeff;
        ss1 += tmp[tmpIdx + 1] * coeff;
        ss2 += tmp[tmpIdx + 2] * coeff;
        ss3 += tmp[tmpIdx + 3] * coeff;
      }

      const dstIdx = (yy * width + x) * 4;
      dstData[dstIdx] = clip8Fixed(ss0);
      dstData[dstIdx + 1] = clip8Fixed(ss1);
      dstData[dstIdx + 2] = clip8Fixed(ss2);
      dstData[dstIdx + 3] = clip8Fixed(ss3);
    }
  }

  fs.writeFileSync(outputPath, PNG.sync.write(dst));
}

function sortByTrailingNumber(paths: string[]): string[] {
  const extract = (value: string): number => {
    const match = value.match(/(\d+)(?!.*\d)/);
    return match ? Number(match[1]) : 0;
  };
  return [...paths].sort((a, b) => extract(a) - extract(b));
}

export function convertPdfToImages(
  inputPdfPath: string,
  outputDirectory: string,
  maxDim = 1000
): PdfToolResult {
  try {
    fs.mkdirSync(outputDirectory, { recursive: true });

    const tempPrefix = path.join(outputDirectory, "page");
    const convertResult = child_process.spawnSync(
      "pdftoppm",
      ["-png", "-r", "200", inputPdfPath, tempPrefix],
      { encoding: "utf-8" }
    );

    if (convertResult.status !== 0) {
      return {
        success: false,
        output: (convertResult.stderr || convertResult.stdout || "PDF conversion failed").trim(),
        statusCode: convertResult.status,
      };
    }

    const tempFiles = sortByTrailingNumber(
      fs
        .readdirSync(outputDirectory)
        .filter((name) => /^page-\d+\.png$/.test(name))
        .map((name) => path.join(outputDirectory, name))
    );

    const lines: string[] = [];

    for (let i = 0; i < tempFiles.length; i++) {
      const sourcePath = tempFiles[i];
      let png = PNG.sync.read(fs.readFileSync(sourcePath));
      let width = png.width;
      let height = png.height;
      let workingPath = sourcePath;

      if (width > maxDim || height > maxDim) {
        const scaleFactor = Math.min(maxDim / width, maxDim / height);
        const newWidth = Math.floor(width * scaleFactor);
        const newHeight = Math.floor(height * scaleFactor);

        const resizedPath = path.join(outputDirectory, `__resized_${i + 1}.png`);
        resizePngBicubic(sourcePath, resizedPath, newWidth, newHeight);
        fs.unlinkSync(sourcePath);
        workingPath = resizedPath;

        width = newWidth;
        height = newHeight;
      }

      const finalPath = path.join(outputDirectory, `page_${i + 1}.png`);
      fs.renameSync(workingPath, finalPath);

      lines.push(`Saved page ${i + 1} as ${finalPath} (size: (${width}, ${height}))`);
    }

    lines.push(`Converted ${tempFiles.length} pages to PNG images`);

    return {
      success: true,
      output: lines.join("\n"),
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// New PDF manipulation functions
// ---------------------------------------------------------------------------

export async function getPageCount(inputPdfPath: string): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const count = pdfDoc.getPageCount();
    return { success: true, output: JSON.stringify({ page_count: count }), statusCode: 0 };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function getMetadata(inputPdfPath: string): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const pages = pdfDoc.getPages().map((page, i) => {
      const { width, height } = page.getSize();
      const rotation = page.getRotation().angle;
      return { page_number: i + 1, width, height, rotation };
    });

    const metadata = {
      page_count: pdfDoc.getPageCount(),
      title: pdfDoc.getTitle() ?? null,
      author: pdfDoc.getAuthor() ?? null,
      subject: pdfDoc.getSubject() ?? null,
      creator: pdfDoc.getCreator() ?? null,
      producer: pdfDoc.getProducer() ?? null,
      creation_date: pdfDoc.getCreationDate()?.toISOString() ?? null,
      modification_date: pdfDoc.getModificationDate()?.toISOString() ?? null,
      pages,
    };

    return { success: true, output: JSON.stringify(metadata, null, 2), statusCode: 0 };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function extractStyles(
  inputPdfPath: string,
  options?: {
    pages?: number[];
    includeRuns?: boolean;
    maxRunsPerPage?: number;
  }
): Promise<PdfToolResult> {
  try {
    const doc = await loadPdfjs(inputPdfPath);
    try {
      const totalPages = doc.numPages;
      const pageList = options?.pages && options.pages.length > 0
        ? options.pages
        : Array.from({ length: totalPages }, (_, i) => i + 1);
      const includeRuns = options?.includeRuns ?? true;
      const maxRunsPerPage = Math.max(1, options?.maxRunsPerPage ?? 5000);

      const pages: Array<Record<string, unknown>> = [];
      let colorObserved = false;

      for (const pageNum of pageList) {
        if (pageNum < 1 || pageNum > totalPages) continue;
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1 });
        const textContent = await page.getTextContent();
        const items = (textContent.items ?? []) as any[];
        const styleMap = (textContent as any).styles ?? {};

        const runs: Array<Record<string, unknown>> = [];
        const lineMap = new Map<string, Array<{ x: number; text: string }>>();
        const fontUsage: Record<string, number> = {};
        const sizeUsage: Record<string, number> = {};
        let truncated = false;
        let totalRunCount = 0;

        for (const item of items) {
          const text = String(item?.str ?? "");
          if (!text) continue;

          const transform = Array.isArray(item?.transform) ? item.transform : [1, 0, 0, 1, 0, 0];
          const a = toNum(transform[0], 1);
          const b = toNum(transform[1], 0);
          const e = toNum(transform[4], 0);
          const f = toNum(transform[5], 0);
          const width = toNum(item?.width, 0);
          const inferredSize = Math.sqrt(a * a + b * b);
          const size = Number((Number.isFinite(inferredSize) ? inferredSize : toNum(item?.height, 0)).toFixed(3));
          const height = toNum(item?.height, size);
          const rotation = Number((Math.atan2(b, a) * (180 / Math.PI)).toFixed(3));
          const fontName = String(item?.fontName ?? "");
          const fontFamily = fontName && styleMap[fontName]?.fontFamily
            ? String(styleMap[fontName].fontFamily)
            : null;
          const rawColor = item?.color ?? styleMap[fontName]?.color ?? null;
          const color = rawColor !== null && rawColor !== undefined ? String(rawColor) : null;
          if (color) colorObserved = true;

          totalRunCount += 1;
          fontUsage[fontName || "(unknown)"] = (fontUsage[fontName || "(unknown)"] ?? 0) + 1;
          sizeUsage[String(size)] = (sizeUsage[String(size)] ?? 0) + 1;

          const yBucket = String(Math.round(f * 2) / 2);
          if (!lineMap.has(yBucket)) lineMap.set(yBucket, []);
          lineMap.get(yBucket)!.push({ x: e, text });

          if (runs.length < maxRunsPerPage) {
            runs.push({
              text,
              fontName: fontName || null,
              fontFamily,
              size,
              color,
              rotation,
              transform: [a, b, toNum(transform[2], 0), toNum(transform[3], 1), e, f],
              bbox: [Number(e.toFixed(3)), Number((f - height).toFixed(3)), Number((e + width).toFixed(3)), Number(f.toFixed(3))],
            });
          } else {
            truncated = true;
          }
        }

        const lines = [...lineMap.entries()]
          .map(([y, tokens]) => ({
            y: Number(y),
            text: tokens.sort((lhs, rhs) => lhs.x - rhs.x).map((token) => token.text).join(""),
            runCount: tokens.length,
          }))
          .sort((lhs, rhs) => rhs.y - lhs.y);

        pages.push({
          page_number: pageNum,
          width: Number(viewport.width.toFixed(3)),
          height: Number(viewport.height.toFixed(3)),
          total_run_count: totalRunCount,
          runs_truncated: truncated,
          line_count: lines.length,
          font_usage: fontUsage,
          size_usage: sizeUsage,
          lines,
          runs: includeRuns ? runs : undefined,
        });
      }

      const output = {
        source: inputPdfPath,
        page_count: totalPages,
        extracted_pages: pages.length,
        capabilities: {
          bbox: true,
          font: true,
          size: true,
          rotation: true,
          color: colorObserved ? "partial" : "unavailable",
        },
        pages,
      };
      return { success: true, output: JSON.stringify(output, null, 2), statusCode: 0 };
    } finally {
      await doc.destroy();
    }
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

/**
 * Unified template style parser entrypoint for PDF toolkit.
 * Keeps backward compatibility by delegating to extractStyles.
 */
export async function parseTemplateStyle(
  inputPdfPath: string,
  options?: {
    pages?: number[];
    includeRuns?: boolean;
    maxRunsPerPage?: number;
    preflightRead?: boolean;
    preflight_read?: boolean;
  },
): Promise<PdfToolResult> {
  const runPreflight = options?.preflightRead ?? options?.preflight_read ?? true;
  if (runPreflight) {
    const preflightPages = options?.pages && options.pages.length > 0 ? [options.pages[0]] : [1];
    const preflight = await extractText(inputPdfPath, undefined, preflightPages);
    if (!preflight.success) {
      return {
        success: false,
        output: `Preflight read failed: ${preflight.output}`,
        statusCode: preflight.statusCode ?? 1,
      };
    }
  }
  const { preflightRead: _preflightRead, preflight_read: _preflight_read, ...styleOptions } = options ?? {};
  return extractStyles(inputPdfPath, styleOptions);
}

export async function extractText(
  inputPdfPath: string,
  outputTextPath?: string,
  pages?: number[]
): Promise<PdfToolResult> {
  try {
    const doc = await loadPdfjs(inputPdfPath);
    try {
      const results: string[] = [];
      const totalPages = doc.numPages;
      const pageList = pages && pages.length > 0 ? pages : Array.from({ length: totalPages }, (_, i) => i + 1);

      for (const pageNum of pageList) {
        if (pageNum < 1 || pageNum > totalPages) continue;
        const page = await doc.getPage(pageNum);
        const textContent = await page.getTextContent();
        const items = (textContent.items ?? []) as any[];
        const pageText = items.map((item: any) => String(item?.str ?? "")).join("");
        results.push(`--- Page ${pageNum} ---\n${pageText}`);
      }

      const fullText = results.join("\n\n");

      if (outputTextPath) {
        ;(await fs.promises.writeFile(outputTextPath, fullText, "utf-8"));
        return { success: true, output: `Extracted text from ${pageList.length} page(s) and saved to ${outputTextPath}`, statusCode: 0 };
      }

      return { success: true, output: fullText, statusCode: 0 };
    } finally {
      await doc.destroy();
    }
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function mergePdfs(
  inputPdfPaths: string[],
  outputPdfPath: string
): Promise<PdfToolResult> {
  try {
    const mergedDoc = await PDFDocument.create();

    for (const pdfPath of inputPdfPaths) {
      const srcDoc = await PDFDocument.load((await fs.promises.readFile(pdfPath)));
      const copiedPages = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
      for (const page of copiedPages) {
        mergedDoc.addPage(page);
      }
    }

    ;(await fs.promises.writeFile(outputPdfPath, await mergedDoc.save()));
    return {
      success: true,
      output: `Merged ${inputPdfPaths.length} PDFs (${mergedDoc.getPageCount()} total pages) into ${outputPdfPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

function parsePageRange(range: string, totalPages: number): number[] {
  const pages: number[] = [];
  const parts = range.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const [startStr, endStr] = trimmed.split("-");
      const start = Math.max(1, parseInt(startStr, 10));
      const end = Math.min(totalPages, parseInt(endStr, 10));
      for (let i = start; i <= end; i++) {
        pages.push(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= totalPages) {
        pages.push(num);
      }
    }
  }
  return pages;
}

export async function splitPdf(
  inputPdfPath: string,
  pageRanges: string[],
  outputDirectory: string
): Promise<PdfToolResult> {
  try {
    ;(await fs.promises.mkdir(outputDirectory, { recursive: true }));
    const srcDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const totalPages = srcDoc.getPageCount();
    const outputFiles: string[] = [];

    for (let i = 0; i < pageRanges.length; i++) {
      const pageIndices = parsePageRange(pageRanges[i], totalPages).map((p) => p - 1);
      if (pageIndices.length === 0) continue;

      const newDoc = await PDFDocument.create();
      const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
      for (const page of copiedPages) {
        newDoc.addPage(page);
      }

      const outputFile = path.join(outputDirectory, `split_${i + 1}.pdf`);
      ;(await fs.promises.writeFile(outputFile, await newDoc.save()));
      outputFiles.push(outputFile);
    }

    return {
      success: true,
      output: `Split PDF into ${outputFiles.length} files:\n${outputFiles.join("\n")}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function rotatePdfPages(
  inputPdfPath: string,
  rotation: number,
  pageNumbers?: number[],
  outputPdfPath?: string
): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const pages = pdfDoc.getPages();
    const targetPages = pageNumbers && pageNumbers.length > 0
      ? pageNumbers.map((n) => n - 1)
      : pages.map((_, i) => i);

    for (const idx of targetPages) {
      if (idx < 0 || idx >= pages.length) continue;
      const page = pages[idx];
      const currentRotation = page.getRotation().angle;
      page.setRotation(degrees(currentRotation + rotation));
    }

    const outPath = outputPdfPath ?? inputPdfPath;
    ;(await fs.promises.writeFile(outPath, await pdfDoc.save()));
    return {
      success: true,
      output: `Rotated ${targetPages.length} page(s) by ${rotation} degrees. Saved to ${outPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function removePages(
  inputPdfPath: string,
  pageNumbers: number[],
  outputPdfPath: string
): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const sortedDesc = [...pageNumbers].sort((a, b) => b - a);

    for (const pageNum of sortedDesc) {
      const idx = pageNum - 1;
      if (idx >= 0 && idx < pdfDoc.getPageCount()) {
        pdfDoc.removePage(idx);
      }
    }

    ;(await fs.promises.writeFile(outputPdfPath, await pdfDoc.save()));
    return {
      success: true,
      output: `Removed ${pageNumbers.length} page(s). ${pdfDoc.getPageCount()} pages remaining. Saved to ${outputPdfPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function flattenForm(
  inputPdfPath: string,
  outputPdfPath: string
): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const form = pdfDoc.getForm();
    form.flatten();
    ;(await fs.promises.writeFile(outputPdfPath, await pdfDoc.save()));
    return {
      success: true,
      output: `Flattened form fields and saved to ${outputPdfPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

type WatermarkOptions = {
  text: string;
  font_path?: string;
  font_size?: number;
  opacity?: number;
  rotation?: number;
  color?: string;
  pages?: number[];
};

export async function addWatermark(
  inputPdfPath: string,
  outputPdfPath: string,
  options: WatermarkOptions
): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const text = options.text;
    const fontSize = options.font_size ?? 50;
    const opacity = options.opacity ?? 0.3;
    const rotationAngle = options.rotation ?? -45;
    const colorHex = options.color ?? "888888";
    const [r, g, b] = hexToRgb01(colorHex);

    let font: any;
    if (options.font_path && hasNonAscii(text)) {
      pdfDoc.registerFontkit(fontkit);
      const fontBytes = (await fs.promises.readFile(options.font_path));
      font = await pdfDoc.embedFont(fontBytes, { subset: false });
    } else {
      font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }

    const pages = pdfDoc.getPages();
    const targetPages = options.pages && options.pages.length > 0
      ? options.pages.map((n) => n - 1)
      : pages.map((_, i) => i);

    for (const idx of targetPages) {
      if (idx < 0 || idx >= pages.length) continue;
      const page = pages[idx];
      const { width, height } = page.getSize();
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      const textHeight = font.heightAtSize(fontSize);

      page.drawText(text, {
        x: (width - textWidth) / 2,
        y: (height - textHeight) / 2,
        size: fontSize,
        font,
        color: rgb(r, g, b),
        opacity,
        rotate: degrees(rotationAngle),
      });
    }

    ;(await fs.promises.writeFile(outputPdfPath, await pdfDoc.save()));
    return {
      success: true,
      output: `Added watermark "${text}" to ${targetPages.length} page(s). Saved to ${outputPdfPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

type HighlightAnnotationInput = {
  page_number: number;
  rect: [number, number, number, number];
  color?: string;
};

export async function addHighlightAnnotation(
  inputPdfPath: string,
  annotations: HighlightAnnotationInput[],
  outputPdfPath: string
): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const pages = pdfDoc.getPages();
    let count = 0;

    for (const annot of annotations) {
      const pageIdx = annot.page_number - 1;
      if (pageIdx < 0 || pageIdx >= pages.length) continue;
      const page = pages[pageIdx];
      const [x1, y1, x2, y2] = annot.rect;
      const colorHex = annot.color ?? "FFFF00";
      const [r, g, b] = hexToRgb01(colorHex);

      const highlightDict = pdfDoc.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Highlight"),
        Rect: pdfDoc.context.obj([
          PDFNumber.of(x1),
          PDFNumber.of(y1),
          PDFNumber.of(x2),
          PDFNumber.of(y2),
        ]),
        C: pdfDoc.context.obj([PDFNumber.of(r), PDFNumber.of(g), PDFNumber.of(b)]),
        CA: PDFNumber.of(0.5),
        QuadPoints: pdfDoc.context.obj([
          PDFNumber.of(x1), PDFNumber.of(y2),
          PDFNumber.of(x2), PDFNumber.of(y2),
          PDFNumber.of(x1), PDFNumber.of(y1),
          PDFNumber.of(x2), PDFNumber.of(y1),
        ]),
      });

      const ref = pdfDoc.context.register(highlightDict);
      page.node.addAnnot(ref);
      count++;
    }

    ;(await fs.promises.writeFile(outputPdfPath, await pdfDoc.save()));
    return {
      success: true,
      output: `Added ${count} highlight annotation(s). Saved to ${outputPdfPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

type StampAnnotationInput = {
  page_number: number;
  rect: [number, number, number, number];
  stamp_name: string;
};

const VALID_STAMP_NAMES = [
  "Approved", "Experimental", "NotApproved", "AsIs",
  "Expired", "NotForPublicRelease", "Confidential",
  "Final", "Sold", "Departmental", "ForComment",
  "TopSecret", "Draft", "ForPublicRelease",
];

export async function addStampAnnotation(
  inputPdfPath: string,
  stamps: StampAnnotationInput[],
  outputPdfPath: string
): Promise<PdfToolResult> {
  try {
    const pdfDoc = await PDFDocument.load((await fs.promises.readFile(inputPdfPath)));
    const pages = pdfDoc.getPages();
    let count = 0;

    for (const stamp of stamps) {
      const pageIdx = stamp.page_number - 1;
      if (pageIdx < 0 || pageIdx >= pages.length) continue;

      if (!VALID_STAMP_NAMES.includes(stamp.stamp_name)) {
        return {
          success: false,
          output: `Invalid stamp name "${stamp.stamp_name}". Valid names: ${VALID_STAMP_NAMES.join(", ")}`,
          statusCode: 1,
        };
      }

      const page = pages[pageIdx];
      const [x1, y1, x2, y2] = stamp.rect;

      const stampDict = pdfDoc.context.obj({
        Type: PDFName.of("Annot"),
        Subtype: PDFName.of("Stamp"),
        Rect: pdfDoc.context.obj([
          PDFNumber.of(x1),
          PDFNumber.of(y1),
          PDFNumber.of(x2),
          PDFNumber.of(y2),
        ]),
        Name: PDFName.of(stamp.stamp_name),
      });

      const ref = pdfDoc.context.register(stampDict);
      page.node.addAnnot(ref);
      count++;
    }

    ;(await fs.promises.writeFile(outputPdfPath, await pdfDoc.save()));
    return {
      success: true,
      output: `Added ${count} stamp annotation(s). Saved to ${outputPdfPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

export async function pdfInitTask(args: {
  session_id: string;
  task_id: string;
  work_dir?: string;
}): Promise<PdfToolResult> {
  try {
    if (!args.session_id) {
      return { success: false, output: "Missing required parameter: session_id", statusCode: 1 };
    }
    if (!args.task_id) {
      return { success: false, output: "Missing required parameter: task_id", statusCode: 1 };
    }

    const pipeline = new PdfPipeline({
      sessionId: args.session_id,
      taskType: "pdf",
      taskId: args.task_id,
      workDir: args.work_dir,
    });
    pipeline.ensureStepDirs();
    await pipeline.setMeta({
      sessionId: args.session_id,
      taskType: "pdf",
      taskId: args.task_id,
      createdAt: new Date().toISOString(),
    });
    return {
      success: true,
      output: `Task initialized at: ${pipeline.taskDir}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function pdfWriteSource(args: {
  task_dir: string;
  input_path: string;
}): Promise<PdfToolResult> {
  try {
    if (!args.task_dir) return { success: false, output: "Missing required parameter: task_dir", statusCode: 1 };
    if (!args.input_path) return { success: false, output: "Missing required parameter: input_path", statusCode: 1 };

    const pipeline = pdfPipelineFromTaskDir(args.task_dir);
    pipeline.ensureStepDirs();

    const inputPath = path.resolve(args.input_path);
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `File not found: ${inputPath}`, statusCode: 1 };
    }

    const sourcePath = path.join(pipeline.stepPath(PDF_STEP_SOURCE), "input.pdf");
    ;(await fs.promises.copyFile(inputPath, sourcePath));
    await pipeline.setMeta({ updatedAt: new Date().toISOString() });

    return {
      success: true,
      output: `Source written to ${sourcePath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function pdfWriteIntermediate(args: {
  task_dir: string;
  input_path?: string;
}): Promise<PdfToolResult> {
  try {
    if (!args.task_dir) return { success: false, output: "Missing required parameter: task_dir", statusCode: 1 };
    const pipeline = pdfPipelineFromTaskDir(args.task_dir);
    pipeline.ensureStepDirs();

    if (args.input_path) {
      const sourceWrite = await pdfWriteSource({
        task_dir: args.task_dir,
        input_path: args.input_path,
      });
      if (!sourceWrite.success) return sourceWrite;
    }

    const sourcePath = path.join(pipeline.stepPath(PDF_STEP_SOURCE), "input.pdf");
    if (!(await pathExists(sourcePath))) {
      return {
        success: false,
        output: "No source found. Run pdf_write_source first.",
        statusCode: 1,
      };
    }

    const intermediatePath = path.join(pipeline.stepPath(PDF_STEP_INTERMEDIATE), "working.pdf");
    ;(await fs.promises.copyFile(sourcePath, intermediatePath));
    await pipeline.setMeta({ updatedAt: new Date().toISOString() });
    return {
      success: true,
      output: `Intermediate written to ${intermediatePath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function pdfPackTask(args: {
  task_dir: string;
  output_path?: string;
}): Promise<PdfToolResult> {
  try {
    if (!args.task_dir) return { success: false, output: "Missing required parameter: task_dir", statusCode: 1 };
    const pipeline = pdfPipelineFromTaskDir(args.task_dir);
    const workingPath = path.join(pipeline.stepPath(PDF_STEP_INTERMEDIATE), "working.pdf");
    const sourcePath = path.join(pipeline.stepPath(PDF_STEP_SOURCE), "input.pdf");
    const inputPath = (await pathExists(workingPath)) ? workingPath : sourcePath;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: "No PDF available to pack.", statusCode: 1 };
    }

    const outputPath = args.output_path
      ? path.resolve(args.output_path)
      : path.join(pipeline.stepPath(PDF_STEP_OUTPUT), "result.pdf");
    ;(await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }));
    ;(await fs.promises.copyFile(inputPath, outputPath));
    return {
      success: true,
      output: `Packed PDF to ${outputPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function pdfUnpackTask(args: {
  task_dir: string;
  input_path: string;
}): Promise<PdfToolResult> {
  return pdfWriteIntermediate(args);
}

export async function pdfReadParsed(args: {
  task_dir: string;
  pages?: number[];
}): Promise<PdfToolResult> {
  try {
    if (!args.task_dir) return { success: false, output: "Missing required parameter: task_dir", statusCode: 1 };
    const pipeline = pdfPipelineFromTaskDir(args.task_dir);
    const workingPath = path.join(pipeline.stepPath(PDF_STEP_INTERMEDIATE), "working.pdf");
    const sourcePath = path.join(pipeline.stepPath(PDF_STEP_SOURCE), "input.pdf");
    const inputPath = (await pathExists(workingPath)) ? workingPath : sourcePath;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: "No PDF found. Run pdf_write_source or pdf_unpack first.", statusCode: 1 };
    }

    const meta = await getMetadata(inputPath);
    if (!meta.success) return meta;
    const text = await extractText(inputPath, undefined, args.pages);
    if (!text.success) return text;

    const parsedObj = {
      input_path: inputPath,
      metadata: (() => {
        try {
          return JSON.parse(meta.output);
        } catch {
          return meta.output;
        }
      })(),
      text: text.output,
    };
    const parsedPath = path.join(pipeline.stepPath(PDF_STEP_PARSED), "parsed.json");
    ;(await fs.promises.writeFile(parsedPath, JSON.stringify(parsedObj, null, 2), "utf-8"));

    return {
      success: true,
      output: `Parsed PDF saved to ${parsedPath}`,
      statusCode: 0,
    };
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function pdfReadSource(args: {
  task_dir: string;
}): Promise<PdfToolResult> {
  try {
    if (!args.task_dir) return { success: false, output: "Missing required parameter: task_dir", statusCode: 1 };
    const pipeline = pdfPipelineFromTaskDir(args.task_dir);
    const sourcePath = path.join(pipeline.stepPath(PDF_STEP_SOURCE), "input.pdf");
    if (!(await pathExists(sourcePath))) {
      return { success: false, output: "No source PDF found. Run pdf_write_source first.", statusCode: 1 };
    }
    return getMetadata(sourcePath);
  } catch (error: any) {
    return { success: false, output: String(error?.message ?? error), statusCode: 1 };
  }
}

export async function handlePdfTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<PdfHandlerResult> {
  switch (toolName) {
    case "pdf_init_task": {
      const r = await pdfInitTask({
        session_id: args.session_id as string,
        task_id: args.task_id as string,
        work_dir: args.work_dir as string | undefined,
      });
      return { success: r.success, output: r.output };
    }
    case "pdf_write_source": {
      const r = await pdfWriteSource({
        task_dir: args.task_dir as string,
        input_path: args.input_path as string,
      });
      return { success: r.success, output: r.output };
    }
    case "pdf_write_intermediate": {
      const r = await pdfWriteIntermediate({
        task_dir: args.task_dir as string,
        input_path: args.input_path as string | undefined,
      });
      return { success: r.success, output: r.output };
    }
    case "pdf_pack_document": {
      const r = await pdfPackTask({
        task_dir: args.task_dir as string,
        output_path: args.output_path as string | undefined,
      });
      return { success: r.success, output: r.output };
    }
    case "pdf_unpack_document": {
      const r = await pdfUnpackTask({
        task_dir: args.task_dir as string,
        input_path: args.input_path as string,
      });
      return { success: r.success, output: r.output };
    }
    case "pdf_read_parsed": {
      const r = await pdfReadParsed({
        task_dir: args.task_dir as string,
        pages: args.pages as number[] | undefined,
      });
      return { success: r.success, output: r.output };
    }
    case "pdf_read_source": {
      const r = await pdfReadSource({
        task_dir: args.task_dir as string,
      });
      return { success: r.success, output: r.output };
    }
    case "pdf_check_fillablefields": {
      const r = await checkFillableFields(args.path as string);
      return { success: r.success, output: r.output };
    }
    case "pdf_extract_formfields": {
      const r = await extractFormFieldInfo(
        args.path as string,
        args.output_json_path as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_fill_formfields": {
      const r = await fillFillableFields(
        args.path as string,
        args.field_values_json_path as string,
        args.output_path as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_fill_annotations": {
      const r = await fillPdfFormWithAnnotations(
        args.path as string,
        args.fields_json_path as string,
        args.output_path as string,
        args.font_path as string | undefined
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_extract_formstructure": {
      const r = await extractFormStructure(
        args.path as string,
        args.output_json_path as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_check_boundingboxes": {
      const r = checkBoundingBoxes(args.fields_json_path as string);
      return { success: r.success, output: r.output };
    }
    case "pdf_create_validationimage": {
      const r = createValidationImage(
        args.page_number as number,
        args.fields_json_path as string,
        args.input_image_path as string,
        args.output_image_path as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_convert_images": {
      const r = convertPdfToImages(
        args.path as string,
        args.output_directory as string,
        args.max_dim as number | undefined
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_get_pagecount": {
      const r = await getPageCount(args.path as string);
      return { success: r.success, output: r.output };
    }
    case "pdf_get_metadata": {
      const r = await getMetadata(args.path as string);
      return { success: r.success, output: r.output };
    }
    case "pdf_extract_text": {
      const r = await extractText(
        args.path as string,
        args.output_text_path as string | undefined,
        args.pages as number[] | undefined
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_extract_styles": {
      const r = await parseTemplateStyle(
        args.path as string,
        {
          pages: args.pages as number[] | undefined,
          includeRuns: args.include_runs as boolean | undefined,
          maxRunsPerPage: args.max_runs_per_page as number | undefined,
        }
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_merge_documents": {
      const r = await mergePdfs(
        args.input_paths as string[],
        args.output_path as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_split_document": {
      const r = await splitPdf(
        args.path as string,
        args.page_ranges as string[],
        args.output_directory as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_rotate_pages": {
      const r = await rotatePdfPages(
        args.path as string,
        args.rotation as number,
        args.pages as number[] | undefined,
        args.output_path as string | undefined
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_remove_pages": {
      const r = await removePages(
        args.path as string,
        args.page_numbers as number[],
        args.output_path as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_flatten_form": {
      const r = await flattenForm(
        args.path as string,
        args.output_path as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_add_watermark": {
      const r = await addWatermark(
        args.path as string,
        args.output_path as string,
        {
          text: args.text as string,
          font_path: args.font_path as string | undefined,
          font_size: args.font_size as number | undefined,
          opacity: args.opacity as number | undefined,
          rotation: args.rotation as number | undefined,
          color: args.color as string | undefined,
          pages: args.pages as number[] | undefined,
        }
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_add_highlight": {
      const r = await addHighlightAnnotation(
        args.path as string,
        args.annotations as HighlightAnnotationInput[],
        args.output_path as string
      );
      return { success: r.success, output: r.output };
    }
    case "pdf_add_stamp": {
      const r = await addStampAnnotation(
        args.path as string,
        args.stamps as StampAnnotationInput[],
        args.output_path as string
      );
      return { success: r.success, output: r.output };
    }
    default:
      return { success: false, output: `Unknown PDF tool: ${toolName}` };
  }
}
