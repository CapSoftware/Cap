import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type appType from "../../app";
import * as containerCpu from "../../lib/container-cpu";
import * as containerMemory from "../../lib/container-memory";
import type { Job } from "../../lib/job-manager";
import { probeVideoFile } from "../../lib/media-probe";
import * as recordingVerification from "../../lib/recording-verification";

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
const recordingSources = new Map<string, Uint8Array>();
const sourceReads: {
	path: string;
	ifMatch: string | null;
	verification: string | null;
}[] = [];
const uploadConditions: (string | null)[] = [];
const multipartCallbacks: { action: string; payload: unknown }[] = [];
let rejectMultipartSigning = false;
let sourceFault: "changed" | "missing" | "corrupt" | undefined;
let corruptRecordingReadback = false;
let transientFixtureFailures = 0;
let permanentFixtureFailures = 0;
let slowFixtureCancellations = 0;

function fileUrl(path: string) {
	return pathToFileURL(path).toString();
}

function fixtureUrl(name = "test-with-audio.mp4") {
	return `${baseUrl}/fixtures/${name}`;
}

function uploadUrl(name: string) {
	return `${baseUrl}/uploads/${name}`;
}

function objectIdentity(bytes: Uint8Array): string {
	return `"${createHash("sha256").update(bytes).digest("hex")}"`;
}

function fencedMuxRequest(name: string) {
	return {
		videoId: name,
		userId: "fenced-user",
		generation: "fenced-generation",
		attemptId: `attempt-${name}`,
		manifestSha256: "a".repeat(64),
		inventorySha256: "b".repeat(64),
		outputKey: `recording-generations/${name}/result.mp4`,
		outputUpload: {
			type: "put",
			url: uploadUrl(`${name}.mp4`),
			ifNoneMatch: "*",
		},
		outputVerificationUrl: uploadUrl(`${name}.mp4`),
		videoInitUrl: `${baseUrl}/recording-sources/video-init.mp4`,
		videoSegmentUrls: [`${baseUrl}/recording-sources/video-segment.m4s`],
		audioInitUrl: `${baseUrl}/recording-sources/audio-init.mp4`,
		audioSegmentUrls: [`${baseUrl}/recording-sources/audio-segment.m4s`],
		requiredAudio: true,
		expectedDuration: 0.1,
		sourceObjects: [...recordingSources].map(([path, bytes]) => ({
			url: `${baseUrl}${path}`,
			objectIdentity: objectIdentity(bytes),
			size: bytes.byteLength,
		})),
	};
}

function mediaPostRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: AUTH_HEADERS,
		body: JSON.stringify(body),
	});
}

function multipartMuxRequest(name: string) {
	const body = fencedMuxRequest(name);
	return {
		...body,
		outputUpload: {
			type: "multipart",
			videoId: body.videoId,
			generation: body.generation,
			attemptId: body.attemptId,
			key: body.outputKey,
			uploadId: `upload-${name}`,
			partSize: 5 * 1024 * 1024,
			signPartUrl: `${baseUrl}/multipart/${name}/sign-part`,
			completeUrl: `${baseUrl}/multipart/${name}/complete`,
			abortUrl: `${baseUrl}/multipart/${name}/abort`,
			webhookSecret: MEDIA_SERVER_SECRET,
		},
	};
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
	for (const kind of ["video", "audio"] as const) {
		const path = join(tempDir, `${kind}-fragmented.mp4`);
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-i",
			TEST_VIDEO_WITH_AUDIO,
			"-map",
			kind === "video" ? "0:v:0" : "0:a:0",
			"-c",
			"copy",
			"-movflags",
			"+empty_moov+frag_keyframe+default_base_moof",
			path,
		]);
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
		const view = new DataView(bytes.buffer);
		let split = 0;
		while (
			split + 8 <= bytes.byteLength &&
			new TextDecoder().decode(bytes.subarray(split + 4, split + 8)) !== "moof"
		) {
			const size = view.getUint32(split);
			if (size < 8) throw new Error("Invalid fragmented test fixture");
			split += size;
		}
		if (split + 8 > bytes.byteLength)
			throw new Error("Missing fragmented test fixture media");
		recordingSources.set(
			`/recording-sources/${kind}-init.mp4`,
			bytes.slice(0, split),
		);
		recordingSources.set(
			`/recording-sources/${kind}-segment.m4s`,
			bytes.slice(split),
		);
	}

	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/ignored-webhook")
				return new Response(null, { status: 200 });
			if (request.method === "POST" && url.pathname.startsWith("/multipart/")) {
				const [, , name, action] = url.pathname.split("/");
				const payload: unknown = await request.json();
				multipartCallbacks.push({ action, payload });
				if (
					request.headers.get("x-media-server-secret") !== MEDIA_SERVER_SECRET
				)
					return new Response(null, { status: 401 });
				if (action === "sign-part")
					return rejectMultipartSigning
						? new Response(null, { status: 403 })
						: Response.json({ url: uploadUrl(`${name}.part`) });
				if (action === "complete") {
					const bytes = uploadedBytes(`/uploads/${name}.part`);
					uploadedArtifacts.set(`/uploads/${name}.mp4`, bytes);
					return Response.json({ objectIdentity: objectIdentity(bytes) });
				}
				if (action === "abort") return Response.json({ success: true });
			}
			const source = recordingSources.get(url.pathname);
			if (source && request.method === "GET") {
				sourceReads.push({
					path: url.pathname,
					ifMatch: request.headers.get("if-match"),
					verification: request.headers.get("x-cap-recording-verification"),
				});
				const affected = url.pathname.endsWith("video-segment.m4s");
				if (affected && sourceFault === "missing")
					return new Response(null, { status: 404 });
				if (
					request.headers.get("if-match") !== objectIdentity(source) ||
					request.headers.get("x-cap-recording-verification") !== "1" ||
					(affected && sourceFault === "changed")
				)
					return new Response(null, { status: 412 });
				return new Response(
					Uint8Array.from(
						affected && sourceFault === "corrupt"
							? new Uint8Array(source.byteLength)
							: source,
					).buffer,
					{
						headers: {
							ETag: objectIdentity(source),
							"Content-Length": String(source.byteLength),
						},
					},
				);
			}

			if (request.method === "GET" || request.method === "HEAD") {
				if (url.pathname === "/fixtures/permanent-unavailable.m4s") {
					permanentFixtureFailures++;
					return new Response("Unavailable", { status: 503 });
				}
				if (url.pathname === "/fixtures/slow-segment.m4s") {
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array(1024));
							},
							cancel() {
								slowFixtureCancellations++;
							},
						}),
					);
				}
				if (
					request.method === "GET" &&
					url.pathname === "/fixtures/transient-no-audio.mp4" &&
					transientFixtureFailures < 2
				) {
					transientFixtureFailures++;
					return new Response("Unavailable", { status: 503 });
				}
				const fixturePath =
					url.pathname === "/fixtures/test-no-audio.mp4"
						? TEST_VIDEO_NO_AUDIO
						: url.pathname === "/fixtures/transient-no-audio.mp4"
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
					ETag: objectIdentity(bytes),
				};
				if (
					request.headers.has("if-match") &&
					request.headers.get("if-match") !== headers.ETag
				)
					return new Response(null, { status: 412 });
				if (request.headers.get("range") === "bytes=0-0")
					return new Response(Uint8Array.from(bytes.subarray(0, 1)).buffer, {
						status: 206,
						headers: {
							...headers,
							"Content-Length": "1",
							"Content-Range": `bytes 0-0/${bytes.byteLength}`,
						},
					});
				if (corruptRecordingReadback)
					return new Response(new Uint8Array(bytes.byteLength), { headers });
				return request.method === "HEAD"
					? new Response(null, { headers })
					: new Response(Uint8Array.from(bytes).buffer, { headers });
			}

			if (request.method === "PUT" && url.pathname.startsWith("/uploads/")) {
				uploadConditions.push(request.headers.get("if-none-match"));
				if (
					request.headers.get("if-none-match") === "*" &&
					uploadedArtifacts.has(url.pathname)
				)
					return new Response(null, { status: 412 });
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
				return new Response(null, {
					status: 200,
					statusText: "OK",
					headers: { ETag: objectIdentity(uploadedBytes(url.pathname)) },
				});
			}

			return new Response("Not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;
});

beforeEach(() => {
	mock.restore();
	spyOn(os, "loadavg").mockReturnValue([0, 0, 0]);
	spyOn(containerCpu, "getContainerCpuLimit").mockReturnValue(4);
	spyOn(containerCpu, "getContainerCpuUsageMicros").mockReturnValue(0);
	spyOn(containerMemory, "getContainerMemoryMetrics").mockReturnValue({
		usageMB: 256,
		limitMB: 4096,
		pressure: 0.0625,
	});
	uploadedArtifacts.clear();
	transientFixtureFailures = 0;
	permanentFixtureFailures = 0;
	slowFixtureCancellations = 0;
	sourceReads.length = 0;
	uploadConditions.length = 0;
	multipartCallbacks.length = 0;
	rejectMultipartSigning = false;
	sourceFault = undefined;
	corruptRecordingReadback = false;
});

afterAll(() => {
	mock.restore();
	server?.stop(true);
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe("media routes real-world integration tests", () => {
	test("cancels segmented work at its total deadline without waiting for job cleanup", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const shortenedDeadline = new Proxy(originalSetTimeout, {
			apply(target, receiver: unknown, parameters: unknown[]) {
				const adjusted = [...parameters];
				if (adjusted[1] === 170 * 60 * 1000) adjusted[1] = 1;
				return Reflect.apply(target, receiver, adjusted);
			},
		});
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(
			shortenedDeadline,
		);
		let jobId: string | undefined;
		try {
			const response = await app.fetch(
				mediaPostRequest("/video/mux-segments", fencedMuxRequest("deadline")),
			);
			expect(response.status).toBe(200);
			jobId = ((await response.json()) as { jobId: string }).jobId;
			const job = await waitForTerminalJob(jobId);
			expect(job.phase).toBe("cancelled");
			expect(job.errorCode).toBe("processing-unavailable");
			expect(job.abortController?.signal.aborted).toBe(true);
			expect(job.recordingVerification).toBeUndefined();
			expect(uploadConditions).toHaveLength(0);
		} finally {
			timer.mockRestore();
			if (jobId) deleteJob(jobId);
		}
	});

	test("verifies a fenced legacy MP4 snapshot without trusting an invented duration", async () => {
		const decode = spyOn(recordingVerification, "verifyRemoteRecording");
		const bytesOnly = spyOn(
			recordingVerification,
			"verifyRemoteRecordingBytes",
		);
		const bytes = new Uint8Array(
			await Bun.file(TEST_VIDEO_WITH_AUDIO).arrayBuffer(),
		);
		uploadedArtifacts.set("/uploads/mp4-snapshot.mp4", bytes);
		const response = await app.fetch(
			mediaPostRequest("/video/verify-recording", {
				videoId: "legacy-mp4-snapshot",
				userId: "legacy-user",
				generation: "mp4-generation",
				inventorySha256: "c".repeat(64),
				attemptId: "mp4-attempt",
				videoUrl: uploadUrl("mp4-snapshot.mp4"),
				fileSize: bytes.byteLength,
				requiredAudio: true,
				objectIdentity: '"original-source"',
				originalObjectIdentity: '"original-source"',
				sourceObjectIdentity: objectIdentity(bytes),
				outputKey: "recording-generations/mp4-generation/source.mp4",
				webhookUrl: `${baseUrl}/ignored-webhook`,
			}),
		);
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		try {
			const job = await waitForTerminalJob(jobId);
			expect(job.phase).toBe("complete");
			expect(job.recordingVerification).toMatchObject({
				request: {
					artifact: {
						kind: "mp4",
						duration: 1,
						objectIdentity: '"original-source"',
					},
				},
				objectIdentity: objectIdentity(bytes),
				outputSha256: createHash("sha256").update(bytes).digest("hex"),
			});
			expect(uploadConditions).toHaveLength(0);
			expect(decode).toHaveBeenCalledTimes(1);
			expect(bytesOnly).not.toHaveBeenCalled();
		} finally {
			decode.mockRestore();
			bytesOnly.mockRestore();
			deleteJob(jobId);
		}
	}, 30_000);

	test("verifies pinned fragmented sources through immutable upload and exact remote proof", async () => {
		const sourceDecode = spyOn(
			recordingVerification,
			"inspectRecordingSources",
		);
		const localDecode = spyOn(recordingVerification, "verifyRecording");
		const remoteDecode = spyOn(recordingVerification, "verifyRemoteRecording");
		const bytesOnly = spyOn(
			recordingVerification,
			"verifyRemoteRecordingBytes",
		);
		const body = fencedMuxRequest("fenced-mux");
		const response = await app.fetch(
			mediaPostRequest("/video/mux-segments", body),
		);
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		const replay = await app.fetch(
			mediaPostRequest("/video/mux-segments", body),
		);
		expect(((await replay.json()) as { jobId: string }).jobId).toBe(jobId);
		try {
			const job = await waitForTerminalJob(jobId);
			expect(job.phase).toBe("complete");
			expect(job.error).toBeUndefined();
			expect(job.generation).toBe(body.generation);
			expect(job.attemptId).toBe(body.attemptId);
			expect(job.inventorySha256).toBe(body.inventorySha256);
			expect(job.metadata?.duration).toBeCloseTo(1, 3);
			expect(sourceDecode).toHaveBeenCalledTimes(1);
			expect(localDecode).toHaveBeenCalledTimes(1);
			expect(remoteDecode).not.toHaveBeenCalled();
			expect(bytesOnly).toHaveBeenCalledTimes(1);
			expect(uploadConditions).toEqual(["*"]);
			expect(sourceReads).toHaveLength(body.sourceObjects.length);
			for (const read of sourceReads) {
				expect(read.ifMatch).toBe(
					objectIdentity(recordingSources.get(read.path) ?? new Uint8Array()),
				);
				expect(read.verification).toBe("1");
			}
			const bytes = uploadedBytes("/uploads/fenced-mux.mp4");
			expect(job.recordingVerification).toMatchObject({
				fullDecode: true,
				objectIdentity: objectIdentity(bytes),
				outputKey: body.outputKey,
				outputSha256: createHash("sha256").update(bytes).digest("hex"),
				sourceProof: {
					version: 1,
					manifestSha256: body.manifestSha256,
					inventorySha256: body.inventorySha256,
					sourcePreserved: true,
					hasAudio: true,
					audioVerified: true,
				},
			});
		} finally {
			sourceDecode.mockRestore();
			localDecode.mockRestore();
			remoteDecode.mockRestore();
			bytesOnly.mockRestore();
			deleteJob(jobId);
		}
	}, 30_000);

	test("refuses a local output changed between full decode and byte binding", async () => {
		const originalHash = recordingVerification.hashRecordingFile;
		const hashing = spyOn(
			recordingVerification,
			"hashRecordingFile",
		).mockImplementation(async (path, signal) => {
			const digest = await originalHash(path, signal);
			const bytes = await readFile(path);
			bytes[bytes.length - 1] ^= 1;
			await writeFile(path, bytes);
			return digest;
		});
		let jobId: string | undefined;
		try {
			const response = await app.fetch(
				mediaPostRequest(
					"/video/mux-segments",
					fencedMuxRequest("changed-local-output"),
				),
			);
			expect(response.status).toBe(200);
			jobId = ((await response.json()) as { jobId: string }).jobId;
			const job = await waitForTerminalJob(jobId);
			expect(job.phase).toBe("error");
			expect(job.error).toContain(
				"Local recording changed during verification",
			);
			expect(job.errorCode).toBe("output-invalid");
			expect(job.recordingVerification).toBeUndefined();
			expect(uploadConditions).toHaveLength(0);
		} finally {
			hashing.mockRestore();
			if (jobId) deleteJob(jobId);
		}
	}, 30_000);

	test.each([false, true])(
		"preserves multipart attempt fencing through callbacks with signing failure %s",
		async (rejectSigning) => {
			rejectMultipartSigning = rejectSigning;
			const body = multipartMuxRequest(`fenced-multipart-${rejectSigning}`);
			const response = await app.fetch(
				mediaPostRequest("/video/mux-segments", body),
			);
			expect(response.status).toBe(200);
			const { jobId } = (await response.json()) as { jobId: string };
			try {
				const job = await waitForTerminalJob(jobId);
				expect(job.phase).toBe(rejectSigning ? "error" : "complete");
				expect(multipartCallbacks.map(({ action }) => action)).toEqual(
					rejectSigning ? ["sign-part", "abort"] : ["sign-part", "complete"],
				);
				for (const callback of multipartCallbacks)
					expect(callback.payload).toMatchObject({
						videoId: body.videoId,
						generation: body.generation,
						attemptId: body.attemptId,
						key: body.outputKey,
						uploadId: body.outputUpload.uploadId,
					});
				if (rejectSigning) expect(job.recordingVerification).toBeUndefined();
				else
					expect(job.recordingVerification?.sourceProof?.sourcePreserved).toBe(
						true,
					);
			} finally {
				deleteJob(jobId);
			}
		},
		30_000,
	);

	test.each(["changed", "missing", "corrupt"] as const)(
		"withholds upload and proof after a pinned source is %s",
		async (fault) => {
			sourceFault = fault;
			const body = fencedMuxRequest(`fenced-source-${fault}`);
			const response = await app.fetch(
				mediaPostRequest("/video/mux-segments", body),
			);
			expect(response.status).toBe(200);
			const { jobId } = (await response.json()) as { jobId: string };
			try {
				const job = await waitForTerminalJob(jobId);
				expect(job.phase).toBe("error");
				expect(job.errorCode).toBe(
					fault === "corrupt" ? "source-invalid" : `source-${fault}`,
				);
				expect(job.recordingVerification).toBeUndefined();
				expect(uploadConditions).toHaveLength(0);
				if (fault === "missing")
					expect(
						sourceReads.filter((read) =>
							read.path.endsWith("video-segment.m4s"),
						),
					).toHaveLength(3);
			} finally {
				deleteJob(jobId);
			}
		},
		30_000,
	);

	test("withholds proof for corrupt remote output while preserving the source failure distinction", async () => {
		corruptRecordingReadback = true;
		const response = await app.fetch(
			mediaPostRequest(
				"/video/mux-segments",
				fencedMuxRequest("fenced-corrupt-output"),
			),
		);
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		try {
			const job = await waitForTerminalJob(jobId);
			expect(job.phase).toBe("error");
			expect(job.errorCode).toBe("output-invalid");
			expect(job.recordingVerification).toBeUndefined();
			expect(uploadConditions).toEqual(["*"]);
		} finally {
			deleteJob(jobId);
		}
	}, 30_000);

	test("does not overwrite an existing immutable candidate", async () => {
		const original = new Uint8Array([1, 2, 3]);
		uploadedArtifacts.set("/uploads/fenced-existing.mp4", original);
		const response = await app.fetch(
			mediaPostRequest(
				"/video/mux-segments",
				fencedMuxRequest("fenced-existing"),
			),
		);
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		try {
			const job = await waitForTerminalJob(jobId);
			expect(job.phase).toBe("error");
			expect(job.recordingVerification).toBeUndefined();
			expect(uploadedBytes("/uploads/fenced-existing.mp4")).toEqual(original);
			expect(uploadConditions).toEqual(["*"]);
		} finally {
			deleteJob(jobId);
		}
	}, 30_000);

	test("rejects incomplete source inventories and conflicting attempt reuse before another upload", async () => {
		const body = fencedMuxRequest("fenced-validation");
		for (const invalid of [
			{ ...body, sourceObjects: body.sourceObjects.slice(1) },
			{ ...body, outputUpload: { type: "put", url: body.outputUpload.url } },
			{ ...body, outputVerificationUrl: undefined },
			{
				...body,
				outputUpload: {
					...multipartMuxRequest(body.videoId).outputUpload,
					generation: undefined,
				},
			},
			{
				...body,
				outputUpload: {
					...multipartMuxRequest(body.videoId).outputUpload,
					attemptId: "another-attempt",
				},
			},
		]) {
			expect(
				(await app.fetch(mediaPostRequest("/video/mux-segments", invalid)))
					.status,
			).toBe(400);
		}
		const response = await app.fetch(
			mediaPostRequest("/video/mux-segments", body),
		);
		expect(response.status).toBe(200);
		const { jobId } = (await response.json()) as { jobId: string };
		try {
			const conflict = await app.fetch(
				mediaPostRequest("/video/mux-segments", {
					...body,
					inventorySha256: "c".repeat(64),
				}),
			);
			expect(conflict.status).toBe(409);
			expect((await waitForTerminalJob(jobId)).phase).toBe("complete");
		} finally {
			deleteJob(jobId);
		}
	}, 30_000);

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

	test("retries transient segment downloads and completes a real mux job", async () => {
		const response = await app.fetch(
			mediaPostRequest("/video/mux-segments", {
				videoId: "real-mux-video",
				userId: "real-mux-user",
				outputPresignedUrl: uploadUrl("mux-output.mp4"),
				videoInitUrl: `${baseUrl}/fixtures/transient-no-audio.mp4`,
				videoSegmentUrls: [],
			}),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(data.jobId);
		try {
			expect(job.phase).toBe("complete");
			expect(job.error).toBeUndefined();
			expect(transientFixtureFailures).toBe(2);

			const bytes = uploadedBytes("/uploads/mux-output.mp4");
			expectMp4(bytes);
			const metadata = await probeBytesAsMp4(bytes, "mux-output.mp4");
			expect(metadata.videoCodec).toBe("h264");
			expect(metadata.audioCodec).toBeNull();
		} finally {
			deleteJob(data.jobId);
		}
	}, 90000);

	test("fails a mux job when a segment stays unavailable after retries", async () => {
		const response = await app.fetch(
			mediaPostRequest("/video/mux-segments", {
				videoId: "failed-segment-mux-video",
				userId: "failed-segment-mux-user",
				outputPresignedUrl: uploadUrl("failed-segment-output.mp4"),
				videoInitUrl: fixtureUrl("test-no-audio.mp4"),
				videoSegmentUrls: [
					`${baseUrl}/fixtures/permanent-unavailable.m4s`,
					`${baseUrl}/fixtures/slow-segment.m4s`,
				],
			}),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as { jobId: string };
		const job = await waitForTerminalJob(data.jobId);
		try {
			expect(job.phase).toBe("error");
			expect(job.error).toContain("503");
			expect(permanentFixtureFailures).toBe(3);
			expect(slowFixtureCancellations).toBe(1);
			expect(uploadedArtifacts.has("/uploads/failed-segment-output.mp4")).toBe(
				false,
			);
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
