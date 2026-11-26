import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retryAfterMs } from "../src/http";
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

const uploadOne = async () => {
	const file = await files.write("demo.mp4", 2000);
	const uploaded = await session.call("videos_upload", { path: file.path });
	return String(uploaded.body.videoId);
};

describe("rate limits", () => {
	it("reads Retry-After as seconds or as a date", () => {
		expect(retryAfterMs("7")).toBe(7000);
		expect(retryAfterMs("0.5")).toBe(500);
		expect(retryAfterMs(null)).toBeNull();
		expect(retryAfterMs("soon")).toBeNull();
		const now = Date.parse("2026-11-12T10:00:00Z");
		expect(retryAfterMs("Thu, 12 Nov 2026 10:00:09 GMT", now)).toBe(9000);
		expect(retryAfterMs("Thu, 12 Nov 2026 09:00:00 GMT", now)).toBe(0);
	});

	it("waits for Retry-After, then sends the request again", async () => {
		stub.state.rateLimited = 1;
		stub.state.retryAfterSeconds = 1;
		const usage = await session.call("account_usage");
		expect(usage.isError).toBe(false);
		const [refused, retried] = stub.calls("GET", "/usage");
		expect(stub.calls("GET", "/usage")).toHaveLength(2);
		expect((retried?.at ?? 0) - (refused?.at ?? 0)).toBeGreaterThanOrEqual(
			1000,
		);
	});

	it("holds every other call until the limit lifts", async () => {
		stub.state.rateLimited = 1;
		stub.state.retryAfterSeconds = 1;
		const first = session.call("account_usage");
		await eventually(() => stub.calls("GET", "/usage").length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const second = await session.call("videos_list");
		await first;
		expect(second.isError).toBe(false);
		const refusedAt = stub.calls("GET", "/usage")[0]?.at ?? 0;
		const listedAt = stub.calls("GET", "/videos")[0]?.at ?? 0;
		expect(stub.calls("GET", "/videos")).toHaveLength(1);
		expect(listedAt - refusedAt).toBeGreaterThanOrEqual(1000);
	});

	it("returns the limit instead of waiting past the time a call may take", async () => {
		await session.close();
		session = await connect(stub, { ...FAST, client: { callTimeoutMs: 400 } });
		stub.state.rateLimited = 1;
		stub.state.retryAfterSeconds = 30;
		const startedAt = Date.now();
		const refused = await session.call("account_usage");
		expect(Date.now() - startedAt).toBeLessThan(400);
		expect(refused.isError).toBe(true);
		expect(refused.body.error).toMatchObject({
			code: "rate_limited",
			message: "Rate limit exceeded",
			status: 429,
			retryAfterSeconds: 31,
		});
		expect((refused.body.error as { hint: string }).hint).toBe(
			"Wait for the Retry-After seconds, then retry.",
		);

		const again = await session.call("videos_list");
		expect(again.body.error).toMatchObject({ code: "rate_limited" });
		expect(stub.calls("GET", "/videos")).toHaveLength(0);
	});

	it("waits for Retry-After on an upload token call too", async () => {
		const file = await files.write("demo.mp4", 3000);
		let limited = false;
		stub.state.hang = (request) => {
			if (!limited && request.path.endsWith("/presign-part")) {
				limited = true;
				stub.state.uploadRateLimited = 1;
				stub.state.retryAfterSeconds = 1;
			}
			return false;
		};
		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(false);
		const [refused, retried] = stub.calls("POST", "/presign-part");
		expect(stub.calls("POST", "/presign-part")).toHaveLength(2);
		expect((retried?.at ?? 0) - (refused?.at ?? 0)).toBeGreaterThanOrEqual(
			1000,
		);
		expect(
			stub.videos
				.get(String(uploaded.body.videoId))
				?.file?.equals(file.content),
		).toBe(true);
	});

	it("keeps upload token calls out of the secret key pause", async () => {
		const file = await files.write("demo.mp4", 60_000);
		let limited = false;
		let usage: Promise<unknown> = Promise.resolve();
		stub.state.hang = (request) => {
			if (!limited && request.path.endsWith("/initiate")) {
				limited = true;
				stub.state.rateLimited = 1;
				stub.state.retryAfterSeconds = 2;
				usage = session.call("account_usage");
			}
			return false;
		};
		const startedAt = Date.now();
		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(false);
		expect(Date.now() - startedAt).toBeLessThan(1500);
		await usage;
		expect(stub.calls("GET", "/usage")).toHaveLength(2);
	});
});

describe("transient failures", () => {
	it("repeats a read that the API could not serve", async () => {
		stub.state.unavailable = 1;
		const usage = await session.call("account_usage");
		expect(usage.isError).toBe(false);
		expect(stub.calls("GET", "/usage")).toHaveLength(2);
	});

	it("does not repeat a request that creates something", async () => {
		stub.state.unavailable = 1;
		const refused = await session.call("transcripts_create", {
			url: "https://files.example.com/a.mp3",
		});
		expect(refused.body.error).toMatchObject({
			code: "speech_unavailable",
			status: 503,
			hint: "Retry later.",
		});
		expect(stub.calls("POST", "/transcripts")).toHaveLength(1);
		expect(stub.transcripts.size).toBe(0);
	});
});

describe("waiting", () => {
	it("gives up at the deadline when the status endpoint hangs", async () => {
		const videoId = await uploadOne();
		stub.state.hang = (request) => request.path.endsWith("/status");
		const startedAt = Date.now();
		const waited = await session.call("videos_wait", {
			videoId,
			timeoutSeconds: 2,
		});
		const elapsed = Date.now() - startedAt;
		expect(elapsed).toBeGreaterThanOrEqual(1950);
		expect(elapsed).toBeLessThan(2400);
		expect(waited.isError).toBe(false);
		expect(waited.body).toMatchObject({
			videoId,
			status: "processing",
			timedOut: true,
		});
		expect(waited.body.lastPollError).toMatch(
			/^Cap did not answer within \d+ (ms|seconds)$/,
		);
		expect(waited.body.next).toMatch(/Call videos_wait again/);
		expect(waited.body.shareUrl).toBe(
			`${stub.url}/dev/${stub.videos.get(videoId)?.playbackId}`,
		);
		expect(stub.calls("GET", "/status")).toHaveLength(1);
	});

	it("gives up at the deadline when nothing ever answers", async () => {
		stub.state.hang = () => true;
		const startedAt = Date.now();
		const waited = await session.call("transcripts_wait", {
			transcriptId: "never",
			timeoutSeconds: 1,
		});
		expect(Date.now() - startedAt).toBeLessThan(1400);
		expect(waited.body).toMatchObject({
			id: "never",
			status: "unknown",
			timedOut: true,
		});
	});

	it("returns the last status when time runs out, and resumes on the next call", async () => {
		const videoId = await uploadOne();
		stub.state.readyAfterPolls = 1_000_000;
		const early = await session.call("videos_wait", {
			videoId,
			timeoutSeconds: 1,
		});
		expect(early.body).toMatchObject({
			videoId,
			status: "processing",
			timedOut: true,
		});
		expect(early.body.lastPollError).toBeUndefined();

		stub.state.readyAfterPolls = 0;
		const later = await session.call("videos_wait", { videoId });
		expect(later.body).toMatchObject({ videoId, status: "ready" });
		expect(later.body.timedOut).toBeUndefined();
	});

	it("does the same for a transcript", async () => {
		const created = await session.call("transcripts_create", {
			url: "https://files.example.com/a.mp3",
		});
		stub.state.readyAfterPolls = 1_000_000;
		const early = await session.call("transcripts_wait", {
			transcriptId: created.body.id,
			timeoutSeconds: 1,
		});
		expect(early.body).toMatchObject({
			id: created.body.id,
			status: "processing",
			timedOut: true,
		});
		expect(early.body.next).toMatch(/Call transcripts_wait again/);
	});

	it("stops asking as soon as the call is cancelled", async () => {
		const videoId = await uploadOne();
		stub.state.readyAfterPolls = 1_000_000;
		const controller = new AbortController();
		const pending = session
			.call("videos_wait", { videoId }, { signal: controller.signal })
			.catch(() => "cancelled");
		await eventually(() => stub.calls("GET", "/status").length >= 3);
		controller.abort();
		expect(await pending).toBe("cancelled");
		const asked = stub.calls("GET", "/status").length;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(stub.calls("GET", "/status").length).toBeLessThanOrEqual(asked + 1);
	});

	it("fails straight away when the video does not exist", async () => {
		const waited = await session.call("videos_wait", { videoId: "missing" });
		expect(waited.isError).toBe(true);
		expect(waited.body.error).toMatchObject({
			code: "video_not_found",
			status: 404,
		});
		expect(stub.requests).toHaveLength(1);
	});

	it("never asks more often than every 3 seconds with the shipped settings", async () => {
		await session.close();
		session = await connect(stub, { upload: FAST.upload });
		const videoId = await uploadOne();
		stub.state.readyAfterPolls = 2;
		const waited = await session.call("videos_wait", { videoId });
		expect(waited.body.status).toBe("ready");
		const polls = stub.requests.filter(
			(request) =>
				request.method === "GET" && request.path.includes(`/videos/${videoId}`),
		);
		expect(polls).toHaveLength(3);
		const gaps = polls
			.slice(1)
			.map((poll, index) => poll.at - (polls[index]?.at ?? 0));
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(3000);
		expect(gaps[1]).toBeGreaterThanOrEqual(3600);
	});
});
