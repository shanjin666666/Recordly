import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: {
		getAppPath: () => process.cwd(),
		getPath: () => process.env.TMPDIR ?? process.env.TEMP ?? "/tmp",
		isPackaged: false,
	},
	BrowserWindow: {
		fromWebContents: () => null,
	},
	dialog: {
		showSaveDialog: vi.fn(),
	},
	ipcMain: {
		handle: vi.fn(),
		on: vi.fn(),
	},
	powerSaveBlocker: {
		isStarted: () => true,
		start: () => 1,
		stop: vi.fn(),
	},
}));

vi.mock("../ffmpeg/binary", () => ({
	getFfmpegBinaryPath: () => "ffmpeg",
}));

vi.mock("../export/exportDirectory", () => ({
	getExportDefaultPath: vi.fn(async (name: string) => path.join("/previous-export", name)),
	rememberExportDirectory: vi.fn(async () => {}),
}));

import { dialog, ipcMain } from "electron";
import { getExportDefaultPath, rememberExportDirectory } from "../export/exportDirectory";
import { registerOwnedExportPath, releaseOwnedExportPath } from "../export/exportStream";
import { moveExportedTempFile, registerExportHandlers } from "./export";

const tempDirs: string[] = [];

async function makeTempDir() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-export-move-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.allSettled(
		tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
	);
});

describe("moveExportedTempFile", () => {
	it("moves an app-managed export temp file to the selected destination", async () => {
		const dir = await makeTempDir();
		const tempPath = path.join(dir, "export-temp.mp4");
		const destinationPath = path.join(dir, "export-final.mp4");
		await fs.writeFile(tempPath, "recordly-export");

		await moveExportedTempFile(tempPath, destinationPath);

		await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("recordly-export");
		await expect(fs.access(tempPath)).rejects.toThrow();
	});

	it("falls back when Windows reports the destination already exists during initial rename", async () => {
		const dir = await makeTempDir();
		const tempPath = path.join(dir, "export-temp.mp4");
		const destinationPath = path.join(dir, "export-final.mp4");
		await fs.writeFile(tempPath, "new-export");
		await fs.writeFile(destinationPath, "previous-export");

		const originalRename = fs.rename.bind(fs);
		const renameSpy = vi.spyOn(fs, "rename");
		renameSpy.mockImplementation(async (from, to) => {
			if (from === tempPath && to === destinationPath) {
				const error = new Error("destination exists") as NodeJS.ErrnoException;
				error.code = "EEXIST";
				throw error;
			}

			return originalRename(from, to);
		});

		await moveExportedTempFile(tempPath, destinationPath);

		await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("new-export");
		await expect(fs.access(tempPath)).rejects.toThrow();
	});
});

describe.each([
	"save-exported-video",
	"finalize-exported-video",
])("%s directory preference", (channel) => {
	async function invoke(canceled = false, failWrite = false) {
		vi.mocked(ipcMain.handle).mockClear();
		vi.mocked(rememberExportDirectory).mockClear();
		registerExportHandlers();
		const handler = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1];
		const dir = await makeTempDir();
		const destination = path.join(dir, "saved.gif");
		vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled, filePath: destination });
		const tempPath = path.join(dir, "rendered.gif");
		await fs.writeFile(tempPath, "GIF89a");
		registerOwnedExportPath(tempPath);
		if (failWrite) {
			// A directory cannot be overwritten with the rendered video.
			await fs.mkdir(destination);
			await fs.writeFile(path.join(destination, "keep"), "existing");
			vi.spyOn(console, "error").mockImplementation(() => {});
		}
		try {
			const result =
				channel === "save-exported-video"
					? await handler({ sender: {} } as never, new ArrayBuffer(6), "next.gif")
					: await handler({ sender: {} } as never, { tempPath, fileName: "next.gif" });
			expect(getExportDefaultPath).toHaveBeenCalledWith("next.gif");
			expect(dialog.showSaveDialog).toHaveBeenLastCalledWith(
				expect.objectContaining({ defaultPath: "/previous-export/next.gif" }),
			);
			return { result, destination };
		} finally {
			releaseOwnedExportPath(tempPath);
		}
	}

	it("remembers only a successfully saved destination", async () => {
		const { result, destination } = await invoke();
		expect(result.success).toBe(true);
		expect(rememberExportDirectory).toHaveBeenCalledWith(destination);
	});
	it("does not change the directory when saving is canceled", async () => {
		const { result } = await invoke(true);
		expect(result.canceled).toBe(true);
		expect(rememberExportDirectory).not.toHaveBeenCalled();
	});
	it("does not change the directory when writing the video fails", async () => {
		const { result } = await invoke(false, true);
		expect(result.success).toBe(false);
		expect(rememberExportDirectory).not.toHaveBeenCalled();
	});
});
