import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	connect,
	eventually,
	expectNoSecrets,
	FAST,
	type Session,
	tempFiles,
} from "./harness";
import { type StubApi, type StubRequest, startStubApi } from "./stub-api";

let stub: StubApi;
let session: Session;
let files: Awaited<ReturnType<typeof tempFiles>>;
const billing = () => `${stub.url}/dashboard/infra/app_stub/billing`;

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

const reconnect = async (options: Parameters<typeof connect>[1]) => {
	await session.close();
	session = await connect(stub, options);
};

const uploadOne = async (name = "demo.mp4") => {
	const file = await files.write(name, 2000);
	const uploaded = await session.call("videos_upload", { path: file.path });
	return String(uploaded.body.videoId);
};

const isStart = (request: StubRequest) =>
	request.method === "POST" && request.path.endsWith("/start");

const readsOf = (videoId: string) =>
	stub.requests.filter(
		(request) =>
			request.method === "GET" && request.path.includes(`/videos/${videoId}`),
	);

const gaps = (requests: StubRequest[]) =>
	requests
		.slice(1)
		.map((request, index) => request.at - (requests[index]?.at ?? 0));

describe("a transcript whose start answer is lost", () => {
	it("reports an unknown state and says to check before anything else", async () => {
		await reconnect({ ...FAST, client: { requestTimeoutMs: 150 } });
		const file = await files.write("standup.m4a", 5000);
		stub.state.dropAnswer = isStart;
		const failed = await session.call("transcripts_create", {
			path: file.path,
		});
		const transcriptId = [...stub.transcripts.keys()][0];
		expect(failed.isError).toBe(true);
		expect(failed.body).toMatchObject({
			error: { code: "timeout" },
			transcriptId,
			transcriptStatus: "unknown",
		});
		expect(failed.body.next).toMatch(/transcripts_get or transcripts_wait/);
		expect(failed.body.next).toMatch(/may be running/);
		expect(failed.body.next).not.toMatch(/without its file|not charged/);
		expect(stub.transcripts.get(String(transcriptId))?.status).toBe("queued");
		expect(stub.calls("POST", "/start")).toHaveLength(2);

		const waited = await session.call("transcripts_wait", { transcriptId });
		expect(waited.body).toMatchObject({ id: transcriptId, status: "complete" });
	});

	it("asks again when one answer is lost, because starting twice is safe", async () => {
		await reconnect({ ...FAST, client: { requestTimeoutMs: 150 } });
		const file = await files.write("standup.m4a", 5000);
		let dropped = false;
		stub.state.dropAnswer = (request) => {
			if (dropped || !isStart(request)) return false;
			dropped = true;
			return true;
		};
		const created = await session.call("transcripts_create", {
			path: file.path,
		});
		expect(created.isError).toBe(false);
		expect(created.body.status).toBe("queued");
		expect(stub.calls("POST", "/start")).toHaveLength(2);
	});

	it("reports an unknown state when starting fails on the server", async () => {
		const file = await files.write("standup.m4a", 5000);
		stub.state.intercept = (request) =>
			isStart(request) ? { status: 500 } : null;
		const failed = await session.call("transcripts_create", {
			path: file.path,
		});
		expect(failed.body).toMatchObject({
			error: { code: "internal_error", status: 500 },
			transcriptStatus: "unknown",
		});
		expect(failed.body.next).toMatch(/transcripts_get or transcripts_wait/);
	});

	it("says the file is missing only when storing it failed", async () => {
		const file = await files.write("standup.m4a", 5000);
		stub.state.refuseTranscriptFile = true;
		const failed = await session.call("transcripts_create", {
			path: file.path,
		});
		const transcriptId = [...stub.transcripts.keys()][0];
		expect(failed.body).toMatchObject({
			error: { code: "file_upload_failed" },
			transcriptId,
			transcriptStatus: "uploading",
		});
		expect(failed.body.next).toMatch(/without its file/);
		expect(failed.body.next).toMatch(/transcripts_delete/);
		expect(stub.calls("POST", "/start")).toHaveLength(0);
	});

	it("reports an unknown state when the call is cancelled while starting", async () => {
		const file = await files.write("standup.wav", 2000);
		stub.state.hang = isStart;
		const controller = new AbortController();
		const pending = session
			.call(
				"transcripts_create",
				{ path: file.path },
				{ signal: controller.signal },
			)
			.catch((error: unknown) => error);
		await eventually(() => stub.calls("POST", "/start").length > 0);
		controller.abort();
		await pending;
		await eventually(() =>
			session.events.some(
				(event) => event.event === "transcripts_create_cancelled",
			),
		);
		const cancelled = session.events.find(
			(event) => event.event === "transcripts_create_cancelled",
		);
		expect(cancelled).toMatchObject({
			transcriptId: [...stub.transcripts.keys()][0],
			transcriptStatus: "unknown",
		});
		expect(String(cancelled?.next)).toMatch(/transcripts_get/);
	});
});

describe("the recovery text in the drafts", () => {
	const read = (name: string) =>
		readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

	it.each(["skill/SKILL.md", "README.md"])(
		"%s tells the agent to check before retrying or deleting",
		(name) => {
			const text = read(name);
			expect(text).not.toMatch(/names a `videoId` that has no file/);
			expect(text).not.toMatch(/leaves the video in place with no file/);
			expect(text).toMatch(/`videoStatus`/);
			expect(text).toMatch(/`unknown`/);
			expect(text).toMatch(/videos_get/);
			expect(text).toMatch(/`next`/);
		},
	);

	it.each(["skill/SKILL.md", "README.md"])(
		"%s says a result with missing links is final",
		(name) => {
			const text = read(name);
			expect(text).toMatch(/`missing`/);
			expect(text).toMatch(/30 seconds/);
			expect(text).toMatch(/may not be coming/);
		},
	);

	it("the skill stops for credit only when credit is needed", () => {
		const text = read("skill/SKILL.md");
		expect(text).not.toMatch(/or any tool answers with `addCreditAt`/);
		expect(text).toMatch(/`upload\.allowed` is false/);
	});

	it("names only tools that exist, and the README lists every tool", async () => {
		const { tools } = await session.client.listTools();
		const names = tools.map((tool) => tool.name);
		for (const name of ["skill/SKILL.md", "README.md"]) {
			const mentioned = new Set(
				read(name).match(/\b(videos|transcripts|account)_[a-z]+\b/g) ?? [],
			);
			for (const tool of mentioned) expect(names, name).toContain(tool);
		}
		for (const tool of names) expect(read("README.md")).toContain(tool);
	});
});

describe("account_usage", () => {
	it("carries no credit link while the app can upload", async () => {
		const usage = await session.call("account_usage");
		expect(usage.body.upload).toMatchObject({ allowed: true });
		expect(usage.body.addCreditAt).toBeUndefined();
	});

	it.each(["out_of_credit", "insufficient_credits"] as const)(
		"carries the credit link when the app is %s",
		async (code) => {
			stub.state.credit = code;
			const usage = await session.call("account_usage");
			expect(usage.isError).toBe(false);
			expect(usage.body.upload).toMatchObject({ allowed: false, reason: code });
			expect(usage.body.addCreditAt).toBe(billing());
		},
	);
});

describe("outputs that arrive after the video is ready", () => {
	it("waits for both playback links by default", async () => {
		const videoId = await uploadOne();
		stub.state.hlsAfterReads = 3;
		const waited = await session.call("videos_wait", { videoId });
		const base = `${stub.url}/api/developer/playback/${stub.videos.get(videoId)?.playbackId}`;
		expect(waited.isError).toBe(false);
		expect(waited.body).toMatchObject({
			status: "ready",
			hlsUrl: `${base}/master.m3u8`,
			mp4Url: `${base}/video.mp4`,
		});
		expect(waited.body.timedOut).toBeUndefined();
		expect(waited.body.missing).toBeUndefined();
	});

	it("returns as soon as the one link the caller asked for exists", async () => {
		const videoId = await uploadOne();
		stub.state.hlsAfterReads = 1_000_000;
		const waited = await session.call("videos_wait", {
			videoId,
			output: "mp4",
		});
		expect(waited.body).toMatchObject({ status: "ready", hlsUrl: null });
		expect(waited.body.mp4Url).toMatch(/video\.mp4$/);
		expect(waited.body.timedOut).toBeUndefined();

		const any = await session.call("videos_wait", { videoId, output: "any" });
		expect(any.body.timedOut).toBeUndefined();
		expect(any.body.missing).toBeUndefined();
	});

	it("settles soon after ready when the HLS link never arrives", async () => {
		const videoId = await uploadOne();
		stub.state.hlsAfterReads = 1_000_000;
		const startedAt = Date.now();
		const waited = await session.call("videos_wait", {
			videoId,
			output: "hls",
		});
		expect(Date.now() - startedAt).toBeLessThan(1500);
		expect(waited.isError).toBe(false);
		expect(waited.body).toMatchObject({
			status: "ready",
			hlsUrl: null,
			missing: ["hlsUrl"],
		});
		expect(waited.body.timedOut).toBeUndefined();
		expect(waited.body.next).toMatch(/may not be coming/);
		expect(waited.body.next).toMatch(
			/plays with mp4Url, shareUrl and embedUrl/,
		);
		expect(waited.body.next).not.toMatch(/videos_wait/);
	});

	it("settles soon after ready when the MP4 never arrives, and does not say to wait again", async () => {
		const videoId = await uploadOne();
		stub.state.mp4Failed = true;
		const startedAt = Date.now();
		const waited = await session.call("videos_wait", { videoId });
		const elapsed = Date.now() - startedAt;
		expect(elapsed).toBeGreaterThanOrEqual(400);
		expect(elapsed).toBeLessThan(1500);
		expect(waited.isError).toBe(false);
		expect(waited.body).toMatchObject({
			status: "ready",
			mp4Url: null,
			missing: ["mp4Url"],
		});
		expect(waited.body.hlsUrl).toMatch(/master\.m3u8$/);
		expect(waited.body.shareUrl).toMatch(/\/dev\//);
		expect(waited.body.timedOut).toBeUndefined();
		expect(waited.body.next).toMatch(/may not be coming/);
		expect(waited.body.next).toMatch(
			/plays with hlsUrl, shareUrl and embedUrl/,
		);
		expect(waited.body.next).toMatch(
			/only for download and for transcripts_create with videoId/,
		);
		expect(waited.body.next).not.toMatch(/videos_wait/);
		expect(waited.body.next).not.toMatch(/again/);

		const second = await session.call("videos_wait", {
			videoId,
			output: "mp4",
		});
		expect(second.body).toMatchObject({ missing: ["mp4Url"] });
		expect(second.body.timedOut).toBeUndefined();
		expect(second.body.next).not.toMatch(/videos_wait/);
	});

	it("clips that grace to the caller's deadline", async () => {
		await reconnect({
			...FAST,
			wait: { ...FAST.wait, outputGraceMs: 60_000 },
		});
		const videoId = await uploadOne();
		stub.state.mp4Failed = true;
		const startedAt = Date.now();
		const waited = await session.call("videos_wait", {
			videoId,
			timeoutSeconds: 2,
		});
		expect(Date.now() - startedAt).toBeLessThan(2400);
		expect(waited.body).toMatchObject({
			status: "ready",
			missing: ["mp4Url"],
		});
		expect(waited.body.timedOut).toBeUndefined();
		expect(waited.body.next).toMatch(/may not be coming/);
		expect(waited.body.next).not.toMatch(/videos_wait/);
	});

	it("still reports a timeout while the video is not ready at all", async () => {
		const videoId = await uploadOne();
		stub.state.readyAfterPolls = 1_000_000;
		const waited = await session.call("videos_wait", {
			videoId,
			timeoutSeconds: 2,
		});
		expect(waited.body).toMatchObject({
			status: "processing",
			timedOut: true,
		});
		expect(waited.body.missing).toBeUndefined();
		expect(waited.body.next).toMatch(/Call videos_wait again/);
	});

	it("runs upload, wait, then transcript from the video when HLS lands first", async () => {
		const videoId = await uploadOne("Interview.mp4");
		stub.state.mp4AfterReads = 3;
		const waited = await session.call("videos_wait", { videoId });
		expect(waited.body.mp4Url).toMatch(/video\.mp4$/);
		const created = await session.call("transcripts_create", { videoId });
		expect(created.isError).toBe(false);
		expect(created.body.metadata).toEqual({ videoId });
	});

	it("waits briefly for the MP4 link when creating a transcript from a ready video", async () => {
		const videoId = await uploadOne("Interview.mp4");
		stub.state.mp4AfterReads = 1_000_000;
		await session.call("videos_wait", { videoId, output: "hls" });
		stub.state.mp4AfterReads = (stub.videos.get(videoId)?.readyReads ?? 0) + 2;
		const created = await session.call("transcripts_create", { videoId });
		expect(created.isError).toBe(false);
		expect(stub.calls("POST", "/transcripts")[0]?.body).toMatchObject({
			url: `${stub.url}/api/developer/playback/${stub.videos.get(videoId)?.playbackId}/video.mp4`,
			name: "Interview",
		});
		expect(
			stub.calls("GET", `/videos/${videoId}`).length,
		).toBeGreaterThanOrEqual(3);
	});

	it("says plainly that a ready video has no MP4, with the two ways forward", async () => {
		const videoId = await uploadOne();
		stub.state.mp4Failed = true;
		await session.call("videos_wait", { videoId, output: "hls" });
		const startedAt = Date.now();
		const refused = await session.call("transcripts_create", { videoId });
		expect(Date.now() - startedAt).toBeLessThan(1600);
		expect(refused.isError).toBe(true);
		expect(refused.body).toMatchObject({
			error: { code: "video_has_no_mp4", message: "This video has no MP4" },
			videoId,
			videoStatus: "ready",
		});
		const hint = (refused.body.error as { hint: string }).hint;
		expect(hint).toMatch(/original file with path/);
		expect(hint).toMatch(/public link to it with url/);
		expect(hint).not.toMatch(/videos_wait/);
		expect(stub.calls("POST", "/transcripts")).toHaveLength(0);
	});

	it("still points at videos_wait while the video is encoding", async () => {
		const videoId = await uploadOne();
		const refused = await session.call("transcripts_create", { videoId });
		expect(refused.body).toMatchObject({
			error: { code: "video_not_ready" },
			videoStatus: "processing",
		});
		expect((refused.body.error as { hint: string }).hint).toMatch(
			/videos_wait/,
		);
	});

	it("does not wait on a video that failed or has no file", async () => {
		stub.state.videoOutcome = "errored";
		const videoId = await uploadOne();
		await session.call("videos_wait", { videoId });
		const startedAt = Date.now();
		const refused = await session.call("transcripts_create", { videoId });
		expect(Date.now() - startedAt).toBeLessThan(300);
		expect(refused.body).toMatchObject({
			error: { code: "video_not_ready" },
			videoStatus: "errored",
		});
	});
});

describe("a completion that fails on the server after the file was assembled", () => {
	it("is sent again, and succeeds without an abort or a second upload", async () => {
		const file = await files.write("assembled.mp4", 5000);
		stub.state.failAfterAssembly = 1;
		const uploaded = await session.call("videos_upload", { path: file.path });
		expect(uploaded.isError).toBe(false);
		const video = stub.videos.get(String(uploaded.body.videoId));
		expect(video?.status).toBe("processing");
		expect(video?.file?.equals(file.content)).toBe(true);
		expect(stub.calls("POST", "/complete")).toHaveLength(2);
		expect(stub.calls("POST", "/abort")).toHaveLength(0);
		expect(stub.calls("PUT", "")).toHaveLength(5);
	});

	it("keeps the check-first advice and never aborts while the answer stays a server error", async () => {
		const file = await files.write("assembled.mp4", 5000);
		stub.state.failAfterAssembly = 1_000_000;
		const failed = await session.call("videos_upload", { path: file.path });
		const videoId = String([...stub.videos.keys()][0]);
		expect(failed.isError).toBe(true);
		expect(failed.body).toMatchObject({
			error: { code: "internal_error", status: 500 },
			videoId,
			videoStatus: "unknown",
		});
		expect(failed.body.next).toMatch(/videos_get/);
		expect(failed.body.next).not.toMatch(/no file/);
		expect(stub.calls("POST", "/complete")).toHaveLength(6);
		expect(stub.calls("POST", "/abort")).toHaveLength(0);
		expect(stub.videos.get(videoId)?.file?.equals(file.content)).toBe(true);
		const spacing = gaps(stub.calls("POST", "/complete"));
		expect(spacing[4]).toBeGreaterThan((spacing[0] ?? 0) * 4);
	});

	it("does not abort after a server error even when the next answer is a refusal", async () => {
		const file = await files.write("assembled.mp4", 5000);
		stub.state.failAfterAssembly = 1;
		stub.state.hang = (request) => {
			if (
				request.path.endsWith("/complete") &&
				stub.calls("POST", "/complete").length === 2
			) {
				stub.state.credit = "insufficient_credits";
			}
			return false;
		};
		const failed = await session.call("videos_upload", { path: file.path });
		expect(failed.body).toMatchObject({
			error: { code: "insufficient_credits", status: 402, fileRemoved: true },
			videoStatus: "unknown",
			addCreditAt: billing(),
		});
		expect(failed.body.next).toMatch(/videos_get/);
		expect(stub.calls("POST", "/abort")).toHaveLength(0);
	});
});

describe("retrying into an existing video", () => {
	it("returns the video's playback id, share and embed links", async () => {
		const file = await files.write("stuck.mp4", 20_000);
		stub.state.failParts.set(7, 99);
		await session.call("videos_upload", { path: file.path });
		const videoId = String([...stub.videos.keys()][0]);
		stub.state.failParts.clear();
		const retried = await session.call("videos_upload", {
			path: file.path,
			videoId,
		});
		const playbackId = stub.videos.get(videoId)?.playbackId;
		expect(retried.isError).toBe(false);
		expect(retried.body).toMatchObject({
			videoId,
			playbackId,
			shareUrl: `${stub.url}/dev/${playbackId}`,
			embedUrl: `${stub.url}/dev/${playbackId}/embed`,
		});
	});
});

describe("cleanup after a failed upload", () => {
	it("keeps to its own time limit when the token expired and renewal hangs", async () => {
		const file = await files.write("stuck.mp4", 20_000);
		stub.state.failParts.set(7, 99);
		stub.state.hang = (request) => {
			if (request.path.endsWith("/abort")) stub.expireTokens();
			return request.path.endsWith("/token");
		};
		const startedAt = Date.now();
		const failed = await session.call("videos_upload", { path: file.path });
		expect(Date.now() - startedAt).toBeLessThan(2000);
		expect(failed.body).toMatchObject({
			error: { code: "part_upload_failed" },
			videoStatus: "uploading",
		});
		expect(stub.calls("POST", "/abort")).toHaveLength(1);
		expect(stub.calls("POST", "/token")).toHaveLength(1);
	}, 10_000);
});

describe("a rate limit that is extended while a call waits", () => {
	it("keeps the waiting call back until the later limit lifts", async () => {
		let slow = true;
		let quick = true;
		stub.state.intercept = (request) => {
			if (slow && request.path.endsWith("/usage")) {
				slow = false;
				return { status: 429, retryAfterSeconds: 2, delayMs: 400 };
			}
			if (quick && request.path.endsWith("/videos")) {
				quick = false;
				return { status: 429, retryAfterSeconds: 1 };
			}
			return null;
		};
		const usage = session.call("account_usage");
		await eventually(() => stub.calls("GET", "/usage").length === 1);
		const listed = session.call("videos_list");
		await eventually(() => stub.calls("GET", "/videos").length === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const ledger = await session.call("account_transactions");
		expect(ledger.isError).toBe(false);
		expect((await usage).isError).toBe(false);
		expect((await listed).isError).toBe(false);

		const limitedAt = (stub.calls("GET", "/usage")[0]?.at ?? 0) + 400;
		const ledgerAt = stub.calls("GET", "/transactions")[0]?.at ?? 0;
		expect(stub.calls("GET", "/transactions")).toHaveLength(1);
		expect(ledgerAt - limitedAt).toBeGreaterThanOrEqual(2000);
		for (const request of [
			...stub.calls("GET", "/usage").slice(1),
			...stub.calls("GET", "/videos").slice(1),
		]) {
			expect(request.at - limitedAt).toBeGreaterThanOrEqual(2000);
		}
	});
});

describe("the polling floor with the shipped settings", () => {
	it("holds when a status read cannot be served", async () => {
		await reconnect({ upload: FAST.upload });
		const videoId = await uploadOne();
		stub.state.readyAfterPolls = 1;
		let failed = false;
		stub.state.intercept = (request) => {
			if (failed || !request.path.endsWith("/status")) return null;
			failed = true;
			return { status: 503 };
		};
		const waited = await session.call("videos_wait", { videoId });
		expect(waited.body.status).toBe("ready");
		const reads = readsOf(videoId);
		expect(reads).toHaveLength(3);
		for (const gap of gaps(reads)) expect(gap).toBeGreaterThanOrEqual(3000);
	});

	it("holds when a status read is rate limited, and waits longer when told to", async () => {
		await reconnect({ upload: FAST.upload });
		const videoId = await uploadOne();
		stub.state.readyAfterPolls = 1;
		let limited = false;
		stub.state.intercept = (request) => {
			if (limited || !request.path.endsWith("/status")) return null;
			limited = true;
			return { status: 429, retryAfterSeconds: 1 };
		};
		const waited = await session.call("videos_wait", { videoId });
		expect(waited.body.status).toBe("ready");
		const reads = readsOf(videoId);
		expect(reads).toHaveLength(3);
		for (const gap of gaps(reads)) expect(gap).toBeGreaterThanOrEqual(3000);

		const created = await session.call("transcripts_create", {
			url: "https://files.example.com/a.mp3",
		});
		let slowed = false;
		stub.state.intercept = (request) => {
			if (slowed || !request.path.includes("/transcripts/")) return null;
			slowed = true;
			return { status: 429, retryAfterSeconds: 5 };
		};
		stub.state.readyAfterPolls = 1;
		const transcript = await session.call("transcripts_wait", {
			transcriptId: created.body.id,
		});
		expect(transcript.body.status).toBe("complete");
		const polls = stub.calls("GET", `/transcripts/${created.body.id}`);
		expect(polls).toHaveLength(2);
		expect(gaps(polls)[0]).toBeGreaterThanOrEqual(5000);
	});
});

describe("upload progress", () => {
	it("sends each part as plain bytes when the client asked for no progress", async () => {
		const file = await files.write("quiet.mp4", 5000);
		const result = await session.client.callTool({
			name: "videos_upload",
			arguments: { path: file.path },
		});
		expect(result.isError).toBeFalsy();
		const puts = stub.calls("PUT", "");
		expect(puts).toHaveLength(5);
		for (const put of puts) {
			expect(put.headers["transfer-encoding"]).toBeUndefined();
			expect(Number(put.headers["content-length"])).toBeGreaterThan(0);
		}
		expect([...stub.videos.values()][0]?.file?.equals(file.content)).toBe(true);
	});

	it("reports bytes as they are sent, within a single part too", async () => {
		await reconnect({
			...FAST,
			upload: { ...FAST.upload, partBytes: 1024 * 1024 },
		});
		const file = await files.write("one-part.mp4", 600_000);
		const updates: { progress: number; total?: number; message?: string }[] =
			[];
		const uploaded = await session.call(
			"videos_upload",
			{ path: file.path },
			{ onprogress: (update) => updates.push(update) },
		);
		expect(uploaded.isError).toBe(false);
		const [put] = stub.calls("PUT", "");
		expect(stub.calls("PUT", "")).toHaveLength(1);
		expect(put?.headers["content-length"]).toBe("600000");
		expect(put?.headers["transfer-encoding"]).toBeUndefined();
		expect(updates.length).toBeGreaterThanOrEqual(4);
		expect(updates[0]).toMatchObject({ progress: 0, total: 600_000 });
		expect(updates.at(-1)).toMatchObject({ progress: 600_000, total: 600_000 });
		expect(updates.at(-1)?.message).toBe("Uploaded 0.6 of 0.6 MB");
		const sent = updates.map((update) => update.progress);
		expect([...sent].sort((a, b) => a - b)).toEqual(sent);
		expect(
			stub.videos
				.get(String(uploaded.body.videoId))
				?.file?.equals(file.content),
		).toBe(true);
	});
});
