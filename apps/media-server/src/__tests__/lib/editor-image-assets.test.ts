import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	stageSignedEditorImageAsset,
	validateEditorImageAsset,
} from "../../lib/editor-image-assets";

test.skipIf(!process.env.CAP_WEB_EDITOR_PREPARE_BIN)(
	"uploaded images are decoded, oriented, staged, and reusable after reopening",
	async () => {
		const previousHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
		const root = await mkdtemp(join(tmpdir(), "cap-editor-image-asset-test-"));
		const project = join(root, "recording.cap");
		const source = join(root, "overlay.png");
		let server: ReturnType<typeof Bun.serve> | null = null;
		try {
			await mkdir(project);
			const generated = spawnSync("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=magenta:s=120x80:duration=1",
				"-frames:v",
				"1",
				"-threads",
				"1",
				source,
			]);
			expect(generated.status).toBe(0);
			const bytes = (await stat(source)).size;
			const rotatedSource = join(
				import.meta.dirname,
				"../fixtures/exif-orientation-6.jpg",
			);
			const rotatedBytes = (await stat(rotatedSource)).size;
			const tiffSource = join(import.meta.dirname, "../fixtures/rgb-tiff.tiff");
			const tiffBytes = (await stat(tiffSource)).size;
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const path = new URL(request.url).pathname;
					if (path === "/overlay.png") {
						return new Response(Bun.file(source), {
							headers: {
								"Content-Length": String(bytes),
								ETag: JSON.stringify("image-1"),
								"Content-Type": "image/png",
							},
						});
					}
					if (path === "/rotated.jpg") {
						return new Response(Bun.file(rotatedSource), {
							headers: {
								"Content-Length": String(rotatedBytes),
								ETag: JSON.stringify("image-2"),
								"Content-Type": "image/jpeg",
							},
						});
					}
					if (path === "/rgb-tiff.tiff") {
						return new Response(Bun.file(tiffSource), {
							headers: {
								"Content-Length": String(tiffBytes),
								ETag: JSON.stringify("image-3"),
								"Content-Type": "image/tiff",
							},
						});
					}
					if (path === "/damaged.png") {
						return new Response("not an image", {
							headers: { ETag: JSON.stringify("image-1") },
						});
					}
					return new Response("Not found", { status: 404 });
				},
			});
			const path = `content/images/${randomUUID()}.png`;
			const asset = {
				path,
				name: "Overlay",
				url: `http://127.0.0.1:${server.port}/overlay.png`,
				size: bytes,
				contentType: "image/png",
				objectIdentity: JSON.stringify("image-1"),
			};
			const first = await stageSignedEditorImageAsset(project, asset);
			expect(first).toEqual({ path, name: "Overlay", width: 120, height: 80 });
			expect(await Bun.file(join(project, path)).arrayBuffer()).toEqual(
				await Bun.file(source).arrayBuffer(),
			);
			expect(await stageSignedEditorImageAsset(project, asset)).toEqual(first);
			const rotated = {
				...asset,
				path: `content/images/${randomUUID()}.jpg`,
				url: `http://127.0.0.1:${server.port}/rotated.jpg`,
				size: rotatedBytes,
				contentType: "image/jpeg",
				objectIdentity: JSON.stringify("image-2"),
			};
			expect(await stageSignedEditorImageAsset(project, rotated)).toEqual({
				path: rotated.path,
				name: "Overlay",
				width: 80,
				height: 120,
			});
			expect(await Bun.file(join(project, rotated.path)).arrayBuffer()).toEqual(
				await Bun.file(rotatedSource).arrayBuffer(),
			);
			const tiff = {
				...asset,
				path: `content/images/${randomUUID()}.tiff`,
				name: "TIFF",
				url: `http://127.0.0.1:${server.port}/rgb-tiff.tiff`,
				size: tiffBytes,
				contentType: "image/tiff",
				objectIdentity: JSON.stringify("image-3"),
			};
			expect(await stageSignedEditorImageAsset(project, tiff)).toEqual({
				path: tiff.path,
				name: "TIFF",
				width: 120,
				height: 80,
			});
			expect(await Bun.file(join(project, tiff.path)).arrayBuffer()).toEqual(
				await Bun.file(tiffSource).arrayBuffer(),
			);
			expect(() =>
				validateEditorImageAsset({ ...asset, path: "../private.png" }),
			).toThrow("Invalid editor image asset");
			expect(() =>
				validateEditorImageAsset({ ...asset, contentType: "video/mp4" }),
			).toThrow("Invalid editor image asset");
			const changed = {
				...asset,
				path: `content/images/${randomUUID()}.png`,
				objectIdentity: JSON.stringify("other"),
			};
			await expect(
				stageSignedEditorImageAsset(project, changed),
			).rejects.toThrow("identity changed");
			expect(await Bun.file(join(project, changed.path)).exists()).toBe(false);
			const damaged = {
				...asset,
				path: `content/images/${randomUUID()}.png`,
				url: `http://127.0.0.1:${server.port}/damaged.png`,
				size: 12,
			};
			await expect(
				stageSignedEditorImageAsset(project, damaged),
			).rejects.toThrow("no decodable image");
			expect(await Bun.file(join(project, damaged.path)).exists()).toBe(false);
			const wrongFormat = {
				...asset,
				path: `content/images/${randomUUID()}.jpg`,
				contentType: "image/jpeg",
			};
			await expect(
				stageSignedEditorImageAsset(project, wrongFormat),
			).rejects.toThrow("format does not match");
			expect(await Bun.file(join(project, wrongFormat.path)).exists()).toBe(
				false,
			);
		} finally {
			server?.stop(true);
			await rm(root, { recursive: true, force: true });
			if (previousHttp === undefined)
				delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
			else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttp;
		}
	},
);
