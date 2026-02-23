import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  pptInitTask,
  pptPackTask,
  pptReadParsed,
  pptReadSource,
  pptUnpackTask,
} from "../src/tools";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

describe("PPT pipeline roundtrip", () => {
  it("packs generated pptx and reads it back via unpack/read pipeline", async () => {
    const workDir = makeTempDir("ppt-roundtrip-");

    const initCreate = await pptInitTask({
      session_id: "s1",
      task_id: "t1",
      work_dir: workDir,
    });
    expect(initCreate.success).toBe(true);
    expect(initCreate.outputPath).toBeTruthy();

    const createdTaskDir = String(initCreate.outputPath);
    const unpackedDir = path.join(createdTaskDir, "steps/03_intermediate/unpacked");
    await fs.promises.mkdir(path.join(unpackedDir, "ppt/slides"), { recursive: true });

    await fs.promises.writeFile(
      path.join(unpackedDir, "[Content_Types].xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
      "utf-8"
    );
    await fs.promises.writeFile(
      path.join(unpackedDir, "ppt/slides/slide1.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld/>
</p:sld>`,
      "utf-8"
    );

    const packed = await pptPackTask({ task_dir: createdTaskDir });
    expect(packed.success).toBe(true);
    expect(packed.outputPath).toBeTruthy();
    const packedPath = String(packed.outputPath);
    expect(fs.existsSync(packedPath)).toBe(true);

    const initRead = await pptInitTask({
      session_id: "s2",
      task_id: "t2",
      work_dir: workDir,
    });
    expect(initRead.success).toBe(true);
    expect(initRead.outputPath).toBeTruthy();

    const readTaskDir = String(initRead.outputPath);
    const unpacked = await pptUnpackTask({
      task_dir: readTaskDir,
      input_path: packedPath,
    });
    expect(unpacked.success).toBe(true);

    const source = await pptReadSource({ task_dir: readTaskDir });
    expect(source.success).toBe(true);
    const sourceInfo = JSON.parse(source.output);
    expect(sourceInfo.path).toContain("input.pptx");
    expect(Number(sourceInfo.size)).toBeGreaterThan(0);

    const parsed = await pptReadParsed({ task_dir: readTaskDir });
    expect(parsed.success).toBe(true);
    const summary = JSON.parse(parsed.output);
    expect(summary.slideCount).toBe(1);
    expect(summary.slides).toContain("slide1.xml");
  });
});
