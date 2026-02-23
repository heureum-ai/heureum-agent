import * as path from "path";
import { describe, expect, it } from "vitest";

type SupportedPlatform = "darwin" | "linux" | "win32";

type ResolveBinaryInput = {
  platform: SupportedPlatform;
  env: Record<string, string | undefined>;
  pathEntries: string[];
  exists: (targetPath: string) => boolean;
};

function joinForPlatform(platform: SupportedPlatform, ...parts: string[]): string {
  return platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
}

function toUserInstallationUri(platform: SupportedPlatform, profileRoot: string): string {
  const slash = profileRoot.replace(/\\/g, "/");

  if (platform === "win32") {
    if (slash.startsWith("//")) {
      return `file:${encodeURI(slash)}`;
    }
    if (/^[A-Za-z]:\//.test(slash)) {
      return `file:///${encodeURI(slash)}`;
    }
    const normalized = slash.startsWith("/") ? slash : `/${slash}`;
    return `file://${encodeURI(normalized)}`;
  }

  const normalized = slash.startsWith("/") ? slash : `/${slash}`;
  return `file://${encodeURI(normalized)}`;
}

function resolveSofficeBinary(input: ResolveBinaryInput): string | null {
  const explicit = input.env.SOFFICE_BIN;
  if (explicit && input.exists(explicit)) {
    return explicit;
  }

  const execNames = input.platform === "win32"
    ? ["soffice.com", "soffice.exe", "soffice"]
    : ["soffice"];

  for (const dir of input.pathEntries) {
    for (const execName of execNames) {
      const candidate = joinForPlatform(input.platform, dir, execName);
      if (input.exists(candidate)) {
        return candidate;
      }
    }
  }

  const fallbackCandidates: string[] = [];

  if (input.platform === "darwin") {
    fallbackCandidates.push("/Applications/LibreOffice.app/Contents/MacOS/soffice");
  } else if (input.platform === "linux") {
    fallbackCandidates.push("/usr/bin/soffice", "/usr/local/bin/soffice", "/snap/bin/libreoffice");
  } else {
    const programFiles = input.env.ProgramFiles;
    const programFilesX86 = input.env["ProgramFiles(x86)"];

    if (programFiles) {
      fallbackCandidates.push(
        joinForPlatform("win32", programFiles, "LibreOffice", "program", "soffice.com"),
        joinForPlatform("win32", programFiles, "LibreOffice", "program", "soffice.exe"),
      );
    }
    if (programFilesX86) {
      fallbackCandidates.push(
        joinForPlatform("win32", programFilesX86, "LibreOffice", "program", "soffice.com"),
        joinForPlatform("win32", programFilesX86, "LibreOffice", "program", "soffice.exe"),
      );
    }
  }

  for (const candidate of fallbackCandidates) {
    if (input.exists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildProfileLayout(platform: SupportedPlatform, profileRoot: string): {
  profileRoot: string;
  userInstallationUri: string;
  macroDir: string;
  macroFile: string;
} {
  const macroDir = joinForPlatform(platform, profileRoot, "user", "basic", "Standard");
  return {
    profileRoot,
    userInstallationUri: toUserInstallationUri(platform, profileRoot),
    macroDir,
    macroFile: joinForPlatform(platform, macroDir, "Module1.xba"),
  };
}

function buildMacroExecutionArgs(params: {
  userInstallationUri: string;
  scriptUri: string;
  workbookPath: string;
}): string[] {
  return [
    "--headless",
    "--norestore",
    `-env:UserInstallation=${params.userInstallationUri}`,
    params.scriptUri,
    params.workbookPath,
  ];
}

function createExists(paths: string[]): (targetPath: string) => boolean {
  const set = new Set(paths);
  return (targetPath: string) => set.has(targetPath);
}

describe("Preview: portable soffice launcher design", () => {
  it("prefers SOFFICE_BIN when explicitly set", () => {
    const explicit = path.win32.join("D:\\", "portable", "LibreOffice", "program", "soffice.com");
    const resolved = resolveSofficeBinary({
      platform: "win32",
      env: { SOFFICE_BIN: explicit },
      pathEntries: [path.win32.join("C:\\", "Windows", "System32")],
      exists: createExists([explicit]),
    });

    expect(resolved).toBe(explicit);
  });

  it("on Windows, prefers soffice.com over soffice.exe in PATH", () => {
    const binDir = path.win32.join("C:\\", "LibreOffice", "program");
    const com = path.win32.join(binDir, "soffice.com");
    const exe = path.win32.join(binDir, "soffice.exe");

    const resolved = resolveSofficeBinary({
      platform: "win32",
      env: {},
      pathEntries: [binDir],
      exists: createExists([com, exe]),
    });

    expect(resolved).toBe(com);
  });

  it("uses macOS app-bundle fallback path when PATH does not contain soffice", () => {
    const macFallback = "/Applications/LibreOffice.app/Contents/MacOS/soffice";
    const resolved = resolveSofficeBinary({
      platform: "darwin",
      env: {},
      pathEntries: ["/usr/local/bin"],
      exists: createExists([macFallback]),
    });

    expect(resolved).toBe(macFallback);
  });

  it("uses Linux fallback candidates when PATH misses soffice", () => {
    const resolved = resolveSofficeBinary({
      platform: "linux",
      env: {},
      pathEntries: ["/opt/bin"],
      exists: createExists(["/usr/bin/soffice"]),
    });

    expect(resolved).toBe("/usr/bin/soffice");
  });

  it("builds user-installation URI correctly across unix and windows", () => {
    const unixUri = toUserInstallationUri("linux", "/tmp/lo profile");
    const winUri = toUserInstallationUri("win32", "C:\\Temp\\lo profile");

    expect(unixUri).toBe("file:///tmp/lo%20profile");
    expect(winUri).toBe("file:///C:/Temp/lo%20profile");
  });

  it("builds profile macro paths without hardcoded OS home conventions", () => {
    const linuxLayout = buildProfileLayout("linux", "/tmp/lo-profile-123");
    const winLayout = buildProfileLayout("win32", "C:\\Temp\\lo-profile-456");

    expect(linuxLayout.macroDir).toBe("/tmp/lo-profile-123/user/basic/Standard");
    expect(linuxLayout.macroFile).toBe("/tmp/lo-profile-123/user/basic/Standard/Module1.xba");
    expect(winLayout.macroDir).toBe("C:\\Temp\\lo-profile-456\\user\\basic\\Standard");
    expect(winLayout.macroFile).toBe("C:\\Temp\\lo-profile-456\\user\\basic\\Standard\\Module1.xba");
  });

  it("injects UserInstallation profile into soffice macro args", () => {
    const args = buildMacroExecutionArgs({
      userInstallationUri: "file:///tmp/lo-profile-789",
      scriptUri: "vnd.sun.star.script:Standard.Module1.RecalculateAndSave?language=Basic&location=application",
      workbookPath: "/tmp/input.xlsx",
    });

    expect(args).toEqual([
      "--headless",
      "--norestore",
      "-env:UserInstallation=file:///tmp/lo-profile-789",
      "vnd.sun.star.script:Standard.Module1.RecalculateAndSave?language=Basic&location=application",
      "/tmp/input.xlsx",
    ]);
  });
});
