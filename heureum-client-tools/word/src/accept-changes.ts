/**
 * Accept all tracked changes in a DOCX file using LibreOffice.
 *
 * Requires LibreOffice (soffice) to be installed.
 *
 * Ported from accept_changes.py
 */
import * as fs from "fs";
import * as path from "path";
import * as child_process from "child_process";
import { getSofficeEnv } from "./soffice";

const LIBREOFFICE_PROFILE = "/tmp/libreoffice_docx_profile";
const MACRO_DIR = `${LIBREOFFICE_PROFILE}/user/basic/Standard`;

const ACCEPT_CHANGES_MACRO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
    Sub AcceptAllTrackedChanges()
        Dim document As Object
        Dim dispatcher As Object

        document = ThisComponent.CurrentController.Frame
        dispatcher = createUnoService("com.sun.star.frame.DispatchHelper")

        dispatcher.executeDispatch(document, ".uno:AcceptAllTrackedChanges", "", 0, Array())
        ThisComponent.store()
        ThisComponent.close(True)
    End Sub
</script:module>`;

/**
 * Setup the LibreOffice macro for accepting changes.
 */
function setupLibreOfficeMacro(): boolean {
  const macroDir = MACRO_DIR;
  const macroFile = path.join(macroDir, "Module1.xba");

  if (
    fs.existsSync(macroFile) &&
    fs.readFileSync(macroFile, "utf-8").includes("AcceptAllTrackedChanges")
  ) {
    return true;
  }

  if (!fs.existsSync(macroDir)) {
    try {
      child_process.spawnSync(
        "soffice",
        [
          "--headless",
          `-env:UserInstallation=file://${LIBREOFFICE_PROFILE}`,
          "--terminate_after_init",
        ],
        {
          encoding: "utf-8",
          timeout: 10000,
          env: getSofficeEnv(),
        }
      );
    } catch {
      // Ignore timeout
    }
    fs.mkdirSync(macroDir, { recursive: true });
  }

  try {
    fs.writeFileSync(macroFile, ACCEPT_CHANGES_MACRO);
    return true;
  } catch (e: any) {
    console.warn(`Failed to setup LibreOffice macro: ${e.message}`);
    return false;
  }
}

/**
 * Accept all tracked changes in a DOCX file using LibreOffice.
 *
 * @param inputFile - Input DOCX file with tracked changes
 * @param outputFile - Output DOCX file (clean, no tracked changes)
 * @returns [null, message] tuple
 */
export function acceptChanges(
  inputFile: string,
  outputFile: string
): [null, string] {
  if (!fs.existsSync(inputFile)) {
    return [null, `Error: Input file not found: ${inputFile}`];
  }

  if (path.extname(inputFile).toLowerCase() !== ".docx") {
    return [null, `Error: Input file is not a DOCX file: ${inputFile}`];
  }

  try {
    const outputDir = path.dirname(outputFile);
    if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
    fs.copyFileSync(inputFile, outputFile);
  } catch (e: any) {
    return [
      null,
      `Error: Failed to copy input file to output location: ${e.message}`,
    ];
  }

  if (!setupLibreOfficeMacro()) {
    return [null, "Error: Failed to setup LibreOffice macro"];
  }

  const absoluteOutput = path.resolve(outputFile);
  const cmd = [
    "--headless",
    `-env:UserInstallation=file://${LIBREOFFICE_PROFILE}`,
    "--norestore",
    "vnd.sun.star.script:Standard.Module1.AcceptAllTrackedChanges?language=Basic&location=application",
    absoluteOutput,
  ];

  try {
    const result = child_process.spawnSync("soffice", cmd, {
      encoding: "utf-8",
      timeout: 30000,
      env: getSofficeEnv(),
    });

    if (result.error) {
      // Timeout is treated as success (soffice may hang after completing)
      if ((result.error as any).code === "ETIMEDOUT") {
        return [
          null,
          `Successfully accepted all tracked changes: ${inputFile} -> ${outputFile}`,
        ];
      }
    }

    if (result.status !== 0) {
      return [
        null,
        `Error: LibreOffice failed: ${result.stderr}`,
      ];
    }
  } catch {
    // Timeout expected - soffice may hang after completing
    return [
      null,
      `Successfully accepted all tracked changes: ${inputFile} -> ${outputFile}`,
    ];
  }

  return [
    null,
    `Successfully accepted all tracked changes: ${inputFile} -> ${outputFile}`,
  ];
}
