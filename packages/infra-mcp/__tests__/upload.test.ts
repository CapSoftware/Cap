import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import { DEFAULT_CLIENT_TUNING, InfraClient } from "../src/http";
import { DEFAULT_UPLOAD_TUNING, uploadVideo } from "../src/upload";
import {
	connect,
	eventually,
	expectNoSecrets,
	FAST,
	type Session,
	tempFiles,
} from "./harness";
import { type StubApi, startStubApi } from "./stub-api";

let stub: StubApi;
let session: Session;
let files: Awaited<ReturnType<typeof tempFiles>>;

beforeEach(async () => {
	stub = await startStubApi();
	session = await connect(stub);
	files = await tempFiles();
});

afterEach(async () => {
	expectNoSecrets(stub, session.output);
	await session.close();
	await stub.close();
	await files.remove();
});

const partNumbersAsked = () =>
	stub
		.calls("POST", "/presign-part")
		.map((request) => (request.body as { partNumbers: number[] }).partNumbers);

const restCalls = () =>
	stub.requests.filter((request) =>
		request.path.startsWith("/api/developer/v1/"),
	);

describe("unsupported formats", () => {
	it("refuses an AVI file locally with the supported formats before calling the API", async () => {
		const file = await files.write("lesson.avi", 20_000);
		const refused = await session.call("videos_upload", { path: file.path });

		expect(refused.isError).toBe(true);
		expect(refused.body).toMatchObject({
			error: {
				code: "unsupported_format",
				message: "lesson.avi is not a format Cap Infra can play",
			},
		});
		expect(JSON.stringify(refused.body)).toContain(
			"MP4, MOV, MKV and WebM files with H.264, HEVC, VP8, VP9, AV1, ProRes, MPEG-4 or Motion JPEG video",
		);
		expect(restCalls()).toHaveLength(0);
		expect(stub.videos.size).toBe(0);
	});
});

describe("multipart upload", () => {
	it("sends 127 parts with their links asked for 50 at a time", async () => {
		const file = await files.write("long.mp4", 129_500);
		const progress: number[] = [];
		const uploaded = await session.call(
			"videos_upload",
			{ path: file.path, durationSeconds: 42.5 },
			{ onprogress: (update) => progress.push(update.progress) },
		);
		expect(uploaded.isError).toBe(false);
		const video = stub.videos.get(String(uploaded.body.videoId));
		expect(video?.file?.equals(file.content)).toBe(true);
		expect(video?.duration).toBe(42.5);

		const batches = partNumbersAsked();
		expect(batches.map((batch) => batch.length)).toEqual([50, 50, 27]);
		expect(batches.flat()).toEqual(
			Array.from({ length: 127 }, (_, index) => index + 1),
		);
		expect(stub.calls("PUT", "").length).toBe(127);

		const completed = stub.calls("POST", "/complete")[0]?.body as {
			parts: { partNumber: number; size: number }[];
		};
		expect(completed.parts.map((part) => part.partNumber)).toEqual(
			batches.flat(),
		);
		expect(completed.parts.at(-1)?.size).toBe(129_500 - 126 * 1024);
		expect(progress[0]).toBe(0);
		expect(progress.at(-1)).toBe(129_500);
		expect(progress.length).toBeGreaterThanOrEqual(128);
		expect([...progress].sort((a, b) => a - b)).toEqual(progress);

		expect(restCalls().map((request) => request.path)).toEqual([
			"/api/developer/v1/uploads",
		]);
		for (const put of stub.calls("PUT", "")) {
			expect(put.headers.authorization).toBeUndefined();
		}
	});

	it("renews the upload token when it expires midway and at the end", async () => {
		const file = await files.write("renew.mp4", 80_000);
		let expiredForLinks = false;
		let expiredForComplete = false;
		stub.state.hang = (request) => {
			if (
				!expiredForLinks &&
				request.path.endsWith("/presign-part") &&
				stub.calls("POST", "/presign-part").length === 2
			) {
				expiredForLinks = true;
				stub.expireTokens();
			}
			if (!expiredForComplete && request.path.endsWith("/complete")) {
				expiredForComplete = true;
				stub.expireTokens();
			}
			return false;
		};

		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(false);
		const videoId = String(uploaded.body.videoId);
		expect(stub.videos.get(videoId)?.file?.equals(file.content)).toBe(true);

		const renewals = stub.calls("POST", `/uploads/${videoId}/token`);
		expect(renewals).toHaveLength(2);
		for (const renewal of renewals) {
			expect(renewal.headers.authorization).toBe(`Bearer ${stub.secretKey}`);
		}
		expect(stub.calls("POST", "/initiate")).toHaveLength(1);
		expect(partNumbersAsked().flat().length).toBeGreaterThanOrEqual(79);
		expect(stub.videos.get(videoId)?.aborted).toBe(0);
	});

	it("uploads a part again with a fresh link when storage refuses it", async () => {
		const file = await files.write("flaky.mp4", 20_000);
		stub.state.failParts.set(7, 2);
		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(false);
		const video = stub.videos.get(String(uploaded.body.videoId));
		expect(video?.file?.equals(file.content)).toBe(true);
		expect(partNumbersAsked().filter((batch) => batch[0] === 7)).toHaveLength(
			2,
		);
	});

	it("reports the video id when a part keeps failing, then retries into the same video", async () => {
		const file = await files.write("stuck.mp4", 20_000);
		stub.state.failParts.set(7, 99);
		const failed = await session.call("videos_upload", { path: file.path });
		expect(failed.isError).toBe(true);
		const videoId = [...stub.videos.keys()][0];
		expect(failed.body).toMatchObject({
			error: {
				code: "part_upload_failed",
				message: "Part 7 of 20 could not be stored (status 500)",
			},
			videoId,
			videoStatus: "uploading",
		});
		expect(failed.body.next).toMatch(/videos_upload again with this videoId/);
		expect(stub.videos.get(String(videoId))?.aborted).toBe(1);
		expect(session.events).toContainEqual({
			event: "videos_upload_failed",
			code: "part_upload_failed",
			videoId,
			videoStatus: "uploading",
			next: failed.body.next,
		});

		stub.state.failParts.clear();
		const retried = await session.call("videos_upload", {
			path: file.path,
			videoId,
		});
		expect(retried.isError).toBe(false);
		expect(retried.body.videoId).toBe(videoId);
		expect(stub.videos.size).toBe(1);
		expect(stub.videos.get(String(videoId))?.file?.equals(file.content)).toBe(
			true,
		);
		expect(stub.calls("POST", "/api/developer/v1/uploads")).toHaveLength(1);
		expect(stub.calls("POST", `/uploads/${videoId}/token`)).toHaveLength(1);
	});

	it("repeats completion while another request is completing it", async () => {
		const file = await files.write("busy.mp4", 3000);
		stub.state.completionBusy = 2;
		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(false);
		expect(stub.calls("POST", "/complete")).toHaveLength(3);
		expect(stub.calls("POST", "/abort")).toHaveLength(0);
	});

	it("waits for Retry-After before repeating completion", async () => {
		const file = await files.write("busy.mp4", 3000);
		stub.state.completionBusy = 1;
		stub.state.completionRetryAfterSeconds = 1;
		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(false);
		const [busy, done] = stub.calls("POST", "/complete");
		expect(stub.calls("POST", "/complete")).toHaveLength(2);
		expect((done?.at ?? 0) - (busy?.at ?? 0)).toBeGreaterThanOrEqual(1000);
	});

	it("does not abort when completion never answers", async () => {
		await session.close();
		session = await connect(stub, {
			...FAST,
			client: { requestTimeoutMs: 150 },
		});
		const file = await files.write("silent.mp4", 3000);
		stub.state.hang = (request) => request.path.endsWith("/complete");
		const failed = await session.call("videos_upload", { path: file.path });
		const videoId = [...stub.videos.keys()][0];
		expect(failed.body).toMatchObject({
			error: { code: "timeout" },
			videoId,
			videoStatus: "unknown",
		});
		expect(failed.body.next).toMatch(/may have completed/);
		expect(stub.calls("POST", "/complete")).toHaveLength(6);
		expect(stub.calls("POST", "/abort")).toHaveLength(0);
	});
});

describe("cancelling an upload", () => {
	it("stops, discards the parts and keeps the video id reachable", async () => {
		const file = await files.write("cancel.mp4", 300_000);
		stub.state.partDelayMs = 25;
		const controller = new AbortController();
		const pending = session
			.call("videos_upload", { path: file.path }, { signal: controller.signal })
			.then(
				() => "finished",
				() => "cancelled",
			);
		await eventually(() => stub.calls("PUT", "").length >= 12);
		const videoId = [...stub.videos.keys()][0];
		expect(session.events).toContainEqual({ event: "video_created", videoId });

		controller.abort();
		expect(await pending).toBe("cancelled");
		await eventually(() =>
			session.events.some((event) => event.event === "videos_upload_cancelled"),
		);
		expect(
			session.events.find((event) => event.event === "videos_upload_cancelled"),
		).toMatchObject({ code: "cancelled", videoId, videoStatus: "uploading" });
		expect(
			session.output.some(
				(line) =>
					line.startsWith("cap-infra: videos_upload_cancelled") &&
					line.includes(String(videoId)),
			),
		).toBe(true);

		const video = stub.videos.get(String(videoId));
		expect(video?.aborted).toBe(1);
		expect(video?.deleted).toBe(false);
		expect(video?.status).toBe("uploading");
		const sent = stub.calls("PUT", "").length;
		expect(sent).toBeLessThan(293);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(stub.calls("PUT", "").length).toBe(sent);

		const listed = await session.call("videos_list");
		expect(listed.body.videos).toMatchObject([
			{ id: videoId, status: "uploading" },
		]);
		const waited = await session.call("videos_wait", { videoId });
		expect(waited.body).toMatchObject({ videoId, status: "uploading" });
		expect(waited.body.next).toMatch(/has no file yet/);
		const deleted = await session.call("videos_delete", { videoId });
		expect(deleted.body).toEqual({ videoId, deleted: true });
	});

	it("carries the video id on the error the tool result is built from", async () => {
		const file = await files.write("cancel.mp4", 100_000);
		stub.state.partDelayMs = 25;
		const client = new InfraClient(
			readConfig({ CAP_SECRET_KEY: stub.secretKey, CAP_API_URL: stub.url }),
			DEFAULT_CLIENT_TUNING,
		);
		const controller = new AbortController();
		let created: string | null = null;
		const pending = uploadVideo(
			client,
			{ ...DEFAULT_UPLOAD_TUNING, ...FAST.upload },
			{ path: file.path },
			{
				signal: controller.signal,
				onVideo: (videoId) => {
					created = videoId;
				},
			},
		).catch((error: unknown) => error);
		await eventually(() => stub.calls("PUT", "").length >= 4);
		controller.abort();
		const error = (await pending) as {
			code: string;
			context: Record<string, unknown>;
		};
		expect(error.code).toBe("cancelled");
		expect(error.context.videoId).toBe(created);
		expect(error.context.videoId).toBe([...stub.videos.keys()][0]);
	});
});
