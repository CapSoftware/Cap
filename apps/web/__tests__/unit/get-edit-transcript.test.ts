import { AsyncLocalStorage } from "node:async_hooks";
import { Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	decodeStorageVideo: vi.fn(),
	getAccessForVideo: vi.fn(),
	getCurrentUser: vi.fn(),
	runPromise: vi.fn(),
	start: vi.fn(),
}));

const schema = vi.hoisted(() => ({
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		updatedAt: "videos.updatedAt",
	},
	videoEdits: {
		videoId: "videoEdits.videoId",
		editSpec: "videoEdits.editSpec",
	},
}));

vi.mock("@cap/database", () => ({
	db: mocks.db,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@cap/database/schema", () => schema);

vi.mock("@cap/utils", () => ({
	userIsPro: () => true,
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: mocks.getAccessForVideo,
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => ({ conditions })),
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	})),
}));

vi.mock("workflow/api", () => ({
	start: mocks.start,
}));

vi.mock("@/lib/server", () => ({
	runPromise: mocks.runPromise,
}));

vi.mock("@/lib/edit-transcript-storage", () => ({
	decryptEditTranscriptObject: (value: string) => value,
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: mocks.decodeStorageVideo,
}));

vi.mock("@/workflows/transcribe", () => ({
	backfillEditTranscriptWorkflow: vi.fn(),
}));

vi.mock("server-only", () => ({}));

type PipeValue<T> = {
	pipe: (runner: (value: T) => unknown) => unknown;
};

function pipeValue<T>(value: T): PipeValue<T> {
	return {
		pipe: (runner) => runner(value),
	};
}

function createDatabase(
	video: Record<string, unknown>,
	edit?: Record<string, unknown>,
) {
	const currentVideo: Record<string, unknown> = {
		metadata: null,
		updatedAt: new Date("2026-07-30T00:00:00.000Z"),
		...video,
	};
	const transactionContext = new AsyncLocalStorage<boolean>();
	const lockedSelect = {
		select: vi.fn(),
		from: vi.fn(),
		where: vi.fn(),
		for: vi.fn(),
	};
	lockedSelect.select.mockReturnValue(lockedSelect);
	lockedSelect.from.mockReturnValue(lockedSelect);
	lockedSelect.where.mockReturnValue(lockedSelect);
	lockedSelect.for.mockImplementation(async () => [currentVideo]);

	const transactionUpdate = {
		set: vi.fn(),
		where: vi.fn(),
	};
	transactionUpdate.set.mockImplementation(
		(values: Record<string, unknown>) => {
			if (
				typeof values.metadata === "object" &&
				values.metadata !== null &&
				"values" in values.metadata &&
				Array.isArray(values.metadata.values)
			) {
				const encodedStatus = values.metadata.values.find(
					(value) =>
						typeof value === "string" && value.startsWith('{"status":'),
				);
				if (typeof encodedStatus === "string") {
					currentVideo.metadata = {
						editTranscriptBackfill: JSON.parse(encodedStatus),
					};
				}
			}
			return transactionUpdate;
		},
	);
	transactionUpdate.where.mockResolvedValue([{ affectedRows: 1 }]);

	const select = vi.fn(() => ({
		from: vi.fn((table: unknown) => ({
			where: vi
				.fn()
				.mockResolvedValue(
					table === schema.videoEdits ? (edit ? [edit] : []) : [currentVideo],
				),
		})),
	}));
	const update = vi.fn(() => ({
		set: vi.fn(() => ({
			where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]),
		})),
	}));

	let transactionTail = Promise.resolve();
	const transaction = vi.fn(
		<T>(
			callback: (
				tx: typeof lockedSelect & { update: typeof update },
			) => Promise<T>,
		): Promise<T> => {
			const result = transactionTail.then(() =>
				transactionContext.run(true, () =>
					callback({
						...lockedSelect,
						update: vi.fn(() => transactionUpdate),
					}),
				),
			);
			transactionTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	);

	return {
		database: { select, transaction, update },
		isTransactionActive: () => transactionContext.getStore() === true,
		lockedSelect,
	};
}

function createBucket(
	objects: Map<string, string>,
	isTransactionActive = () => false,
) {
	return {
		getObject: vi.fn((key: string) => {
			if (isTransactionActive()) {
				throw new Error("Storage read occurred inside a database transaction");
			}
			return pipeValue(Option.fromNullable(objects.get(key)));
		}),
	};
}

const video = {
	id: "video-1",
	ownerId: "user-1",
	duration: 25,
	source: { type: "webMP4" },
	isScreenshot: false,
	transcriptionStatus: "COMPLETE",
	updatedAt: new Date("2026-07-30T00:00:00.000Z"),
};

const TRANSCRIPT_KEY = "user-1/video-1/transcription.edit.v3.json";

function storedOriginalTranscript(durationMs = 25_000) {
	return JSON.stringify({
		version: 3,
		speechModelUsed: "universal-3-5-pro",
		durationMs,
		languageCode: "en",
		words: [
			{
				id: "word-0-1000-1500",
				text: "before",
				startMs: 1_000,
				endMs: 1_500,
				confidence: 0.9,
				speaker: null,
				channel: null,
			},
			{
				id: "word-1-6000-6500",
				text: "kept",
				startMs: 6_000,
				endMs: 6_500,
				confidence: 0.9,
				speaker: null,
				channel: null,
			},
			{
				id: "word-2-20000-20500",
				text: "after",
				startMs: 20_000,
				endMs: 20_500,
				confidence: 0.9,
				speaker: null,
				channel: null,
			},
		],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCurrentUser.mockResolvedValue({ id: "user-1" });
	mocks.runPromise.mockImplementation((value) => Promise.resolve(value));
	mocks.start.mockResolvedValue({ runId: "run-1" });
});

describe("requestEditTranscript", () => {
	it("serializes concurrent requests and starts one paid transcript job", async () => {
		const objects = new Map<string, string>();
		const { database, isTransactionActive, lockedSelect } =
			createDatabase(video);
		const bucket = createBucket(objects, isTransactionActive);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));
		mocks.start.mockImplementation(async () => {
			if (isTransactionActive()) {
				throw new Error(
					"Workflow start occurred inside a database transaction",
				);
			}
			return { runId: "run-1" };
		});

		const { requestEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const [first, second] = await Promise.all([
			requestEditTranscript("video-1" as never),
			requestEditTranscript("video-1" as never),
		]);

		expect(first).toEqual({ status: "processing" });
		expect(second).toEqual({ status: "processing" });
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(lockedSelect.for).toHaveBeenCalledTimes(2);
		expect(lockedSelect.for).toHaveBeenCalledWith("update");
		expect(mocks.start.mock.calls[0]?.[1]?.[0]).toMatchObject({
			videoId: "video-1",
			userId: "user-1",
			requestId: expect.any(String),
		});
	});

	it("returns a current cached sidecar without starting another job", async () => {
		const objects = new Map<string, string>([
			[
				TRANSCRIPT_KEY,
				JSON.stringify({
					version: 3,
					speechModelUsed: "universal-3-5-pro",
					durationMs: 25_000,
					languageCode: "en",
					words: [],
				}),
			],
		]);
		const bucket = createBucket(objects);
		const { database } = createDatabase(video);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { requestEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const response = await requestEditTranscript("video-1" as never);

		expect(response.status).toBe("ready");
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("remaps the stored original words through the video's edit spec", async () => {
		const objects = new Map<string, string>([
			[TRANSCRIPT_KEY, storedOriginalTranscript()],
		]);
		const bucket = createBucket(objects);
		const { database } = createDatabase(
			{ ...video, duration: 10 },
			{
				editSpec: {
					version: 1,
					sourceDuration: 25,
					keepRanges: [{ start: 5, end: 15 }],
				},
			},
		);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { requestEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const response = await requestEditTranscript("video-1" as never);

		if (response.status !== "ready") {
			throw new Error(`Expected a ready transcript, got ${response.status}`);
		}
		expect(response.transcript.durationMs).toBe(10_000);
		expect(
			response.transcript.words.map((word) => [
				word.id,
				word.startMs,
				word.endMs,
			]),
		).toEqual([["word-1-6000-6500", 1_000, 1_500]]);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("does not expose workflow startup errors to the client", async () => {
		const bucket = createBucket(new Map());
		const { database } = createDatabase(video);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));
		mocks.start.mockRejectedValue(
			new Error("provider account and request identifiers"),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const { requestEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const response = await requestEditTranscript("video-1" as never);

		expect(response).toEqual({
			status: "error",
			message: "Transcript preparation could not start. Try again.",
		});
		expect(JSON.stringify(response)).not.toContain("provider account");
		consoleError.mockRestore();
	});
});

describe("getEditTranscript", () => {
	it("remaps stored words instead of reporting them as stale", async () => {
		const objects = new Map<string, string>([
			[TRANSCRIPT_KEY, storedOriginalTranscript()],
		]);
		const bucket = createBucket(objects);
		const { database } = createDatabase(
			{ ...video, duration: 10 },
			{
				editSpec: {
					version: 1,
					sourceDuration: 25,
					keepRanges: [{ start: 5, end: 15 }],
				},
			},
		);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { getEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);
		const response = await getEditTranscript("video-1" as never);

		if (response.status !== "ready") {
			throw new Error(`Expected a ready transcript, got ${response.status}`);
		}
		expect(response.transcript.words.map((word) => word.text)).toEqual([
			"kept",
		]);
	});

	it("reports missing when the sidecar no longer matches the original media", async () => {
		const objects = new Map<string, string>([
			[TRANSCRIPT_KEY, storedOriginalTranscript(18_000)],
		]);
		const bucket = createBucket(objects);
		const { database } = createDatabase(
			{ ...video, duration: 10 },
			{
				editSpec: {
					version: 1,
					sourceDuration: 25,
					keepRanges: [{ start: 5, end: 15 }],
				},
			},
		);
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { getEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);

		expect(await getEditTranscript("video-1" as never)).toEqual({
			status: "missing",
		});
	});

	it("reports only a generic message for a failed backfill", async () => {
		const bucket = createBucket(new Map());
		const { database } = createDatabase({
			...video,
			metadata: {
				editTranscriptBackfill: {
					status: "error",
					requestId: "request-1",
					requestedAt: "2026-07-30T00:00:00.000Z",
					message: "private provider detail",
				},
			},
		});
		mocks.db.mockReturnValue(database);
		mocks.getAccessForVideo.mockReturnValue(pipeValue([bucket]));

		const { getEditTranscript } = await import(
			"@/actions/videos/get-edit-transcript"
		);

		expect(await getEditTranscript("video-1" as never)).toEqual({
			status: "error",
			message: "Transcript preparation failed. Try again.",
		});
	});
});
