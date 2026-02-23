import { spawn } from "child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

let cachedShellConfig: { shell: string; args: string[] } | null = null;

async function existsAsync(p: string): Promise<boolean> {
	try {
		await access(p, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function findBashOnPath(): Promise<string | null> {
	if (process.platform === "win32") {
		return new Promise((resolve) => {
			const child = spawn("where", ["bash.exe"], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			child.stdout.on("data", (data) => (stdout += data.toString()));
			child.on("close", async (code) => {
				if (code === 0 && stdout) {
					const firstMatch = stdout.trim().split(/\r?\n/)[0];
					if (firstMatch && (await existsAsync(firstMatch))) {
						resolve(firstMatch);
						return;
					}
				}
				resolve(null);
			});
			child.on("error", () => resolve(null));
		});
	}

	return new Promise((resolve) => {
		const child = spawn("which", ["bash"], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (data) => (stdout += data.toString()));
		child.on("close", (code) => {
			if (code === 0 && stdout) {
				const firstMatch = stdout.trim().split(/\r?\n/)[0];
				if (firstMatch) {
					resolve(firstMatch);
					return;
				}
			}
			resolve(null);
		});
		child.on("error", () => resolve(null));
	});
}

export async function getShellConfig(): Promise<{ shell: string; args: string[] }> {
	if (cachedShellConfig) {
		return cachedShellConfig;
	}

	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (await existsAsync(path)) {
				cachedShellConfig = { shell: path, args: ["-c"] };
				return cachedShellConfig;
			}
		}

		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
			return cachedShellConfig;
		}

		throw new Error(
			`No bash shell found. Install Git for Windows or add bash to PATH.\nSearched:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	if (await existsAsync("/bin/bash")) {
		cachedShellConfig = { shell: "/bin/bash", args: ["-c"] };
		return cachedShellConfig;
	}

	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		cachedShellConfig = { shell: bashOnPath, args: ["-c"] };
		return cachedShellConfig;
	}

	cachedShellConfig = { shell: "sh", args: ["-c"] };
	return cachedShellConfig;
}

export function getShellEnv(): NodeJS.ProcessEnv {
	return { ...process.env };
}

export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
			});
		} catch {
			// ignore
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// ignore
			}
		}
	}
}
