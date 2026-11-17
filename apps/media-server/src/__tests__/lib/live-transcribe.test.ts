import { describe, expect, test } from "bun:test";
import {
	type LiveManifest,
	LiveSession,
	planLiveChunk,
	type StartLiveSession,
	transcribeAudio,
} from "../../lib/live-transcribe";

const seg = (index: number, duration = 2) => ({ index, duration });
const manifestOf = (
	segments: LiveManifest["audio_segments"],
	is_complete = false,
): LiveManifest => ({
	audio_init_uploaded: true,
	audio_segments: segments,
	is_complete,
});
const everyUrl = () => true;

describe("planLiveChunk", () => {
	const plan = (
		manifest: LiveManifest,
		lastProcessedIndex: number,
		options: Partial<Parameters<typeof planLiveChunk>[0]> = {},
	) =>
		planLiveChunk({
			manifest,
			lastProcessedIndex,
			targetSeconds: 5,
			contextSeconds: 0,
			hasUrl: everyUrl,
			...options,
		});

	test("waits for enough new audio, then takes it all", () => {
		expect(plan(manifestOf([seg(1), seg(2)]), -1)).toEqual({ action: "wait" });
		const chunk = plan(manifestOf([seg(1), seg(2), seg(3)]), -1);
		expect(chunk).toMatchObject({ action: "chunk", context: [] });
		if (chunk.action === "chunk") {
			expect(chunk.entries.map((entry) => entry.index)).toEqual([1, 2, 3]);
		}
	});

	test("sends the remainder once the recording is complete, then is done", () => {
		const manifest = manifestOf([seg(1), seg(2)], true);
		expect(plan(manifest, -1)).toMatchObject({ action: "chunk" });
		expect(plan(manifest, 2)).toEqual({ action: "done" });
		expect(plan(manifestOf([], true), -1)).toEqual({ action: "no-audio" });
		expect(plan(manifestOf([]), -1)).toEqual({ action: "wait" });
	});

	test("starts 0-based manifests at segment 0 and stops at gaps", () => {
		const zero = plan(manifestOf([0, 1, 2], true), -1);
		if (zero.action !== "chunk") throw new Error("expected a chunk");
		expect(zero.entries.map((entry) => entry.index)).toEqual([0, 1, 2]);

		const gap = plan(manifestOf([seg(1), seg(2), seg(4), seg(5)], true), -1);
		if (gap.action !== "chunk") throw new Error("expected a chunk");
		expect(gap.entries.map((entry) => entry.index)).toEqual([1, 2]);
		expect(plan(manifestOf([seg(1), seg(2), seg(4)], true), 2)).toEqual({
			action: "done",
		});
	});

	test("waits for the audio init while recording", () => {
		expect(
			plan(
				{ ...manifestOf([seg(1), seg(2), seg(3)]), audio_init_uploaded: false },
				-1,
			),
		).toEqual({ action: "wait" });
	});

	test("caps one chunk at a minute of audio", () => {
		const manifest = manifestOf(
			Array.from({ length: 50 }, (_, i) => seg(i + 1, 3)),
		);
		const chunk = plan(manifest, -1);
		if (chunk.action !== "chunk") throw new Error("expected a chunk");
		expect(chunk.entries).toHaveLength(20);
	});

	test("adds earlier segments as context, only those it has URLs for", () => {
		const manifest = manifestOf(
			Array.from({ length: 20 }, (_, i) => seg(i + 1)),
		);
		const chunk = plan(manifest, 10, { contextSeconds: 5 });
		if (chunk.action !== "chunk") throw new Error("expected a chunk");
		expect(chunk.context.map((entry) => entry.index)).toEqual([8, 9, 10]);

		const partial = plan(manifest, 10, {
			contextSeconds: 5,
			hasUrl: (index) => index >= 10,
		});
		if (partial.action !== "chunk") throw new Error("expected a chunk");
		expect(partial.context.map((entry) => entry.index)).toEqual([10]);
	});

	test("asks for URLs when the next segment has none", () => {
		const manifest = manifestOf([seg(1), seg(2), seg(3)], true);
		expect(plan(manifest, -1, { hasUrl: () => false })).toEqual({
			action: "need-urls",
		});
		const limited = plan(manifest, -1, { hasUrl: (index) => index <= 2 });
		if (limited.action !== "chunk") throw new Error("expected a chunk");
		expect(limited.entries.map((entry) => entry.index)).toEqual([1, 2]);
	});
});

type Report = Record<string, unknown> & { action: string };

/** Storage, transcription API and the web app's report endpoint in one fake. */
function createFakeCap() {
	const segments = new Map<number, Uint8Array<ArrayBuffer>>();
	let manifest: LiveManifest = manifestOf([]);
	let manifestVersion = 0;
	const reports: Report[] = [];
	const uploads = new Map<string, Uint8Array>();
	const failAudio = new Set<string>();
	let cursor = -1;
	let stopAfter: string | null = null;
	let hangOn: string | null = null;
	let manifestGets = 0;
	let notModified = 0;
	let server: ReturnType<typeof Bun.serve>;
	let asrSubmits = 0;

	const state = () => {
		const urls: Record<string, string> = {};
		for (let index = Math.max(0, cursor - 15); index <= cursor + 40; index++) {
			urls[String(index)] = `${base()}/storage/segment/${index}`;
		}
		return {
			lastAudioSegmentIndex: cursor,
			transcribedDurationMs: 0,
			transcriptionOptions: { language_code: "en" },
			urls: {
				manifest: `${base()}/storage/manifest`,
				audioInit: `${base()}/storage/init`,
				segments: urls,
			},
		};
	};
	const base = () => `http://127.0.0.1:${server.port}`;

	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const path = url.pathname;
			if (path === "/storage/manifest") {
				manifestGets++;
				const etag = `"m${manifestVersion}"`;
				if (request.headers.get("if-none-match") === etag) {
					notModified++;
					return new Response(null, { status: 304 });
				}
				return Response.json(manifest, { headers: { etag } });
			}
			if (path === "/storage/init") return new Response(new Uint8Array([0]));
			if (path.startsWith("/storage/segment/")) {
				const bytes = segments.get(Number(path.split("/").pop()));
				return bytes
					? new Response(bytes)
					: new Response(null, { status: 404 });
			}
			if (path === "/asr/v2/upload") {
				expect(request.headers.get("authorization")).toBe("asr-key");
				const id = `u${uploads.size}`;
				uploads.set(id, new Uint8Array(await request.arrayBuffer()));
				return Response.json({ upload_url: `${base()}/asr/files/${id}` });
			}
			if (path === "/asr/v2/transcript") {
				asrSubmits++;
				const body = (await request.json()) as { audio_url: string };
				const id = body.audio_url.split("/").pop() as string;
				return Response.json({ id: `t-${id}`, status: "queued" });
			}
			if (path.startsWith("/asr/v2/transcript/")) {
				const id = (path.split("/").pop() as string).slice(2);
				const audio = uploads.get(id) as Uint8Array;
				const key = [...audio.slice(1)].join(",");
				if (failAudio.has(key)) {
					return Response.json({ id, status: "error", error: "boom" });
				}
				// One word per audio byte after the init byte: its segment index.
				return Response.json({
					id,
					status: "completed",
					language_code: "en",
					words: [...audio.slice(1)].map((value, i) => ({
						text: `w${value}`,
						start: i * 1000,
						end: i * 1000 + 500,
						confidence: 0.9,
						speaker: null,
					})),
				});
			}
			if (path === "/web/report") {
				expect(request.headers.get("x-media-server-secret")).toBe("secret");
				const report = (await request.json()) as Report;
				reports.push(report);
				if (stopAfter && report.action === stopAfter) {
					return Response.json({ continue: false });
				}
				if (hangOn === report.action) {
					return new Promise<Response>(() => {});
				}
				if (report.action === "chunk" || report.action === "gap") {
					if (report.lastProcessedIndex === cursor) {
						cursor = report.lastIndex as number;
					}
				}
				if (report.action === "finish" || report.action === "release") {
					return Response.json({ continue: false });
				}
				return Response.json({ continue: true, state: state() });
			}
			return new Response(null, { status: 404 });
		},
	});

	return {
		get base() {
			return base();
		},
		reports,
		state,
		failAudio,
		setCursor(value: number) {
			cursor = value;
		},
		hangOn(action: string) {
			hangOn = action;
		},
		stopOn(action: string) {
			stopAfter = action;
		},
		get manifestGets() {
			return manifestGets;
		},
		get notModified() {
			return notModified;
		},
		get asrSubmits() {
			return asrSubmits;
		},
		record(indices: number[], is_complete = false) {
			for (const index of indices) segments.set(index, new Uint8Array([index]));
			manifest = manifestOf(
				[...segments.keys()].sort((a, b) => a - b).map((index) => seg(index)),
				is_complete,
			);
			manifestVersion++;
		},
		stop() {
			server.stop(true);
		},
	};
}

const fastSleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, Math.min(ms, 5));
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

function startRequest(
	cap: ReturnType<typeof createFakeCap>,
	contextSeconds = 0,
): StartLiveSession {
	return {
		videoId: "video1",
		session: "s1",
		callbackUrl: `${cap.base}/web/report`,
		asr: { baseUrl: `${cap.base}/asr`, apiKey: "asr-key" },
		contextSeconds,
		state: cap.state(),
	};
}

const deps = { sleep: fastSleep, secret: "secret" };

describe("LiveSession", () => {
	test("transcribes a recording as it grows, then reports done", async () => {
		const fresh = createFakeCap();
		const session = new LiveSession(startRequest(fresh, 4), deps);
		const done = session.start();
		for (let index = 1; index <= 24; index++) {
			fresh.record([index], index === 24);
			await Bun.sleep(3);
		}
		await done;
		fresh.stop();

		const chunks = fresh.reports.filter((report) => report.action === "chunk");
		let expected = -1;
		for (const chunk of chunks) {
			expect(chunk.lastProcessedIndex).toBe(expected);
			expected = chunk.lastIndex as number;
		}
		expect(expected).toBe(24);
		// The first chunk is small, and later ones carry earlier audio as
		// context, which the words prove was sent in order.
		expect(chunks[0]?.contextFromIndex).toBeNull();
		const later = chunks.find((chunk) => chunk.contextFromIndex !== null);
		expect(later).toBeDefined();
		if (later) {
			const from = later.contextFromIndex as number;
			const words = (later.words as { text: string }[]).map((w) => w.text);
			expect(words[0]).toBe(`w${from}`);
			expect(words.at(-1)).toBe(`w${later.lastIndex}`);
		}
		expect(fresh.reports.at(-1)).toMatchObject({
			action: "finish",
			outcome: "done",
			videoId: "video1",
			session: "s1",
		});
		expect(fresh.notModified).toBeGreaterThan(0);
	});

	test("retries a failing chunk without context, then reports a gap", async () => {
		const fresh = createFakeCap();
		fresh.record([1, 2, 3, 4, 5], true);
		fresh.failAudio.add("1,2,3,4,5");
		const session = new LiveSession(startRequest(fresh, 10), deps);
		await session.start();
		fresh.stop();

		expect(fresh.asrSubmits).toBe(2);
		expect(fresh.reports.map((report) => report.action)).toEqual([
			"gap",
			"finish",
		]);
		expect(fresh.reports[0]).toMatchObject({
			lastProcessedIndex: -1,
			lastIndex: 5,
		});
	});

	test("stops quietly when the web app says to", async () => {
		const fresh = createFakeCap();
		fresh.record([1, 2, 3, 4]);
		fresh.stopOn("chunk");
		await new LiveSession(startRequest(fresh), deps).start();
		fresh.stop();
		expect(fresh.reports.map((report) => report.action)).toEqual(["chunk"]);
	});

	test("ends with no-audio for a finished recording without audio", async () => {
		const fresh = createFakeCap();
		fresh.record([], true);
		await new LiveSession(startRequest(fresh), deps).start();
		fresh.stop();
		expect(fresh.reports).toEqual([
			expect.objectContaining({ action: "finish", outcome: "no-audio" }),
		]);
	});

	test("hands the recording back when released", async () => {
		const fresh = createFakeCap();
		fresh.record([1]);
		const session = new LiveSession(startRequest(fresh), deps);
		session.start();
		await Bun.sleep(20);
		await session.release();
		fresh.stop();
		expect(fresh.reports.at(-1)).toMatchObject({ action: "release" });
		expect(
			fresh.reports.some((report) => report.action === "finish"),
		).toBeFalse();
	});

	test("hands over at once even while a chunk report is stuck", async () => {
		const fresh = createFakeCap();
		fresh.record([1, 2, 3, 4]);
		fresh.hangOn("chunk");
		const session = new LiveSession(startRequest(fresh), deps);
		session.start();
		for (let i = 0; i < 400; i++) {
			if (fresh.reports.some((report) => report.action === "chunk")) break;
			await Bun.sleep(5);
		}
		const releasedAt = Date.now();
		await session.release();
		const waited = Date.now() - releasedAt;
		fresh.stop();
		expect(waited).toBeLessThan(1_000);
		expect(fresh.reports.map((report) => report.action)).toEqual([
			"chunk",
			"release",
		]);
	});

	test("resyncs to the web app's cursor instead of resending audio", async () => {
		const fresh = createFakeCap();
		fresh.record([1, 2, 3, 4, 5, 6], true);
		const request = startRequest(fresh);
		// The web app already holds 1..3 (say a report's answer was lost).
		fresh.setCursor(3);
		await new LiveSession(request, deps).start();
		fresh.stop();
		const chunks = fresh.reports.filter((report) => report.action === "chunk");
		expect(
			chunks.map((chunk) => [chunk.lastProcessedIndex, chunk.lastIndex]),
		).toEqual([
			[-1, 6],
			[3, 6],
		]);
		expect(fresh.reports.at(-1)).toMatchObject({ outcome: "done" });
	});
});

describe("transcribeAudio", () => {
	test("treats speech-free audio as an empty chunk and surfaces errors", async () => {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === "/v2/upload") return Response.json({ upload_url: "x" });
				const body = (await request.json()) as { language_code: string };
				return Response.json({
					id: "t1",
					status: "error",
					error:
						body.language_code === "quiet"
							? "No spoken audio detected"
							: "decode failed",
				});
			},
		});
		const call = (language_code: string) =>
			transcribeAudio({
				baseUrl: `http://127.0.0.1:${server.port}/`,
				apiKey: "k",
				audio: new Uint8Array([1]),
				transcriptionOptions: { language_code },
				signal: new AbortController().signal,
			});
		expect(await call("quiet")).toEqual({ words: [], languageCode: null });
		await expect(call("en")).rejects.toThrow("decode failed");
		server.stop(true);
	});
});
