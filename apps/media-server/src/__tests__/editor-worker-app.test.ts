import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../editor-worker-app";
import { editorWallpaperDirectory } from "../lib/editor-wallpapers";

const originalPrepare = process.env.CAP_WEB_EDITOR_PREPARE_BIN;
const originalService = process.env.CAP_WEB_EDITOR_SERVICE_BIN;
const originalPublicOrigin = process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
const originalWallpaperDirectory = process.env.CAP_WEB_EDITOR_WALLPAPER_DIR;
const originalCameraRemoval = process.env.CAP_WEB_EDITOR_ENABLE_CAMERA_REMOVAL;
const originalOrtPath = process.env.ORT_DYLIB_PATH;

afterEach(() => {
	if (originalPrepare === undefined)
		delete process.env.CAP_WEB_EDITOR_PREPARE_BIN;
	else process.env.CAP_WEB_EDITOR_PREPARE_BIN = originalPrepare;
	if (originalService === undefined)
		delete process.env.CAP_WEB_EDITOR_SERVICE_BIN;
	else process.env.CAP_WEB_EDITOR_SERVICE_BIN = originalService;
	if (originalPublicOrigin === undefined)
		delete process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
	else process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = originalPublicOrigin;
	if (originalWallpaperDirectory === undefined)
		delete process.env.CAP_WEB_EDITOR_WALLPAPER_DIR;
	else process.env.CAP_WEB_EDITOR_WALLPAPER_DIR = originalWallpaperDirectory;
	if (originalCameraRemoval === undefined)
		delete process.env.CAP_WEB_EDITOR_ENABLE_CAMERA_REMOVAL;
	else process.env.CAP_WEB_EDITOR_ENABLE_CAMERA_REMOVAL = originalCameraRemoval;
	if (originalOrtPath === undefined) delete process.env.ORT_DYLIB_PATH;
	else process.env.ORT_DYLIB_PATH = originalOrtPath;
});

describe("dedicated editor worker", () => {
	test("reports readiness only with both native binaries and a public origin", async () => {
		delete process.env.CAP_WEB_EDITOR_ENABLE_CAMERA_REMOVAL;
		delete process.env.CAP_WEB_EDITOR_PREPARE_BIN;
		delete process.env.CAP_WEB_EDITOR_SERVICE_BIN;
		delete process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
		const unavailable = await app.request("/health");
		expect(unavailable.status).toBe(503);

		process.env.CAP_WEB_EDITOR_PREPARE_BIN = process.execPath;
		process.env.CAP_WEB_EDITOR_SERVICE_BIN = process.execPath;
		process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = "http://127.0.0.1:3457";
		const wallpaperDirectory = editorWallpaperDirectory();
		process.env.CAP_WEB_EDITOR_WALLPAPER_DIR = join(
			tmpdir(),
			`cap-editor-missing-wallpapers-${randomUUID()}`,
		);
		expect((await app.request("/health")).status).toBe(503);
		process.env.CAP_WEB_EDITOR_WALLPAPER_DIR = wallpaperDirectory;
		const ready = await app.request("/health");
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ok" });
		process.env.CAP_WEB_EDITOR_ENABLE_CAMERA_REMOVAL = "1";
		delete process.env.ORT_DYLIB_PATH;
		expect((await app.request("/health")).status).toBe(503);
		process.env.ORT_DYLIB_PATH = join(
			tmpdir(),
			`cap-editor-missing-ort-${randomUUID()}`,
		);
		expect((await app.request("/health")).status).toBe(503);
		process.env.ORT_DYLIB_PATH = process.execPath;
		expect((await app.request("/health")).status).toBe(200);
	});

	test("serves editor routes without the media processing routes", async () => {
		const editor = await app.request("/editor/preparations", {
			method: "POST",
		});
		expect(editor.status).toBe(401);
		const media = await app.request("/video/process", { method: "POST" });
		expect(media.status).toBe(404);
	});
});
