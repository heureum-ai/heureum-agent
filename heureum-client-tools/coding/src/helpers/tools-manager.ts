import { spawn } from "child_process";
import { createWriteStream, existsSync } from "fs";
import { access, chmod, mkdir, rename, rm } from "fs/promises";
import { arch, homedir, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { finished } from "stream/promises";

const TOOLS_DIR = join(homedir(), ".heureum", "bin");

interface ToolConfig {
	name: string;
	repo: string;
	binaryName: string;
	tagPrefix: string;
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

async function commandExists(cmd: string): Promise<boolean> {
	try {
		const result = await runSpawnCommand(cmd, ["--version"]);
		return result.status === 0;
	} catch {
		return false;
	}
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath);
		return true;
	} catch {
		return false;
	}
}

type SpawnResult = {
	status: number;
	stdout: string;
	stderr: string;
	error?: NodeJS.ErrnoException;
};

async function runSpawnCommand(command: string, args: string[]): Promise<SpawnResult> {
	return await new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf-8");
		child.stderr?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			resolve({ status: 1, stdout, stderr, error: error as NodeJS.ErrnoException });
		});
		child.on("close", (code) => {
			resolve({ status: code ?? 1, stdout, stderr });
		});
	});
}

export async function getToolPath(tool: "fd" | "rg"): Promise<string | null> {
	const config = TOOLS[tool];
	if (!config) return null;

	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	if (await commandExists(config.binaryName)) {
		return config.binaryName;
	}

	return null;
}

async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": "heureum-coding-tools" },
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await finished(Readable.fromWeb(response.body as any).pipe(fileStream));
}

async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	const version = await getLatestVersion(config.repo);

	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	await mkdir(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	await downloadFile(downloadUrl, archivePath);

	const extractDir = join(TOOLS_DIR, "extract_tmp");
	await mkdir(extractDir, { recursive: true });

	try {
		const extractResult = assetName.endsWith(".tar.gz")
			? await runSpawnCommand("tar", ["xzf", archivePath, "-C", extractDir])
			: assetName.endsWith(".zip")
				? await runSpawnCommand("tar", ["xf", archivePath, "-C", extractDir])
				: null;

		if (!extractResult || extractResult.error || extractResult.status !== 0) {
			const errMsg = extractResult?.error?.message ?? extractResult?.stderr?.trim() ?? "unknown error";
			throw new Error(`Failed to extract ${assetName}: ${errMsg}`);
		}

		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinary = join(extractedDir, config.binaryName + binaryExt);

		if (await pathExists(extractedBinary)) {
			await rename(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: ${extractedBinary}`);
		}

		if (plat !== "win32") {
			await chmod(binaryPath, 0o755);
		}
	} finally {
		await rm(archivePath, { force: true });
		await rm(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

export async function ensureTool(tool: "fd" | "rg", silent: boolean = false): Promise<string | undefined> {
	const existingPath = await getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(`${config.name} not found. Install with: pkg install ${pkgName}`);
		}
		return undefined;
	}

	if (!silent) {
		console.log(`${config.name} not found. Downloading...`);
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(`${config.name} installed to ${path}`);
		}
		return path;
	} catch (e) {
		if (!silent) {
			console.log(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`);
		}
		return undefined;
	}
}
