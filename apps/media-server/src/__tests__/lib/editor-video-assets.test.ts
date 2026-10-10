import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	stageSignedEditorVideoAsset,
	validateEditorVideoAsset,
} from "../../lib/editor-video-assets";

test("a signed imported video is probed once, staged, and reusable after reopening", async () => {
	const previousHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
	const root = await mkdtemp(join(tmpdir(), "cap-editor-video-asset-test-"));
	const project = join(root, "recording.cap");
	const source = join(root, "clip.mp4");
	let server: ReturnType<typeof Bun.serve> | null = null;
	try {
		await mkdir(project);
		const generated = spawnSync("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=160x90:rate=30:duration=2",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			source,
		]);
		expect(generated.status).toBe(0);
		const size = (await stat(source)).size;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/clip.mp4") {
					return new Response(Bun.file(source), {
						headers: {
							"Content-Length": String(size),
							"Content-Type": "video/mp4",
							ETag: JSON.stringify("video-1"),
						},
					});
				}
				return new Response("Not found", { status: 404 });
			},
		});
		const asset = {
			path: `content/videos/${randomUUID()}.mp4`,
			name: "Imported clip",
			url: `http://127.0.0.1:${server.port}/clip.mp4`,
			size,
			contentType: "video/mp4",
			objectIdentity: JSON.stringify("video-1"),
		};
		const imported = await stageSignedEditorVideoAsset(project, asset);
		expect(imported.path).toBe(asset.path);
		expect(imported.name).toBe(asset.name);
		expect(imported.duration).toBeGreaterThan(0);
		expect(imported.fps).toBeGreaterThan(0);
		expect(imported.width).toBeGreaterThan(0);
		expect(imported.height).toBeGreaterThan(0);
		expect(imported.hasAudio).toBe(false);
		expect(await Bun.file(join(project, asset.path)).arrayBuffer()).toEqual(
			await Bun.file(source).arrayBuffer(),
		);
		expect(await stageSignedEditorVideoAsset(project, asset)).toEqual(imported);
		expect(() =>
			validateEditorVideoAsset({ ...asset, path: "../worker-local.mp4" }),
		).toThrow();
		expect(() =>
			validateEditorVideoAsset({ ...asset, size: 13 * 1024 * 1024 * 1024 }),
		).toThrow();
		const changed = {
			...asset,
			path: `content/videos/${randomUUID()}.mp4`,
			objectIdentity: JSON.stringify("other"),
		};
		await expect(stageSignedEditorVideoAsset(project, changed)).rejects.toThrow(
			"identity changed",
		);
		expect(await Bun.file(join(project, changed.path)).exists()).toBe(false);
	} finally {
		server?.stop(true);
		await rm(root, { recursive: true, force: true });
		if (previousHttp === undefined)
			delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttp;
	}
});
