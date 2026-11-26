import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type appType from "../../app";
import {
	INFRA_POSTER_OPTIONS,
	posterThumbnailOptions,
} from "../../lib/infra-poster";
import type { Job } from "../../lib/job-manager";
import * as mediaVideo from "../../lib/media-video";

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
let jobManager: typeof import("../../lib/job-manager");
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const workDir = mkdtempSync(join(tmpdir(), "cap-infra-poster-"));
const sources = new Map<string, Uint8Array<ArrayBuffer>>();
const uploads = new Map<string, Uint8Array>();

function makeSource(name: string, size: string) {
	const path = join(workDir, name);
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=size=${size}:rate=30:duration=2`,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-y",
		path,
	]);
	sources.set(`/${name}`, new Uint8Array(readFileSync(path)));
}

function imageSize(bytes: Uint8Array | undefined): string {
	const path = join(workDir, "poster.jpg");
	writeFileSync(path, bytes ?? new Uint8Array());
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

async function waitForTerminalJob(jobId: string): Promise<Job> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 90_000) {
		const job = jobManager.getJob(jobId);
		if (!job) throw new Error(`Job ${jobId} disappeared`);
		if (["complete", "error", "cancelled"].includes(job.phase)) return job;
		await Bun.sleep(100);
	}
	throw new Error(`Job ${jobId} did not finish`);
}

async function runJob(path: string, body: Record<string, unknown>) {
	const thumbnail = spyOn(mediaVideo, "generateThumbnail");
	// Admission reads this machine's free memory and load; the poster size is
	// what is under test here.
	const capacity = [
		spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true),
		spyOn(jobManager, "canAcceptNewInfraVideoProcess").mockReturnValue(true),
	];
	try {
		const response = await app.request(path, {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({
				videoId: "poster-video",
				userId: "poster-user",
				...body,
			}),
		});
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(jobId);
		jobManager.deleteJob(jobId);
		expect(job.error).toBeUndefined();
		expect(job.phase).toBe("complete");
		expect(thumbnail).toHaveBeenCalledTimes(1);
		return thumbnail.mock.calls[0]?.[2];
	} finally {
		thumbnail.mockRestore();
		for (const spy of capacity) spy.mockRestore();
	}
}

function processBody(source: string, name: string, extra = {}) {
	return {
		videoUrl: `${baseUrl}/${source}`,
		outputPresignedUrl: `${baseUrl}/uploads/${name}.mp4`,
		thumbnailPresignedUrl: `${baseUrl}/uploads/${name}.jpg`,
		inputExtension: ".mp4",
		...extra,
	};
}

function ladderBody(source: string, name: string, extra = {}) {
	return {
		videoUrl: `${baseUrl}/${source}`,
		uploads: Object.fromEntries(
			LADDER_FILES.map((file) => [file, `${baseUrl}/uploads/${name}/${file}`]),
		),
		thumbnailPresignedUrl: `${baseUrl}/uploads/${name}.jpg`,
		...extra,
	};
}

beforeAll(async () => {
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = SECRET;
	process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES = "4";
	app = (await import("../../app")).default;
	jobManager = await import("../../lib/job-manager");
	makeSource("wide.mp4", "2560x1440");
	makeSource("tall.mp4", "1080x1920");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "PUT" && url.pathname.startsWith("/uploads/")) {
				uploads.set(
					url.pathname.slice("/uploads/".length),
					new Uint8Array(await request.arrayBuffer()),
				);
				return new Response(null, { status: 200, headers: { ETag: '"x"' } });
			}
			const source = sources.get(url.pathname);
			if (!source) return new Response(null, { status: 404 });
			return new Response(source, {
				headers: {
					"Content-Type": "video/mp4",
					"Content-Length": String(source.byteLength),
				},
			});
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
	rmSync(workDir, { recursive: true, force: true });
});

describe("poster size", () => {
	test("only an Infra job asks for the larger poster", () => {
		expect(posterThumbnailOptions(undefined)).toStrictEqual({});
		expect(posterThumbnailOptions(false)).toStrictEqual({});
		expect(posterThumbnailOptions(true)).toStrictEqual({
			width: 1920,
			height: 1920,
		});
	});

	test("a regular Cap process job keeps the default thumbnail", async () => {
		const options = await runJob(
			"/video/process",
			processBody("wide.mp4", "regular-wide"),
		);
		expect(options).toStrictEqual({});
		expect(imageSize(uploads.get("regular-wide.jpg"))).toBe("1280x720");
	}, 120_000);

	test("an Infra MP4 job takes its poster up to 1920 wide", async () => {
		const options = await runJob(
			"/video/process",
			processBody("wide.mp4", "infra-wide", {
				infra: true,
				maxWidth: 2560,
				maxHeight: 2560,
			}),
		);
		expect(options).toStrictEqual(INFRA_POSTER_OPTIONS);
		expect(imageSize(uploads.get("infra-wide.jpg"))).toBe("1920x1080");
	}, 120_000);

	test("an Infra ladder takes its poster up to 1920 wide", async () => {
		const options = await runJob(
			"/video/ladder",
			ladderBody("wide.mp4", "ladder-wide", {
				infra: true,
				maxTier: "1440p",
			}),
		);
		expect(options).toStrictEqual(INFRA_POSTER_OPTIONS);
		expect(imageSize(uploads.get("ladder-wide.jpg"))).toBe("1920x1080");
	}, 120_000);

	test("a portrait Infra ladder keeps its full height and never upscales", async () => {
		await runJob(
			"/video/ladder",
			ladderBody("tall.mp4", "ladder-tall", {
				infra: true,
				maxTier: "1080p",
			}),
		);
		expect(imageSize(uploads.get("ladder-tall.jpg"))).toBe("1080x1920");
	}, 120_000);
});
