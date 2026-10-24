import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";
import { createJob, generateJobId, getJob } from "../../lib/job-manager";
import { Semaphore } from "../../loom-importer/fetch";
import {
	type ImporterSettings,
	type ImportRequest,
	runLoomImport,
} from "../../loom-importer/job";

const SIGNATURE = "Policy=signed&Signature=s&Key-Pair-Id=k";

function ffmpeg(args: string[], cwd: string) {
	const result = spawnSync({
		cmd: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args],
		cwd,
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(result.stderr.toString().slice(-2000));
}

async function ffmpegAsync(args: string[], cwd: string) {
	const proc = Bun.spawn({
		cmd: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args],
		cwd,
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr.slice(-2000));
}

function probe(path: string) {
	const result = spawnSync({
		cmd: [
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"stream=codec_type,codec_name,width,start_time:format=duration",
			"-of",
			"json",
			path,
		],
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return JSON.parse(result.stdout.toString()) as {
		streams: Array<{
			codec_type: string;
			codec_name: string;
			width?: number;
			start_time: string;
		}>;
		format: { duration: string };
	};
}

function streamStart(output: ReturnType<typeof probe>, type: string) {
	return Number(
		output.streams.find((stream) => stream.codec_type === type)?.start_time,
	);
}

describe("runLoomImport", () => {
	let root: string;
	let server: ReturnType<typeof Bun.serve>;
	let base: string;
	const uploads = new Map<string, Uint8Array>();
	const webhooks: Array<Record<string, unknown>> = [];
	const sourceRequests: string[] = [];

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "loom-importer-test-"));
		const hls = join(root, "hls");
		const dash = join(root, "dash");
		await mkdir(hls);
		await mkdir(dash);
		ffmpeg(
			[
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=320x240:rate=30",
				"-itsoffset",
				"0.25",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:sample_rate=48000",
				"-t",
				"9",
				"-map",
				"0:v",
				"-map",
				"0:v",
				"-map",
				"1:a",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-g",
				"30",
				"-s:v:1",
				"160x120",
				"-b:v:0",
				"600k",
				"-b:v:1",
				"150k",
				"-c:a",
				"aac",
				"-f",
				"hls",
				"-hls_time",
				"2",
				"-hls_playlist_type",
				"vod",
				"-master_pl_name",
				"master.m3u8",
				"-var_stream_map",
				"v:0,agroup:aud v:1,agroup:aud a:0,agroup:aud,default:yes",
				"-hls_segment_filename",
				"stream%v-%03d.ts",
				"stream%v.m3u8",
			],
			hls,
		);
		ffmpeg(
			[
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=320x240:rate=30",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:sample_rate=48000",
				"-t",
				"9",
				"-c:v",
				"libvpx-vp9",
				"-deadline",
				"realtime",
				"-cpu-used",
				"8",
				"-b:v",
				"300k",
				"-g",
				"60",
				"-c:a",
				"libopus",
				"-f",
				"dash",
				"-seg_duration",
				"2",
				"-use_template",
				"1",
				"-use_timeline",
				"1",
				"-dash_segment_type",
				"webm",
				"manifest.mpd",
			],
			dash,
		);
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname.startsWith("/open/")) {
					const file = Bun.file(join(root, url.pathname.slice(6)));
					return (await file.exists())
						? new Response(file)
						: new Response("missing", { status: 404 });
				}
				if (url.pathname.startsWith("/media/")) {
					sourceRequests.push(url.pathname);
					if (url.searchParams.get("Signature") !== "s")
						return new Response("missing signature", { status: 403 });
					const file = Bun.file(join(root, url.pathname.slice(7)));
					return (await file.exists())
						? new Response(file)
						: new Response("missing", { status: 404 });
				}
				if (url.pathname.startsWith("/put/") && request.method === "PUT") {
					uploads.set(
						url.pathname.slice(5),
						new Uint8Array(await request.arrayBuffer()),
					);
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag"' },
					});
				}
				if (url.pathname === "/webhook") {
					webhooks.push(await request.json());
					return Response.json({ success: true });
				}
				return new Response("not found", { status: 404 });
			},
		});
		base = `http://127.0.0.1:${server.port}`;
	}, 120_000);

	afterAll(async () => {
		server?.stop(true);
		if (root) await rm(root, { recursive: true, force: true });
	});

	const settings = (): ImporterSettings => ({
		workRoot: join(root, "work"),
		allowedHosts: ["127.0.0.1"],
		globalSemaphore: new Semaphore(64),
		jobConnections: 8,
		rangedConnections: 4,
		segmentAttempts: 2,
		segmentTimeoutMs: 10_000,
		remuxTimeoutMs: 60_000,
		terminalWebhookAttempts: 2,
		minFreeBytes: 1,
	});

	const request = (
		videoId: string,
		videoUrl: string,
		extra: Partial<ImportRequest> = {},
	): ImportRequest => ({
		videoId,
		userId: "user",
		videoUrl,
		outputPresignedUrl: `${base}/put/${videoId}/result.mp4`,
		thumbnailPresignedUrl: `${base}/put/${videoId}/thumbnail.jpg`,
		previewGifPresignedUrl: `${base}/put/${videoId}/preview.gif`,
		webhookUrl: `${base}/webhook`,
		...extra,
	});

	async function run(input: ImportRequest) {
		const job = createJob(
			generateJobId(),
			input.videoId,
			input.userId,
			input.webhookUrl,
		);
		await runLoomImport(
			job,
			input,
			settings(),
			new Semaphore(8),
			new AbortController().signal,
		);
		return getJob(job.jobId);
	}

	test("imports the best HLS variant as a playable MP4 with unchanged timing", async () => {
		const job = await run(
			request("hls-video", `${base}/media/hls/master.m3u8?${SIGNATURE}`),
		);
		expect(job?.phase).toBe("complete");
		expect(job?.deferredSourceKey).toBeUndefined();
		expect(job?.metadata).toMatchObject({
			width: 320,
			height: 240,
			fps: 30,
			videoCodec: "h264",
			audioCodec: "aac",
		});
		const uploaded = uploads.get("hls-video/result.mp4");
		expect(uploaded?.byteLength).toBeGreaterThan(10_000);
		expect(uploads.get("hls-video/thumbnail.jpg")?.byteLength).toBeGreaterThan(
			0,
		);
		expect(uploads.get("hls-video/preview.gif")?.byteLength).toBeGreaterThan(0);
		const imported = join(root, "imported.mp4");
		await writeFile(imported, uploaded ?? new Uint8Array());
		const reference = join(root, "reference.mp4");
		await ffmpegAsync(
			[
				"-protocol_whitelist",
				"file,http,tcp",
				"-i",
				`${base}/open/hls/master.m3u8`,
				"-map",
				"0:v:0",
				"-map",
				"0:a:0",
				"-c",
				"copy",
				reference,
			],
			root,
		);
		const importedProbe = probe(imported);
		const referenceProbe = probe(reference);
		expect(
			importedProbe.streams.find((s) => s.codec_type === "video")?.width,
		).toBe(320);
		const offset = (output: ReturnType<typeof probe>) =>
			streamStart(output, "audio") - streamStart(output, "video");
		expect(offset(importedProbe)).toBeCloseTo(offset(referenceProbe), 3);
		expect(offset(importedProbe)).toBeCloseTo(0.25, 1);
		expect(Number(importedProbe.format.duration)).toBeCloseTo(
			Number(referenceProbe.format.duration),
			0,
		);
		expect(sourceRequests.some((path) => path.includes("stream1-"))).toBe(
			false,
		);
		const complete = webhooks.findLast(
			(payload) => payload.videoId === "hls-video",
		);
		expect(complete?.phase).toBe("complete");
		expect(complete?.metadata).toMatchObject({ width: 320, fps: 30 });
	}, 60_000);

	test("stores VP9 DASH as the original WebM and reports it for deferred processing", async () => {
		const job = await run(
			request("dash-video", `${base}/media/dash/manifest.mpd?${SIGNATURE}`, {
				originalUpload: {
					key: "user/dash-video/raw-upload.webm",
					upload: { type: "put", url: `${base}/put/dash-video/raw.webm` },
				},
			}),
		);
		expect(job?.phase).toBe("complete");
		expect(job?.deferredSourceKey).toBe("user/dash-video/raw-upload.webm");
		expect(job?.metadata).toMatchObject({
			videoCodec: "vp9",
			audioCodec: "opus",
			width: 320,
		});
		expect(job?.metadata?.duration).toBeCloseTo(9, 0);
		expect(uploads.has("dash-video/result.mp4")).toBe(false);
		const original = join(root, "original.webm");
		await writeFile(
			original,
			uploads.get("dash-video/raw.webm") ?? new Uint8Array(),
		);
		const originalProbe = probe(original);
		expect(originalProbe.streams.map((s) => s.codec_name).sort()).toEqual([
			"opus",
			"vp9",
		]);
		const complete = webhooks.findLast(
			(payload) => payload.videoId === "dash-video",
		);
		expect(complete?.deferredSourceKey).toBe("user/dash-video/raw-upload.webm");
	}, 60_000);

	test("fails VP9 sources that have nowhere to store the original", async () => {
		const job = await run(
			request("dash-no-target", `${base}/media/dash/manifest.mpd?${SIGNATURE}`),
		);
		expect(job?.phase).toBe("error");
		expect(job?.error).toContain("original upload target");
	}, 60_000);

	test("fails without retrying forever when segments are not signed", async () => {
		const job = await run(
			request("unsigned", `${base}/media/hls/master.m3u8?Policy=x`),
		);
		expect(job?.phase).toBe("error");
		expect(job?.error).toContain("403");
	}, 60_000);

	test("refuses sources outside the allowed hosts", async () => {
		const job = await run(
			request("foreign", "https://example.com/master.m3u8?Policy=x"),
		);
		expect(job?.phase).toBe("error");
		expect(job?.error).toContain("not allowed");
	});

	test("leaves no working files behind", async () => {
		expect(await readdir(join(root, "work"))).toEqual([]);
	});
});
