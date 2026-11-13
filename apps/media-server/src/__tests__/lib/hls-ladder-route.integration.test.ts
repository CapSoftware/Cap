import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type appType from "../../app";
import { parseHlsLadderMaster } from "../../lib/hls-ladder";
import type { Job, JobProgress } from "../../lib/job-manager";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "test-with-audio.mp4");
const SECRET = "test-secret";
const HEADERS = {
	"Content-Type": "application/json",
	"x-media-server-secret": SECRET,
};
const LADDER_FILES = [
	"master.m3u8",
	"audio.m3u8",
	"audio.m4s",
	...["2160p", "1440p", "1080p", "720p", "360p"].flatMap((tier) => [
		`${tier}.m3u8`,
		`${tier}.m4s`,
	]),
];

let app: typeof appType;
let getJob: typeof import("../../lib/job-manager").getJob;
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const workDir = mkdtempSync(join(tmpdir(), "cap-ladder-route-"));
const uploads = new Map<string, { bytes: Uint8Array; contentType: string }>();
const webhooks: JobProgress[] = [];

async function waitForTerminalJob(jobId: string): Promise<Job> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 90_000) {
		const job = getJob(jobId);
		if (!job) throw new Error(`Job ${jobId} disappeared`);
		if (["complete", "error", "cancelled"].includes(job.phase)) return job;
		await Bun.sleep(100);
	}
	throw new Error(`Job ${jobId} did not finish`);
}

function uploadTargets(prefix: string, names = LADDER_FILES) {
	return Object.fromEntries(
		names.map((name) => [name, `${baseUrl}/uploads/${prefix}/${name}`]),
	);
}

async function startLadder(body: Record<string, unknown>) {
	const response = await app.request("/video/ladder", {
		method: "POST",
		headers: HEADERS,
		body: JSON.stringify({
			videoId: "video-1",
			userId: "user-1",
			videoUrl: `${baseUrl}/fixture.mp4`,
			webhookUrl: `${baseUrl}/webhook`,
			...body,
		}),
	});
	return response;
}

beforeAll(async () => {
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;
	process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES = "4";
	app = (await import("../../app")).default;
	getJob = (await import("../../lib/job-manager")).getJob;
	const fixture = readFileSync(FIXTURE);
	const largePath = join(workDir, "large.mp4");
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=1280x720:rate=30:duration=3",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-y",
		largePath,
	]);
	const large = readFileSync(largePath);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/webhook") {
				webhooks.push((await request.json()) as JobProgress);
				return new Response(null, { status: 200 });
			}
			if (request.method === "PUT" && url.pathname.startsWith("/uploads/")) {
				uploads.set(url.pathname.slice("/uploads/".length), {
					bytes: new Uint8Array(await request.arrayBuffer()),
					contentType: request.headers.get("content-type") ?? "",
				});
				return new Response(null, { status: 200, headers: { ETag: '"x"' } });
			}
			const source =
				url.pathname === "/fixture.mp4"
					? fixture
					: url.pathname === "/large.mp4"
						? large
						: null;
			if (source) {
				return new Response(source, {
					headers: {
						"Content-Type": "video/mp4",
						"Content-Length": String(source.byteLength),
					},
				});
			}
			return new Response(null, { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	rmSync(workDir, { recursive: true, force: true });
});

function imageSize(bytes: Uint8Array): string {
	const path = join(workDir, "poster.jpg");
	writeFileSync(path, bytes);
	return execFileSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"stream=width,height",
			"-of",
			"csv=p=0:s=x",
			path,
		],
		{ encoding: "utf8" },
	).trim();
}

describe("POST /video/ladder", () => {
	test("rejects a request without the shared secret", async () => {
		const response = await app.request("/video/ladder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(401);
	});

	test("rejects upload targets that are not ladder files", async () => {
		const response = await startLadder({
			uploads: { "../escape.m4s": `${baseUrl}/uploads/x` },
		});
		expect(response.status).toBe(400);
	});

	test("encodes, uploads every file and reports the ladder", async () => {
		const response = await startLadder({ uploads: uploadTargets("whole") });
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(jobId);
		expect(job.error).toBeUndefined();
		expect(job.phase).toBe("complete");

		const ladder = job.ladder;
		expect(ladder?.renditions.length).toBeGreaterThan(0);
		expect(ladder?.audio?.media).toBe("audio.m4s");
		const master = uploads.get("whole/master.m3u8");
		expect(master?.contentType).toBe("application/vnd.apple.mpegurl");
		const parsed = parseHlsLadderMaster(
			new TextDecoder().decode(master?.bytes),
		);
		expect(parsed.video.map((variant) => variant.name)).toEqual(
			ladder?.renditions.map((rendition) => rendition.name) ?? [],
		);
		for (const rendition of ladder?.renditions ?? []) {
			const media = uploads.get(`whole/${rendition.media}`);
			expect(media?.bytes.byteLength).toBe(rendition.bytes);
			expect(media?.contentType).toBe("video/mp4");
			expect(uploads.has(`whole/${rendition.playlist}`)).toBe(true);
		}
		expect(uploads.get("whole/audio.m4s")?.bytes.byteLength).toBe(
			ladder?.audio?.bytes ?? -1,
		);

		const final = webhooks.findLast((payload) => payload.jobId === jobId);
		expect(final?.phase).toBe("complete");
		expect(final?.ladder?.renditions.length).toBe(ladder?.renditions.length);
	}, 120_000);

	test("takes the poster from the largest rendition it encoded", async () => {
		const response = await startLadder({
			videoUrl: `${baseUrl}/large.mp4`,
			maxTier: "360p",
			uploads: uploadTargets("poster"),
			thumbnailPresignedUrl: `${baseUrl}/uploads/poster/poster.jpg`,
		});
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(jobId);
		expect(job.error).toBeUndefined();
		expect(job.phase).toBe("complete");
		expect(job.ladder?.renditions.map((rendition) => rendition.name)).toEqual([
			"360p",
		]);
		const poster = uploads.get("poster/poster.jpg");
		expect(poster?.contentType).toBe("image/jpeg");
		expect(imageSize(poster?.bytes ?? new Uint8Array())).toBe("640x360");
	}, 120_000);

	test("fails the job when the poster cannot be uploaded", async () => {
		const response = await startLadder({
			uploads: uploadTargets("poster-refused"),
			thumbnailPresignedUrl: `${baseUrl}/refused/poster.jpg`,
		});
		const { jobId } = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(jobId);
		expect(job.phase).toBe("error");
	}, 120_000);

	test("encodes one slice without audio when asked", async () => {
		const response = await startLadder({
			uploads: uploadTargets("slice"),
			range: { startSeconds: 0, durationSeconds: 4 },
			includeAudio: false,
		});
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(jobId);
		expect(job.error).toBeUndefined();
		expect(job.ladder?.audio).toBeNull();
		expect(uploads.has("slice/audio.m4s")).toBe(false);
		expect(uploads.has("slice/master.m3u8")).toBe(true);
	}, 120_000);

	test("fails the job when a produced file has no upload target", async () => {
		const response = await startLadder({
			uploads: uploadTargets("partial", ["master.m3u8"]),
		});
		const { jobId } = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(jobId);
		expect(job.phase).toBe("error");
		expect(job.error).toContain("No upload target");
		expect(uploads.has("partial/master.m3u8")).toBe(false);
	}, 120_000);
});
