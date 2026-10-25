import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJob } from "../../lib/job-manager";
import {
	createLoomImporter,
	loadImporterSettings,
} from "../../loom-importer/app";

describe("Loom importer API", () => {
	let root: string;
	let slowSource: ReturnType<typeof Bun.serve>;
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});

	beforeAll(async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "importer-secret";
		root = await mkdtemp(join(tmpdir(), "loom-importer-app-"));
		slowSource = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch() {
				await released;
				return new Response("#EXTM3U\n#EXT-X-ENDLIST");
			},
		});
	});

	afterAll(async () => {
		release();
		slowSource?.stop(true);
		if (root) await rm(root, { recursive: true, force: true });
	});

	function importer() {
		const config = loadImporterSettings({
			LOOM_IMPORTER_WORK_DIR: root,
			LOOM_IMPORTER_ALLOWED_HOSTS: "127.0.0.1",
			LOOM_IMPORTER_MAX_JOBS: "1",
			LOOM_IMPORTER_MAX_QUEUED: "1",
			LOOM_IMPORTER_MIN_FREE_GB: "1",
		});
		config.settings.minFreeBytes = 1;
		return createLoomImporter(config);
	}

	const body = (videoId: string) =>
		JSON.stringify({
			videoId,
			userId: "user",
			videoUrl: `http://127.0.0.1:${slowSource.port}/master.m3u8`,
			outputPresignedUrl: "http://127.0.0.1:9/result.mp4",
		});

	const post = (
		app: ReturnType<typeof importer>["app"],
		payload: string,
		secret = "importer-secret",
	) =>
		app.request("/loom-importer/video/import", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-media-server-secret": secret,
			},
			body: payload,
		});

	test("requires the media server secret", async () => {
		const { app } = importer();
		expect((await post(app, body("a"), "wrong")).status).toBe(401);
		expect((await app.request("/loom-importer/video/status")).status).toBe(401);
	});

	test("keeps waiting imports out of the shared job store and reports them as queued", async () => {
		const { app, stats } = importer();
		const first = (await (await post(app, body("first"))).json()) as {
			jobId: string;
		};
		const second = (await (await post(app, body("second"))).json()) as {
			jobId: string;
		};
		expect(stats()).toEqual({ running: 1, queued: 1 });
		expect(getJob(first.jobId)?.abortController).toBeDefined();
		expect(getJob(second.jobId)).toBeUndefined();
		const status = await app.request(
			`/loom-importer/video/process/${second.jobId}/status`,
			{ headers: { "x-media-server-secret": "importer-secret" } },
		);
		expect(await status.json()).toMatchObject({
			jobId: second.jobId,
			videoId: "second",
			phase: "queued",
		});
		const listing = (await (
			await app.request("/loom-importer/video/status", {
				headers: { "x-media-server-secret": "importer-secret" },
			})
		).json()) as {
			jobs: Array<{ jobId: string; videoId: string; phase: string }>;
		};
		expect(listing.jobs).toContainEqual(
			expect.objectContaining({
				jobId: second.jobId,
				videoId: "second",
				phase: "queued",
			}),
		);
		const full = await post(app, body("third"));
		expect(full.status).toBe(503);
		expect(await full.json()).toMatchObject({ code: "SERVER_BUSY" });
		release();
		const deadline = Date.now() + 10_000;
		while (stats().running + stats().queued > 0 && Date.now() < deadline)
			await Bun.sleep(50);
		expect(getJob(first.jobId)?.phase).toBe("error");
		expect(getJob(second.jobId)?.phase).toBe("error");
	});

	test("rejects malformed jobs", async () => {
		const { app } = importer();
		const response = await post(app, JSON.stringify({ videoId: "x" }));
		expect(response.status).toBe(400);
	});
});
