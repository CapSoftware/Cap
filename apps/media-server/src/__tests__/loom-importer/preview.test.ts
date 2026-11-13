import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoomImporter,
	loadImporterSettings,
} from "../../loom-importer/app";
import { renderPreviewGif } from "../../loom-importer/preview";

describe("Loom preview GIF", () => {
	let root: string;
	let server: ReturnType<typeof Bun.serve>;
	const uploads: Array<{ type: string | null; bytes: number }> = [];

	beforeAll(async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "importer-secret";
		root = await mkdtemp(join(tmpdir(), "loom-preview-"));
		const result = spawnSync("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc=size=320x180:rate=30:duration=6",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
			join(root, "result.mp4"),
		]);
		if (result.status !== 0) throw new Error(String(result.stderr));
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method === "PUT") {
					const body = await request.arrayBuffer();
					uploads.push({
						type: request.headers.get("content-type"),
						bytes: body.byteLength,
					});
					return new Response(null, { headers: { ETag: '"gif"' } });
				}
				return new Response(Bun.file(join(root, url.pathname.slice(1))));
			},
		});
	});

	afterAll(async () => {
		server?.stop(true);
		if (root) await rm(root, { recursive: true, force: true });
	});

	test("renders a GIF from the finished video and uploads it", async () => {
		await renderPreviewGif(
			{
				videoUrl: `http://127.0.0.1:${server.port}/result.mp4`,
				previewGifPresignedUrl: `http://127.0.0.1:${server.port}/upload/preview.gif`,
				duration: 6,
			},
			AbortSignal.timeout(60_000),
		);
		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.type).toBe("image/gif");
		expect(uploads[0]?.bytes).toBeGreaterThan(1000);
	});

	test("requires the secret and an HTTP source", async () => {
		const { app } = createLoomImporter(
			loadImporterSettings({ LOOM_IMPORTER_WORK_DIR: root }),
		);
		const post = (body: unknown, secret = "importer-secret") =>
			app.request("/loom-importer/video/preview-gif", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-media-server-secret": secret,
				},
				body: JSON.stringify(body),
			});
		const body = {
			videoUrl: "file:///etc/passwd",
			previewGifPresignedUrl: "https://storage.example.com/p.gif",
			duration: 6,
		};
		expect((await post(body, "wrong")).status).toBe(401);
		expect((await post(body)).status).toBe(400);
		expect((await post({ ...body, duration: 0 })).status).toBe(400);
	});
});
