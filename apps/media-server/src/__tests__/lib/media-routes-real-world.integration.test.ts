import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type appType from "../../app";
import type { Job } from "../../lib/job-manager";
import { probeVideoFile } from "../../lib/media-probe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = join(FIXTURES_DIR, "test-with-audio.mp4");
const TEST_VIDEO_NO_AUDIO = join(FIXTURES_DIR, "test-no-audio.mp4");
const MEDIA_SERVER_SECRET = "test-secret";
const AUTH_HEADERS = {
	"Content-Type": "application/json",
	"x-media-server-secret": MEDIA_SERVER_SECRET,
};

let app: typeof appType;
let getJob: typeof import("../../lib/job-manager").getJob;
let deleteJob: typeof import("../../lib/job-manager").deleteJob;
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let tempDir = "";

const uploadedArtifacts = new Map<string, Uint8Array>();

function fileUrl(path: string) {
	return pathToFileURL(path).toString();
}

function fixtureUrl(name = "test-with-audio.mp4") {
	return `${baseUrl}/fixtures/${name}`;
}

function uploadUrl(name: string) {
	return `${baseUrl}/uploads/${name}`;
}

function mediaPostRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: AUTH_HEADERS,
		body: JSON.stringify(body),
	});
}

async function responseBytes(response: Response) {
	return new Uint8Array(await response.arrayBuffer());
}

function expectJpeg(data: Uint8Array) {
	expect(data.length).toBeGreaterThan(0);
	expect(data[0]).toBe(0xff);
	expect(data[1]).toBe(0xd8);
}

function expectMp3(data: Uint8Array) {
	expect(data.length).toBeGreaterThan(0);
	const hasId3Tag = data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33;
	const hasMpegSync = data[0] === 0xff && (data[1] & 0xe0) === 0xe0;
	expect(hasId3Tag || hasMpegSync).toBe(true);
}

function expectMp4(data: Uint8Array) {
	expect(data.length).toBeGreaterThan(0);
	expect(new TextDecoder().decode(data.slice(4, 8))).toBe("ftyp");
}

async function probeBytesAsMp4(data: Uint8Array, name: string) {
	const path = join(tempDir, `${Date.now()}-${name}`);
	await writeFile(path, data);
	return await probeVideoFile(path);
}

async function waitForTerminalJob(jobId: string): Promise<Job> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 90000) {
		const job = getJob(jobId);
		if (!job) {
			throw new Error(`Job ${jobId} disappeared`);
		}
		if (
			job.phase === "complete" ||
			job.phase === "error" ||
			job.phase === "cancelled"
		) {
			return job;
		}
		await Bun.sleep(100);
	}

	const job = getJob(jobId);
	throw new Error(
		`Timed out waiting for job ${jobId}; phase=${job?.phase ?? "missing"}`,
	);
}

function uploadedBytes(pathname: string) {
	const bytes = uploadedArtifacts.get(pathname);
	if (!bytes) {
		throw new Error(`Expected upload at ${pathname}`);
	}
	return bytes;
}

async function uploadResponseBytes(pathname: string) {
	const bytes = uploadedArtifacts.get(pathname);
	if (!bytes) return null;
	return bytes;
}

beforeAll(async () => {
	mock.restore();
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = MEDIA_SERVER_SECRET;
	process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES = "4";

	const appModule = await import("../../app");
	const jobManager = await import("../../lib/job-manager");
	app = appModule.default;
	getJob = jobManager.getJob;
	deleteJob = jobManager.deleteJob;
	tempDir = mkdtempSync(join(tmpdir(), "cap-real-world-routes-"));

	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);

			if (request.method === "GET" || request.method === "HEAD") {
				const fixturePath =
					url.pathname === "/fixtures/test-no-audio.mp4"
						? TEST_VIDEO_NO_AUDIO
						: url.pathname === "/fixtures/test-with-audio.mp4"
							? TEST_VIDEO_WITH_AUDIO
							: null;

				if (fixturePath) {
					const fixture = Bun.file(fixturePath);
					const headers = {
						"Content-Type": "video/mp4",
						"Content-Length": String(await fixture.size),
					};
					return request.method === "HEAD"
						? new Response(null, { headers })
						: new Response(fixture, { headers });
				}
			}

			if (
				(request.method === "GET" || request.method === "HEAD") &&
				url.pathname.startsWith("/uploads/")
			) {
				const bytes = await uploadResponseBytes(url.pathname);
				if (!bytes) return new Response("Not found", { status: 404 });
				const headers = {
					"Content-Type": "video/mp4",
					"Content-Length": bytes.byteLength.toString(),
				};
				return request.method === "HEAD"
					? new Response(null, { headers })
					: new Response(bytes, { headers });
			}

			if (request.method === "PUT" && url.pathname.startsWith("/uploads/")) {
				if (url.pathname === "/uploads/stale-edit-output.mp4") {
					uploadedArtifacts.set(
						url.pathname,
						new Uint8Array(await Bun.file(TEST_VIDEO_WITH_AUDIO).arrayBuffer()),
					);
				} else {
					uploadedArtifacts.set(
						url.pathname,
						new Uint8Array(await request.arrayBuffer()),
					);
				}
				return new Response(null, { status: 200, statusText: "OK" });
			}

			return new Response("Not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

beforeEach(() => {
	mock.restore();
	uploadedArtifacts.clear();
});

afterAll(() => {
	server?.stop(true);
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe("media routes real-world integration tests", () => {
	test("checks real audio tracks through the route stack", async () => {
		const withAudioResponse = await app.fetch(
			mediaPostRequest("/audio/check", {
				videoUrl: fileUrl(TEST_VIDEO_WITH_AUDIO),
			}),
		);
		const noAudioResponse = await app.fetch(
			mediaPostRequest("/audio/check", {
				videoUrl: fileUrl(TEST_VIDEO_NO_AUDIO),
			}),
		);

		expect(withAudioResponse.status).toBe(200);
		expect(noAudioResponse.status).toBe(200);

		const withAudio = (await withAudioResponse.json()) as { hasAudio: boolean };
		const noAudio = (await noAudioResponse.json()) as { hasAudio: boolean };
		expect(withAudio.hasAudio).toBe(true);
		expect(noAudio.hasAudio).toBe(false);
	});

	test("extracts real audio through the non-streaming route", async () => {
		const response = await app.fetch(
			mediaPostRequest("/audio/extract", {
				videoUrl: fileUrl(TEST_VIDEO_WITH_AUDIO),
				stream: false,
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
		expectMp3(await responseBytes(response));
	});

	test("probes and thumbnails a real video through the route stack", async () => {
		const probeResponse = await app.fetch(
			mediaPostRequest("/video/probe", {
				videoUrl: fileUrl(TEST_VIDEO_WITH_AUDIO),
			}),
		);
		expect(probeResponse.status).toBe(200);
		const probeData = (await probeResponse.json()) as {
			metadata: { videoCodec: string; audioCodec: string | null };
		};
		expect(probeData.metadata.videoCodec).toBe("h264");
		expect(probeData.metadata.audioCodec).toBe("aac");

		const thumbnailResponse = await app.fetch(
			mediaPostRequest("/video/thumbnail", {
				videoUrl: fileUrl(TEST_VIDEO_WITH_AUDIO),
				timestamp: 0.2,
				width: 160,
				height: 120,
				quality: 80,
			}),
		);
		expect(thumbnailResponse.status).toBe(200);
		expect(thumbnailResponse.headers.get("Content-Type")).toBe("image/jpeg");
		expectJpeg(await responseBytes(thumbnailResponse));
	});

	test("converts a real downloaded video through the route stack", async () => {
		const response = await app.fetch(
			mediaPostRequest("/video/convert", {
				videoUrl: fixtureUrl(),
				inputExtension: ".mp4",
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("video/mp4");
		const bytes = await responseBytes(response);
		expectMp4(bytes);

		const metadata = await probeBytesAsMp4(bytes, "converted.mp4");
		expect(metadata.videoCodec).toBe("h264");
		expect(metadata.audioCodec).toBe("aac");
		expect(metadata.duration).toBeGreaterThan(0);
	}, 60000);

	test("processes and uploads a real video job through the async route", async () => {
		const response = await app.fetch(
			mediaPostRequest("/video/process", {
				videoId: "real-process-video",
				userId: "real-process-user",
				videoUrl: fixtureUrl(),
				outputPresignedUrl: uploadUrl("process-output.mp4"),
				inputExtension: ".mp4",
				maxWidth: 160,
				maxHeight: 120,
				crf: 30,
				preset: "ultrafast",
			}),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(data.jobId);
		try {
			expect(job.phase).toBe("complete");
			expect(job.error).toBeUndefined();

			const bytes = uploadedBytes("/uploads/process-output.mp4");
			expectMp4(bytes);
			const metadata = await probeBytesAsMp4(bytes, "process-output.mp4");
			expect(metadata.videoCodec).toBe("h264");
			expect(metadata.audioCodec).toBe("aac");
			expect(metadata.width).toBeLessThanOrEqual(160);
			expect(metadata.height).toBeLessThanOrEqual(120);
		} finally {
			deleteJob(data.jobId);
		}
	}, 90000);

	test("edits and uploads a real video job through the async route", async () => {
		const response = await app.fetch(
			mediaPostRequest("/video/edit", {
				videoId: "real-edit-video",
				userId: "real-edit-user",
				sourceUrl: fixtureUrl(),
				outputPresignedUrl: uploadUrl("edit-output.mp4"),
				outputVerificationUrl: uploadUrl("edit-output.mp4"),
				keepRanges: [
					{ start: 0, end: 0.4 },
					{ start: 0.55, end: 0.95 },
				],
			}),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(data.jobId);
		try {
			expect(job.phase).toBe("complete");
			expect(job.error).toBeUndefined();

			const bytes = uploadedBytes("/uploads/edit-output.mp4");
			expectMp4(bytes);
			const metadata = await probeBytesAsMp4(bytes, "edit-output.mp4");
			expect(metadata.videoCodec).toBe("h264");
			expect(metadata.audioCodec).toBe("aac");
			expect(metadata.duration).toBeGreaterThan(0.3);
			expect(metadata.duration).toBeLessThan(1.2);
		} finally {
			deleteJob(data.jobId);
		}
	}, 90000);

	test("fails an edit job when uploaded video verification sees stale bytes", async () => {
		const response = await app.fetch(
			mediaPostRequest("/video/edit", {
				videoId: "stale-edit-video",
				userId: "stale-edit-user",
				sourceUrl: fixtureUrl(),
				outputPresignedUrl: uploadUrl("stale-edit-output.mp4"),
				outputVerificationUrl: uploadUrl("stale-edit-output.mp4"),
				keepRanges: [{ start: 0, end: 0.1 }],
			}),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(data.jobId);
		try {
			expect(job.phase).toBe("error");
			expect(job.error).toContain("Uploaded video duration mismatch");
		} finally {
			deleteJob(data.jobId);
		}
	}, 90000);
});
