import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({ userData: "", downloads: "" }));
vi.mock("electron", () => ({ app: { getPath: (key: keyof typeof paths) => paths[key] } }));
import { getExportDefaultPath, rememberExportDirectory } from "./exportDirectory";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-export-directory-"));
	paths.userData = path.join(root, "settings");
	paths.downloads = path.join(root, "Downloads");
	await fs.mkdir(paths.downloads);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

describe("export directory persistence", () => {
	it("uses Downloads initially and remembers the directory across module reloads and formats", async () => {
		expect(await getExportDefaultPath("first.mp4")).toBe(
			path.join(paths.downloads, "first.mp4"),
		);
		const chosen = path.join(root, "我的视频");
		await fs.mkdir(chosen);
		await rememberExportDirectory(path.join(chosen, "first.mp4"));
		vi.resetModules();
		const reloaded = await import("./exportDirectory");
		expect(await reloaded.getExportDefaultPath("next.gif")).toBe(path.join(chosen, "next.gif"));
		await reloaded.rememberExportDirectory(path.join(paths.downloads, "third.mp4"));
		expect(await getExportDefaultPath("fourth.mp4")).toBe(
			path.join(paths.downloads, "fourth.mp4"),
		);
	});

	it("falls back when the previous directory is removed", async () => {
		const chosen = path.join(root, "external-drive");
		await fs.mkdir(chosen);
		await rememberExportDirectory(path.join(chosen, "first.mp4"));
		await fs.rmdir(chosen);
		expect(await getExportDefaultPath("next.mp4")).toBe(path.join(paths.downloads, "next.mp4"));
	});

	it("falls back for corrupt preferences and paths that are files", async () => {
		await fs.mkdir(paths.userData);
		const preference = path.join(paths.userData, "export-directory.json");
		await fs.writeFile(preference, "broken-json");
		expect(await getExportDefaultPath("next.gif")).toBe(path.join(paths.downloads, "next.gif"));
		await fs.writeFile(preference, JSON.stringify({ directory: preference }));
		expect(await getExportDefaultPath("next.gif")).toBe(path.join(paths.downloads, "next.gif"));
	});

	it("does not turn an already saved video into a failed export if preferences cannot be written", async () => {
		await fs.writeFile(paths.userData, "not a directory");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(
			rememberExportDirectory(path.join(paths.downloads, "saved.mp4")),
		).resolves.toBeUndefined();
	});
});
