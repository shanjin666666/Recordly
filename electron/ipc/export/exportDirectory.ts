import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

function settingsPath() {
	return path.join(app.getPath("userData"), "export-directory.json");
}

export async function getExportDefaultPath(fileName: string): Promise<string> {
	let directory = app.getPath("downloads");
	try {
		const saved = JSON.parse(await fs.readFile(settingsPath(), "utf8"));
		if (typeof saved?.directory === "string" && path.isAbsolute(saved.directory)) {
			const stat = await fs.stat(saved.directory);
			if (stat.isDirectory()) {
				await fs.access(saved.directory, constants.W_OK | constants.X_OK);
				directory = saved.directory;
			}
		}
	} catch {
		// Missing preferences or unavailable removable drives fall back to Downloads.
	}
	return path.join(directory, path.basename(fileName));
}

export async function rememberExportDirectory(filePath: string): Promise<void> {
	const destination = settingsPath();
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try {
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(
			temporary,
			JSON.stringify({ directory: path.dirname(path.resolve(filePath)) }),
			"utf8",
		);
		await fs.rename(temporary, destination);
	} catch (error) {
		// The video has already been saved; a preference failure must not fail export.
		console.warn("Could not remember export directory:", error);
	} finally {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
	}
}
