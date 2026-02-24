import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  webInitTask,
  webPackTask,
  webReadParsed,
  webReadSource,
  webUnpackTask,
} from "../src/tools.js";

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

describe("Web pipeline roundtrip", () => {
  it("sanitizes unsafe task segments in initialized task paths", async () => {
    const workDir = makeTempDir("web-roundtrip-");

    const init = await webInitTask({
      session_id: "..\\..\\CON",
      task_id: "task:with*chars",
      work_dir: workDir,
    });

    expect(init.success).toBe(true);
    const taskDir = String(init.outputPath);
    const relative = path.relative(workDir, taskDir);
    const segments = relative.split(path.sep).filter(Boolean);

    expect(segments.length).toBe(3); // session/taskType/taskId
    for (const segment of segments) {
      expect(segment).toMatch(/^[\p{L}\p{N}._-]+$/u);
      expect(segment).not.toContain("..");
    }
  });

  it("packs generated fetch payload and reads it back via unpack/read pipeline", async () => {
    const workDir = makeTempDir("web-roundtrip-");

    const seedPayload = {
      url: "https://example.com",
      title: "Example",
      status: 200,
      total_length: 12,
      text: "hello world!",
    };

    const seedPath = path.join(workDir, "seed.json");
    await fs.promises.writeFile(seedPath, JSON.stringify(seedPayload, null, 2), "utf-8");

    const initUnpack = await webInitTask({
      session_id: "s1",
      task_id: "t1",
      work_dir: workDir,
    });
    expect(initUnpack.success).toBe(true);
    expect(initUnpack.outputPath).toBeTruthy();

    const unpackTaskDir = String(initUnpack.outputPath);
    const unpacked = await webUnpackTask({
      task_dir: unpackTaskDir,
      input_path: seedPath,
    });
    expect(unpacked.success).toBe(true);

    const parsed = await webReadParsed({ task_dir: unpackTaskDir });
    expect(parsed.success).toBe(true);
    const summary = JSON.parse(parsed.output);
    expect(summary.url).toBe("https://example.com");
    expect(summary.status).toBe(200);

    const packed = await webPackTask({ task_dir: unpackTaskDir });
    expect(packed.success).toBe(true);
    expect(packed.outputPath).toBeTruthy();
    const packedPath = String(packed.outputPath);
    expect(fs.existsSync(packedPath)).toBe(true);

    const initRead = await webInitTask({
      session_id: "s2",
      task_id: "t2",
      work_dir: workDir,
    });
    expect(initRead.success).toBe(true);
    expect(initRead.outputPath).toBeTruthy();

    const readTaskDir = String(initRead.outputPath);
    const unpackPacked = await webUnpackTask({
      task_dir: readTaskDir,
      input_path: packedPath,
    });
    expect(unpackPacked.success).toBe(true);

    const source = await webReadSource({ task_dir: readTaskDir });
    expect(source.success).toBe(true);
    const sourcePayload = JSON.parse(source.output);
    expect(sourcePayload.url).toBe("https://example.com");

    const parsedAfterRoundtrip = await webReadParsed({ task_dir: readTaskDir });
    expect(parsedAfterRoundtrip.success).toBe(true);
    const summaryAfterRoundtrip = JSON.parse(parsedAfterRoundtrip.output);
    expect(summaryAfterRoundtrip.url).toBe("https://example.com");
    expect(summaryAfterRoundtrip.status).toBe(200);
  });
});
