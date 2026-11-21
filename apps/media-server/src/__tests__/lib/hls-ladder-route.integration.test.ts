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
let jobManager: typeof import("../../lib/job-manager");
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const workDir = mkdtempSync(join(tmpdir(), "cap-ladder-route-"));
const uploads = new Map<string, { bytes: Uint8Array; contentType: string }>();
const webhooks: JobProgress[] = [];
const webhookListeners = new Map<string, () => void>();
let hangingUploads: {
	started: PromiseWithResolvers<void>;
	aborted: PromiseWithResolvers<void>;
} | null = null;

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
	jobManager = await import("../../lib/job-manager");
	getJob = jobManager.getJob;
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
				const payload = (await request.json()) as JobProgress;
				webhooks.push(payload);
				webhookListeners.get(`${payload.jobId}:${payload.phase}`)?.();
				return new Response(null, { status: 200 });
			}
			if (request.method === "PUT" && url.pathname.startsWith("/hang/")) {
				const hang = hangingUploads;
				if (!hang) return new Response(null, { status: 404 });
				hang.started.resolve();
				if (!request.signal.aborted) {
					await new Promise<void>((resolve) =>
						request.signal.addEventListener("abort", () => resolve(), {
							once: true,
						}),
					);
				}
				hang.aborted.resolve();
				return new Response(null, { status: 499 });
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

	test("rejects idle with Infra or a slice, and verification or pruning of a slice", async () => {
		for (const body of [
			{ priority: "idle", infra: true },
			{ priority: "idle", range: { startSeconds: 0, durationSeconds: 4 } },
			{ verify: true, range: { startSeconds: 0, durationSeconds: 4 } },
			{
				pruneInvertedRungs: true,
				range: { startSeconds: 0, durationSeconds: 4 },
			},
		]) {
			const response = await startLadder({
				uploads: uploadTargets("refused"),
				...body,
			});
			expect(response.status).toBe(400);
		}
		expect(uploads.has("refused/master.m3u8")).toBe(false);
	});

	test("holds an idle ladder back while another idle job or a heavy ladder runs", async () => {
		jobManager.createJob("held-idle", "other", "user-1", undefined, undefined, {
			idle: true,
		});
		try {
			const response = await startLadder({
				uploads: uploadTargets("idle-held"),
				priority: "idle",
			});
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBe("600");
			const body = (await response.json()) as {
				code: string;
				jobs: { jobId: string; idle?: boolean }[];
			};
			expect(body.code).toBe("SERVER_BUSY");
			expect(body.jobs.find((job) => job.jobId === "held-idle")?.idle).toBe(
				true,
			);
		} finally {
			jobManager.deleteJob("held-idle");
		}

		const heavyJob = jobManager.createJob("held-heavy", "other", "user-1");
		heavyJob.heavyLadder = true;
		try {
			const response = await startLadder({
				uploads: uploadTargets("idle-held"),
				priority: "idle",
			});
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBe("600");
		} finally {
			jobManager.deleteJob("held-heavy");
		}
		expect(uploads.has("idle-held/master.m3u8")).toBe(false);
	});

	test("runs an idle ladder only below half CPU and echoes what it applied", async () => {
		const { cpuPressure } = jobManager.getSystemResources();
		const response = await startLadder({
			uploads: uploadTargets("idle"),
			priority: "idle",
			verify: true,
			pruneInvertedRungs: true,
		});
		if (cpuPressure >= 0.5) {
			expect(response.status).toBe(503);
			expect(response.headers.get("retry-after")).toBe("600");
			return;
		}
		expect(response.status).toBe(200);
		const started = (await response.json()) as {
			jobId: string;
			status: string;
			accepted: unknown;
		};
		expect(started.status).toBe("queued");
		expect(started.accepted).toEqual({
			priority: "idle",
			verify: true,
			pruneInvertedRungs: true,
		});
		const job = await waitForTerminalJob(started.jobId);
		expect(job.error).toBeUndefined();
		expect(job.phase).toBe("complete");
		const progress = jobManager.getJobProgress(job);
		expect(progress.idle).toBe(true);
		expect(progress.verified).toBe(true);
		expect(progress.pruned).toEqual([]);
	});

	test("stops a running idle ladder as soon as another ladder is admitted", async () => {
		const { cpuPressure } = jobManager.getSystemResources();
		const idleResponse = await startLadder({
			videoUrl: `${baseUrl}/large.mp4`,
			uploads: uploadTargets("preempted"),
			priority: "idle",
			verify: true,
		});
		if (cpuPressure >= 0.5) {
			expect(idleResponse.status).toBe(503);
			return;
		}
		expect(idleResponse.status).toBe(200);
		const idle = (await idleResponse.json()) as { jobId: string };

		const otherResponse = await startLadder({
			uploads: uploadTargets("after-preempt"),
		});
		expect(otherResponse.status).toBe(200);
		const other = (await otherResponse.json()) as { jobId: string };

		const idleJob = await waitForTerminalJob(idle.jobId);
		expect(idleJob.phase).toBe("error");
		expect(idleJob.errorCode).toBe("idle-preempted");
		const status = await app.request(`/video/process/${idle.jobId}/status`, {
			headers: HEADERS,
		});
		const body = (await status.json()) as JobProgress;
		expect(body.errorCode).toBe("idle-preempted");
		expect(body.retryable).toBe(true);

		const otherJob = await waitForTerminalJob(other.jobId);
		expect(otherJob.phase).toBe("complete");
		expect(
			[...uploads.keys()].filter((key) => key.startsWith("preempted/")),
		).toEqual([]);
		const final = webhooks.findLast((payload) => payload.jobId === idle.jobId);
		expect(final?.errorCode).toBe("idle-preempted");
	});

	test("stops an idle ladder's uploads when another ladder is admitted and reports only once they stop", async () => {
		const { cpuPressure } = jobManager.getSystemResources();
		const hang = {
			started: Promise.withResolvers<void>(),
			aborted: Promise.withResolvers<void>(),
		};
		hangingUploads = hang;
		try {
			const idleResponse = await startLadder({
				uploads: Object.fromEntries(
					LADDER_FILES.map((name) => [name, `${baseUrl}/hang/${name}`]),
				),
				priority: "idle",
			});
			if (cpuPressure >= 0.5) {
				expect(idleResponse.status).toBe(503);
				return;
			}
			const { jobId } = (await idleResponse.json()) as { jobId: string };
			const terminal = Promise.withResolvers<boolean>();
			let uploadsStopped = false;
			webhookListeners.set(`${jobId}:error`, () =>
				terminal.resolve(uploadsStopped),
			);

			await hang.started.promise;
			const idleJob = getJob(jobId);
			expect(idleJob?.phase).toBe("uploading");
			let phaseWhenStopped: string | undefined;
			void idleJob?.uploadsStopped?.then(() => {
				uploadsStopped = true;
				phaseWhenStopped = getJob(jobId)?.phase;
			});

			const other = await startLadder({
				uploads: uploadTargets("after-upload-preempt"),
			});
			expect(other.status).toBe(200);
			await hang.aborted.promise;
			expect(await terminal.promise).toBe(true);
			expect(phaseWhenStopped).toBe("uploading");
			expect(getJob(jobId)?.errorCode).toBe("idle-preempted");
			const { jobId: otherId } = (await other.json()) as { jobId: string };
			expect((await waitForTerminalJob(otherId)).phase).toBe("complete");
		} finally {
			hangingUploads = null;
			webhookListeners.clear();
		}
	});

	test("verifies and prunes a ladder before it uploads it", async () => {
		const response = await startLadder({
			videoUrl: `${baseUrl}/large.mp4`,
			uploads: uploadTargets("checked"),
			maxTier: "2160p",
			verify: true,
			pruneInvertedRungs: true,
		});
		expect(response.status).toBe(200);
		const started = (await response.json()) as {
			jobId: string;
			accepted: unknown;
		};
		expect(started.accepted).toEqual({
			priority: "normal",
			verify: true,
			pruneInvertedRungs: true,
		});
		expect(jobManager.getJob(started.jobId)?.heavyLadder).toBe(true);
		const job = await waitForTerminalJob(started.jobId);
		expect(job.error).toBeUndefined();
		expect(job.phase).toBe("complete");
		expect(job.heavyLadder).toBe(false);
		expect(job.ladder?.renditions.map((rendition) => rendition.name)).toEqual([
			"720p",
			"360p",
		]);
		const final = webhooks.findLast(
			(payload) => payload.jobId === started.jobId,
		);
		expect(final?.phase).toBe("complete");
		expect(final?.idle).toBe(false);
		expect(final?.verified).toBe(true);
		expect(final?.pruned).toEqual([]);
		const master = parseHlsLadderMaster(
			new TextDecoder().decode(uploads.get("checked/master.m3u8")?.bytes),
		);
		expect(master.video.map((variant) => variant.name)).toEqual([
			"720p",
			"360p",
		]);
	});

	test("keeps an Infra request without the new options as it was", async () => {
		const response = await startLadder({
			uploads: uploadTargets("infra-plain"),
			infra: true,
		});
		expect(response.status).toBe(200);
		const started = (await response.json()) as Record<string, unknown>;
		expect(Object.keys(started).sort()).toEqual([
			"accepted",
			"jobId",
			"message",
			"status",
		]);
		expect(started.accepted).toEqual({
			priority: "normal",
			verify: false,
			pruneInvertedRungs: false,
		});
		const job = await waitForTerminalJob(started.jobId as string);
		expect(job.phase).toBe("complete");
		expect(job.idle).toBeUndefined();
		expect(job.heavyLadder).toBe(false);
		const final = webhooks.findLast(
			(payload) => payload.jobId === started.jobId,
		);
		expect(final).toBeDefined();
		for (const key of ["idle", "verified", "pruned"]) {
			expect(Object.hasOwn(final ?? {}, key)).toBe(false);
		}
		const produced = [
			"master.m3u8",
			...(job.ladder?.renditions ?? []).flatMap((rendition) => [
				rendition.playlist,
				rendition.media,
			]),
			"audio.m3u8",
			"audio.m4s",
		];
		for (const name of produced) {
			expect(uploads.has(`infra-plain/${name}`)).toBe(true);
		}
		expect(
			[...uploads.keys()].filter((key) => key.startsWith("infra-plain/"))
				.length,
		).toBe(produced.length);
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

	// With two slots or fewer the slice reserve and the reserve for a whole
	// Infra job are the same slot (infra-capacity.test.ts covers the rule
	// itself), so this needs a machine with room for three jobs.
	test("holds an Infra slice back once half the worker's slots are taken and still takes a whole Infra job", async () => {
		const { effectiveMax } = jobManager.getSystemResources();
		if (effectiveMax <= 2) {
			console.warn(
				`[test] ${effectiveMax} slots here, the slice reserve is not separate`,
			);
			return;
		}
		const held = Array.from(
			{ length: Math.floor(effectiveMax / 2) },
			(_, index) => `held-${index}`,
		);
		for (const jobId of held) jobManager.createJob(jobId, "other", "user-1");
		try {
			const slice = await startLadder({
				uploads: uploadTargets("held-slice"),
				range: { startSeconds: 0, durationSeconds: 4 },
				infra: true,
			});
			expect(slice.status).toBe(503);
			expect(slice.headers.get("retry-after")).not.toBeNull();
			expect(uploads.has("held-slice/master.m3u8")).toBe(false);

			const whole = await startLadder({
				uploads: uploadTargets("held-whole"),
				infra: true,
			});
			expect(whole.status).toBe(200);
			const { jobId } = (await whole.json()) as { jobId: string };
			expect((await waitForTerminalJob(jobId)).phase).toBe("complete");

			jobManager.deleteJob(held[0] as string);
			const admitted = await startLadder({
				uploads: uploadTargets("held-slice"),
				range: { startSeconds: 0, durationSeconds: 4 },
				infra: true,
			});
			expect(admitted.status).toBe(200);
			const sliceJob = (await admitted.json()) as { jobId: string };
			expect((await waitForTerminalJob(sliceJob.jobId)).phase).toBe("complete");
		} finally {
			for (const jobId of held) jobManager.deleteJob(jobId);
		}
	}, 180_000);

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
