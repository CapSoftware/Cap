import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	stageSignedEditorAudioAsset,
	validateEditorAudioAsset,
} from "../../lib/editor-assets";

test("uploaded audio is verified, staged, and reusable after reopening", async () => {
	const previousHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
	const root = await mkdtemp(join(tmpdir(), "cap-editor-audio-asset-test-"));
	const project = join(root, "recording.cap");
	const source = join(root, "track.mp3");
	let server: ReturnType<typeof Bun.serve> | null = null;
	try {
		await mkdir(project);
		const generated = spawnSync("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=880:sample_rate=48000:duration=2",
			"-c:a",
			"libmp3lame",
			"-b:a",
			"128k",
			source,
		]);
		expect(generated.status).toBe(0);
		const bytes = (await stat(source)).size;
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/track.mp3") {
					return new Response(Bun.file(source), {
						headers: {
							"Content-Length": String(bytes),
							ETag: '"asset-1"',
							"Content-Type": "audio/mpeg",
						},
					});
				}
				if (path === "/invalid.mp3") {
					return new Response("not audio", {
						headers: { ETag: '"asset-1"' },
					});
				}
				return new Response("Not found", { status: 404 });
			},
		});
		const path = `assets/audio/import-${randomUUID()}.mp3`;
		const asset = {
			path,
			name: "Imported tone",
			url: `http://127.0.0.1:${server.port}/track.mp3`,
			size: bytes,
			contentType: "audio/mpeg",
			objectIdentity: '"asset-1"',
		};
		const first = await stageSignedEditorAudioAsset(project, asset);
		expect(first).toMatchObject({ path, name: "Imported tone" });
		expect(first.duration).toBeGreaterThan(1.9);
		expect(await Bun.file(join(project, path)).arrayBuffer()).toEqual(
			await Bun.file(source).arrayBuffer(),
		);
		expect(await stageSignedEditorAudioAsset(project, asset)).toEqual(first);
		expect(() =>
			validateEditorAudioAsset({ ...asset, path: "../private.mp3" }),
		).toThrow("Invalid editor audio asset");
		expect(() =>
			validateEditorAudioAsset({ ...asset, contentType: "video/mp4" }),
		).toThrow("Invalid editor audio asset");
		const changed = {
			...asset,
			path: `assets/audio/import-${randomUUID()}.mp3`,
			objectIdentity: '"other"',
		};
		await expect(stageSignedEditorAudioAsset(project, changed)).rejects.toThrow(
			"identity changed",
		);
		expect(await Bun.file(join(project, changed.path)).exists()).toBe(false);
		const invalid = {
			...asset,
			path: `assets/audio/import-${randomUUID()}.mp3`,
			url: `http://127.0.0.1:${server.port}/invalid.mp3`,
			size: 9,
		};
		await expect(stageSignedEditorAudioAsset(project, invalid)).rejects.toThrow(
			"no audio stream",
		);
		expect(await Bun.file(join(project, invalid.path)).exists()).toBe(false);
	} finally {
		server?.stop(true);
		await rm(root, { recursive: true, force: true });
		if (previousHttp === undefined)
			delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttp;
	}
});
