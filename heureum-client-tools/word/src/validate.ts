/**
 * Convenience validation function.
 * Ported from validate.py - accepts either a packed file or unpacked directory.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import JSZip from "jszip";
import { DOCXSchemaValidator } from "./validators/docx";
import { PPTXSchemaValidator } from "./validators/pptx";
import { RedliningValidator } from "./validators/redlining";

export interface ValidateOptions {
  original?: string;
  verbose?: boolean;
  autoRepair?: boolean;
  author?: string;
}

export interface ValidateResult {
  success: boolean;
  repairs: number;
  errors: string[];
}

/**
 * Validate an Office document or unpacked directory.
 *
 * @param inputPath - Path to packed file (.docx/.pptx/.xlsx) or unpacked directory
 * @param options - Validation options
 */
export async function validate(
  inputPath: string,
  options: ValidateOptions = {}
): Promise<ValidateResult> {
  const { original, verbose = false, autoRepair = false, author = "Claude" } = options;

  if (!fs.existsSync(inputPath)) {
    return { success: false, repairs: 0, errors: [`Error: ${inputPath} does not exist`] };
  }

  const stat = fs.statSync(inputPath);
  let unpackedDir: string;
  let tmpDir: string | null = null;
  let fileExtension: string;

  if (stat.isFile()) {
    const ext = path.extname(inputPath).toLowerCase();
    if (![".docx", ".pptx", ".xlsx"].includes(ext)) {
      return { success: false, repairs: 0, errors: [`Error: Unsupported file type: ${ext}`] };
    }
    fileExtension = ext;

    // Unpack to temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-"));
    unpackedDir = path.join(tmpDir, "content");
    fs.mkdirSync(unpackedDir, { recursive: true });

    const buffer = fs.readFileSync(inputPath);
    const zip = await JSZip.loadAsync(buffer);

    for (const [zipPath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) {
        fs.mkdirSync(path.join(unpackedDir, zipPath), { recursive: true });
      } else {
        const content = await zipEntry.async("uint8array");
        const destPath = path.join(unpackedDir, zipPath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content);
      }
    }
  } else {
    unpackedDir = inputPath;
    fileExtension = original ? path.extname(original).toLowerCase() : ".docx";
  }

  try {
    const allErrors: string[] = [];
    let totalRepairs = 0;

    if (fileExtension === ".docx") {
      const docxValidator = new DOCXSchemaValidator(unpackedDir, original ?? null, verbose);

      if (autoRepair) {
        totalRepairs += docxValidator.repair();
      }

      const docxResult = await docxValidator.validate();
      if (!docxResult.valid) allErrors.push(...docxResult.errors);

      if (original) {
        const redliningValidator = new RedliningValidator(unpackedDir, original, verbose, author);
        if (autoRepair) totalRepairs += redliningValidator.repair();
        const redResult = await redliningValidator.validate();
        if (!redResult.valid) allErrors.push(...redResult.errors);
      }
    } else if (fileExtension === ".pptx") {
      const pptxValidator = new PPTXSchemaValidator(unpackedDir, original ?? null, verbose);
      if (autoRepair) {
        totalRepairs = pptxValidator.repair();
      }
      const result = await pptxValidator.validate();
      if (!result.valid) allErrors.push(...result.errors);
    } else {
      allErrors.push(`Validation not supported for file type ${fileExtension}`);
    }

    return {
      success: allErrors.length === 0,
      repairs: totalRepairs,
      errors: allErrors,
    };
  } finally {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
