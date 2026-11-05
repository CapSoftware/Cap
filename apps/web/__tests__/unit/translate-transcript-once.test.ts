import type { Video } from "@cap/web-domain";
import { Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	sourceDigest,
	splitTranslationChunks,
	withSourceFingerprint,
} from "@/actions/videos/translation-vtt";

const ownerId = "owner";
const videoId = "public-video" as Video.VideoId;
const sourceKey = `${ownerId}/${videoId}/transcription.vtt`;

type StoredObject = { body: string; eTag: string };

const mocks = vi.hoisted(() => ({
	objects: new Map<string, { body: string; eTag: string }>(),
	nextETag: 0,
	provider: "s3" as "s3" | "googleDrive",
	conditionalWritesSupported: true,
	heldMarkerReads: 0,
	beforeMarkerRead: null as (() => void) | null,
	claimWrites: 0,
	storageReads: 0,
	generateText: vi.fn(),
	isRateLimited: vi.fn(async () => false),
}));

const store = (key: string, body: string) => {
	mocks.nextETag += 1;
	const stored: StoredObject = { body, eTag: `"etag-${mocks.nextETag}"` };
	mocks.objects.set(key, stored);
	return stored;
};

const writeFailure = (status: number) => ({
	$metadata: { httpStatusCode: status },
});

const markerReadsHeld: Array<() => void> = [];

const afterStorageRoundTrip = <A>(key: string, read: () => A) =>
	Effect.promise(
		() =>
			new Promise<void>((resolve) => {
				mocks.storageReads += 1;
				if (key.includes("/translation-status/") && mocks.heldMarkerReads > 0) {
					markerReadsHeld.push(resolve);
					if (markerReadsHeld.length === mocks.heldMarkerReads) {
						mocks.heldMarkerReads = 0;
						for (const release of markerReadsHeld.splice(0)) release();
					}
					return;
				}
				setTimeout(resolve, 0);
			}),
	).pipe(Effect.map(read));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => [
					{ video: { id: videoId, ownerId, bucketId: null } },
				],
			}),
		}),
	}),
}));
vi.mock("@cap/web-domain", () => ({
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: (effect: unknown) => effect,
	VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					provider: mocks.provider,
					getObject: (key: string) =>
						afterStorageRoundTrip(key, () =>
							Option.fromNullable(mocks.objects.get(key)?.body),
						),
					getObjectWithETag: (key: string) =>
						afterStorageRoundTrip(key, () => {
							const beforeRead = mocks.beforeMarkerRead;
							mocks.beforeMarkerRead = null;
							beforeRead?.();
							const stored = mocks.objects.get(key);
							return stored
								? Option.some({ body: stored.body, eTag: stored.eTag })
								: Option.none();
						}),
					putObject: (key: string, body: string) =>
						Effect.sync(() => {
							store(key, body);
						}),
					putObjectWithETag: (
						key: string,
						body: string,
						fields?: { ifMatch?: string; ifNoneMatch?: string },
					) =>
						Effect.suspend(() => {
							mocks.claimWrites += 1;
							const conditional =
								fields?.ifMatch !== undefined ||
								fields?.ifNoneMatch !== undefined;
							if (conditional && !mocks.conditionalWritesSupported) {
								return Effect.fail({ cause: writeFailure(501) });
							}
							const existing = mocks.objects.get(key);
							if (
								(fields?.ifNoneMatch === "*" && existing) ||
								(fields?.ifMatch !== undefined &&
									existing?.eTag !== fields.ifMatch)
							) {
								return Effect.fail({ cause: writeFailure(412) });
							}
							return Effect.succeed({ ETag: store(key, body).eTag });
						}),
					deleteObject: (key: string) =>
						Effect.sync(() => {
							mocks.objects.delete(key);
						}),
				},
				Option.none(),
			]),
	},
}));
vi.mock("@/lib/server", () => ({
	runPromise: (effect: Effect.Effect<unknown, unknown>) =>
		Effect.runPromiseExit(effect).then((exit) => {
			if (Exit.isFailure(exit)) throw exit;
			return exit.value;
		}),
	runPromiseExit: Effect.runPromiseExit,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => true }));
vi.mock("@/lib/ai/run", () => ({
	runWithAiProviders: (
		_role: string,
		run: (selection: unknown) => Promise<unknown>,
	) => run({ model: () => "model", supportsTemperature: false }),
}));
vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { TRANSLATE_TRANSCRIPT: "rl_translate_transcript" },
	isRateLimited: mocks.isRateLimited,
}));

const makeSource = (prefix: string) =>
	[
		"WEBVTT",
		...Array.from(
			{ length: 120 },
			(_, index) =>
				`${index + 1}\n00:00:${String(index % 60).padStart(2, "0")}.000 --> 00:00:${String(
					index % 60,
				).padStart(
					2,
					"0",
				)}.900\n${prefix} line ${index} with some words to translate`,
		),
	].join("\n\n");

const source = makeSource("Original");
const chunkCount = splitTranslationChunks(source)?.length ?? 0;

const markerKey = (vtt: string, language = "ja") =>
	`${ownerId}/${videoId}/translation-status/${language}.${sourceDigest(vtt).slice(0, 16)}.json`;

const markerKeys = () =>
	[...mocks.objects.keys()].filter((key) => key.endsWith(".json"));

const translatedChunk = (prompt: string) => {
	const chunk = prompt.split("VTT content to translate:\n\n")[1] ?? "";
	return chunk
		.split("\n\n")
		.map((block) =>
			block
				.split("\n")
				.map((line, index, lines) =>
					index > lines.findIndex((value) => value.includes("-->")) &&
					lines.some((value) => value.includes("-->"))
						? `ja ${line}`
						: line,
				)
				.join("\n"),
		)
		.join("\n\n");
};

const succeed = () =>
	mocks.generateText.mockImplementation(
		async ({ prompt }: { prompt: string }) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { text: translatedChunk(prompt), finishReason: "stop" };
		},
	);

const fail = () =>
	mocks.generateText.mockImplementation(async () => ({
		text: "WEBVTT\n\nnot a translation",
		finishReason: "stop",
	}));

const loadAction = async () => {
	vi.resetModules();
	return (await import("@/actions/videos/translate-transcript"))
		.translateTranscript;
};

beforeEach(() => {
	mocks.objects = new Map();
	mocks.nextETag = 0;
	mocks.claimWrites = 0;
	mocks.storageReads = 0;
	mocks.heldMarkerReads = 0;
	mocks.beforeMarkerRead = null;
	store(sourceKey, source);
	mocks.provider = "s3";
	mocks.conditionalWritesSupported = true;
	mocks.generateText.mockReset();
	mocks.isRateLimited.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("translateTranscript runs one translation pass per video and language", () => {
	it("shares one pass between concurrent requests for the same pair", async () => {
		expect(chunkCount).toBeGreaterThan(1);
		succeed();
		const translateTranscript = await loadAction();

		const results = await Promise.all(
			Array.from({ length: 20 }, () => translateTranscript(videoId, "ja")),
		);

		expect(mocks.generateText).toHaveBeenCalledTimes(chunkCount);
		expect(results.every((result) => result.success)).toBe(true);
		expect(new Set(results.map((result) => result.translatedVtt)).size).toBe(1);
		expect(results[0]?.translatedVtt).toContain("ja Original line 0");
		expect(mocks.isRateLimited).toHaveBeenCalledTimes(20);
	});

	it("lets only one instance claim a pair when several start together", async () => {
		succeed();
		const instances = [];
		for (let index = 0; index < 3; index++) {
			instances.push(await loadAction());
		}
		expect(new Set(instances).size).toBe(3);
		mocks.heldMarkerReads = instances.length;

		const results = await Promise.all(
			instances.map((translateTranscript) =>
				translateTranscript(videoId, "ja"),
			),
		);

		expect(mocks.generateText).toHaveBeenCalledTimes(chunkCount);
		expect(results.every((result) => result.success)).toBe(true);
		expect(new Set(results.map((result) => result.translatedVtt)).size).toBe(1);
	});

	it("serves the stored translation afterwards without another pass", async () => {
		succeed();
		const translateTranscript = await loadAction();
		const first = await translateTranscript(videoId, "ja");
		expect(
			mocks.objects.has(`${ownerId}/${videoId}/transcription.ja.vtt`),
		).toBe(true);
		mocks.generateText.mockClear();

		const fresh = await loadAction();
		const second = await fresh(videoId, "ja");

		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(second).toMatchObject({
			success: true,
			translatedVtt: first.translatedVtt,
		});
		expect(markerKeys()).toEqual([]);
	});

	it("renews its claim after every chunk", async () => {
		succeed();
		const translateTranscript = await loadAction();
		await translateTranscript(videoId, "ja");
		expect(mocks.claimWrites).toBe(chunkCount);
	});

	it("does not run the model again for a pair that just failed", async () => {
		fail();
		const translateTranscript = await loadAction();
		await expect(translateTranscript(videoId, "ja")).resolves.toMatchObject({
			success: false,
		});
		const calls = mocks.generateText.mock.calls.length;
		expect(calls).toBeGreaterThan(0);

		const repeats = await Promise.all(
			Array.from({ length: 5 }, () => translateTranscript(videoId, "ja")),
		);
		expect(repeats.every((result) => !result.success)).toBe(true);
		expect(mocks.generateText).toHaveBeenCalledTimes(calls);

		const otherInstance = await loadAction();
		await expect(otherInstance(videoId, "ja")).resolves.toMatchObject({
			success: false,
		});
		expect(mocks.generateText).toHaveBeenCalledTimes(calls);
	});

	it("retries a failed pair once the retry window has passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-04T10:00:00Z"));
		fail();
		const translateTranscript = await loadAction();
		await translateTranscript(videoId, "ja");
		const calls = mocks.generateText.mock.calls.length;

		vi.setSystemTime(new Date("2026-11-04T10:30:00Z"));
		succeed();
		await expect(translateTranscript(videoId, "ja")).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.generateText).toHaveBeenCalledTimes(calls + chunkCount);
	});

	it("keeps other languages and edited transcripts translatable after a failure", async () => {
		fail();
		const translateTranscript = await loadAction();
		await translateTranscript(videoId, "ja");
		const calls = mocks.generateText.mock.calls.length;
		const failedMarker = mocks.objects.get(markerKey(source))?.body;
		expect(failedMarker).toContain('"failed"');

		succeed();
		await expect(translateTranscript(videoId, "fr")).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.generateText).toHaveBeenCalledTimes(calls + chunkCount);

		const edited = makeSource("Edited");
		store(sourceKey, edited);
		await expect(translateTranscript(videoId, "ja")).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.generateText).toHaveBeenCalledTimes(calls + chunkCount * 2);
		expect(mocks.objects.get(markerKey(source))?.body).toBe(failedMarker);
		expect(mocks.objects.has(markerKey(edited))).toBe(false);
	});

	it("hands a request back while another instance is translating instead of starting another", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		succeed();
		const runningInstance = await loadAction();
		let releaseModel = () => {};
		const modelGate = new Promise<void>((resolve) => {
			releaseModel = resolve;
		});
		mocks.generateText.mockImplementationOnce(
			async ({ prompt }: { prompt: string }) => {
				await modelGate;
				return { text: translatedChunk(prompt), finishReason: "stop" };
			},
		);
		const running = runningInstance(videoId, "ja");
		await vi.advanceTimersByTimeAsync(10);
		expect(mocks.generateText).toHaveBeenCalledTimes(1);

		const waitingInstance = await loadAction();
		let waitingResult: unknown;
		void waitingInstance(videoId, "ja").then((result) => {
			waitingResult = result;
		});
		await vi.advanceTimersByTimeAsync(25_000);
		expect(waitingResult).toEqual({
			success: false,
			inProgress: true,
			message: "Translation in progress",
		});
		expect(mocks.generateText).toHaveBeenCalledTimes(1);

		releaseModel();
		await vi.advanceTimersByTimeAsync(10_000);
		const first = await running;
		const retry = waitingInstance(videoId, "ja");
		await vi.advanceTimersByTimeAsync(10);

		expect(mocks.generateText).toHaveBeenCalledTimes(chunkCount);
		expect(first.success).toBe(true);
		await expect(retry).resolves.toMatchObject({
			success: true,
			translatedVtt: first.translatedVtt,
		});
	});

	it("bounds the storage reads of a request waiting on another instance", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		store(
			markerKey(source),
			JSON.stringify({
				state: "pending",
				source: sourceDigest(source),
				at: Date.now(),
			}),
		);
		succeed();
		const translateTranscript = await loadAction();
		mocks.storageReads = 0;
		let result: unknown;
		void translateTranscript(videoId, "ja").then((value) => {
			result = value;
		});
		await vi.advanceTimersByTimeAsync(25_000);

		expect(result).toEqual({
			success: false,
			inProgress: true,
			message: "Translation in progress",
		});
		expect(mocks.storageReads).toBeLessThanOrEqual(12);
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("hands back a request that joins a pass already running in this instance", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		succeed();
		const translateTranscript = await loadAction();
		let releaseModel = () => {};
		const modelGate = new Promise<void>((resolve) => {
			releaseModel = resolve;
		});
		mocks.generateText.mockImplementationOnce(
			async ({ prompt }: { prompt: string }) => {
				await modelGate;
				return { text: translatedChunk(prompt), finishReason: "stop" };
			},
		);
		const running = translateTranscript(videoId, "ja");
		await vi.advanceTimersByTimeAsync(10);

		let joinedResult: unknown;
		void translateTranscript(videoId, "ja").then((result) => {
			joinedResult = result;
		});
		await vi.advanceTimersByTimeAsync(25_000);
		expect(joinedResult).toEqual({
			success: false,
			inProgress: true,
			message: "Translation in progress",
		});

		releaseModel();
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(running).resolves.toMatchObject({ success: true });
		expect(mocks.generateText).toHaveBeenCalledTimes(chunkCount);
	});

	it("takes over a pass whose claim has expired", async () => {
		store(
			markerKey(source),
			JSON.stringify({
				state: "pending",
				source: sourceDigest(source),
				at: Date.now() - 6 * 60 * 1000,
			}),
		);
		succeed();
		const translateTranscript = await loadAction();
		await expect(translateTranscript(videoId, "ja")).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.generateText).toHaveBeenCalledTimes(chunkCount);
		expect(markerKeys()).toEqual([]);
	});

	it("serves a translation stored by another instance just before its claim", async () => {
		const translated = translatedChunk(
			`VTT content to translate:\n\n${source}`,
		);
		const finishedElsewhere = withSourceFingerprint(source, translated);
		if (!finishedElsewhere) throw new Error("Missing stored translation");
		mocks.beforeMarkerRead = () => {
			store(`${ownerId}/${videoId}/transcription.ja.vtt`, finishedElsewhere);
		};
		succeed();
		const translateTranscript = await loadAction();

		await expect(translateTranscript(videoId, "ja")).resolves.toEqual({
			success: true,
			translatedVtt: translated,
			message: "Retrieved cached translation",
		});
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(markerKeys()).toEqual([]);
	});

	it("leaves an expired claim to a fresh request once it has waited too long", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
		store(
			markerKey(source),
			JSON.stringify({
				state: "pending",
				source: sourceDigest(source),
				at: Date.now() - 4 * 60 * 1000,
			}),
		);
		succeed();
		const waitingInstance = await loadAction();
		const waiting = waitingInstance(videoId, "ja");
		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

		await expect(waiting).resolves.toEqual({
			success: false,
			inProgress: true,
			message: "Translation in progress",
		});
		expect(mocks.generateText).not.toHaveBeenCalled();

		const freshRequest = await loadAction();
		const fresh = freshRequest(videoId, "ja");
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(fresh).resolves.toMatchObject({ success: true });
		expect(mocks.generateText).toHaveBeenCalledTimes(chunkCount);
	});

	it("still translates when the storage cannot record claims", async () => {
		mocks.conditionalWritesSupported = false;
		succeed();
		const translateTranscript = await loadAction();
		const results = await Promise.all(
			Array.from({ length: 5 }, () => translateTranscript(videoId, "ja")),
		);
		expect(results.every((result) => result.success)).toBe(true);
		expect(mocks.generateText).toHaveBeenCalledTimes(chunkCount);
		expect(markerKeys()).toEqual([]);
	});

	it("still translates when the storage provider is not S3", async () => {
		mocks.provider = "googleDrive";
		succeed();
		const translateTranscript = await loadAction();
		const results = await Promise.all(
			Array.from({ length: 5 }, () => translateTranscript(videoId, "ja")),
		);
		expect(results.every((result) => result.success)).toBe(true);
		expect(mocks.generateText).toHaveBeenCalledTimes(chunkCount);
		expect(markerKeys()).toEqual([]);
	});

	it("keeps the request limit check ahead of any model call", async () => {
		succeed();
		mocks.isRateLimited.mockResolvedValueOnce(true);
		const translateTranscript = await loadAction();
		await expect(translateTranscript(videoId, "ja")).resolves.toEqual({
			success: false,
			message: "Too many requests",
		});
		expect(mocks.generateText).not.toHaveBeenCalled();
	});
});
