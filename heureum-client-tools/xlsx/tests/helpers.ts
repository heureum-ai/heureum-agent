import ExcelJS from "exceljs";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TMP_DIR = path.join(__dirname, `__tmp_tools_${process.env.VITEST_WORKER_ID || "0"}__`);

export function fixture(name: string) {
  return path.join(TMP_DIR, name);
}

beforeAll(() => {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(TMP_DIR))
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/** Helper: create a simple workbook with sample data */
export async function createSampleWorkbook(
  filePath: string,
  opts?: { sheets?: string[]; rows?: number }
) {
  const wb = new ExcelJS.Workbook();
  const sheetNames = opts?.sheets ?? ["Sheet1"];
  const rowCount = opts?.rows ?? 4;
  for (const name of sheetNames) {
    const ws = wb.addWorksheet(name);
    ws.getCell("A1").value = "Name";
    ws.getCell("B1").value = "Value";
    ws.getCell("C1").value = "Category";
    for (let i = 2; i <= rowCount; i++) {
      ws.getCell(`A${i}`).value = `Item${i - 1}`;
      ws.getCell(`B${i}`).value = (i - 1) * 10;
      ws.getCell(`C${i}`).value = i % 2 === 0 ? "GroupA" : "GroupB";
    }
  }
  await wb.xlsx.writeFile(filePath);
}
