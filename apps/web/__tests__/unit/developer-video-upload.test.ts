import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
	fake: null as null | {
		db: unknown;
		rows: (table: object) => Record<string, unknown>[];
		seed: (
			table: object,
			row: Record<string, unknown>,
		) => Record<string, unknown>;
		reset: () => void;
	},
	ids: 0,
	objects: new Map<string, number>(),
	presigned: [] as {
		key: string;
		contentLength: number;
		contentType?: string;
	}[],
	mediaServer: true,
	probe: null as null | {
		duration: number;
		width: number;
		height: number;
		fps: number;
	},
	probedUrls: [] as string[],
	onProbe: null as null | (() => void),
	started: [] as { videoId: string; encodeId: string }[],
	startFails: false,
	selfContained: true,
	sniffedUrls: [] as string[],
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const { createFakeDatabase } = await import("./developer-transcript-fake-db");
	const fake = createFakeDatabase(
		new Map<object, () => Record<string, unknown>>([
			[
				schema.developerVideos,
				() => ({
					externalUserId: null,
					name: "Untitled",
					duration: null,
					width: null,
					height: null,
					fps: null,
					status: "uploading",
					playbackId: null,
					maxResolutionTier: "1080p",
					renditions: null,
					storedBytes: null,
					errorReason: null,
					processing: null,
					deletedAt: null,
					filesDeletedAt: null,
				}),
			],
		]),
	);
	context.fake = fake;
	return { db: () => fake.db };
});

vi.mock("@cap/database/helpers", () => ({
	nanoId: () => {
		context.ids += 1;
		return `generated-${context.ids}`;
	},
	nanoIdLength: 15,
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true", NEXT_PUBLIC_WEB_URL: "https://web" },
	serverEnv: () => ({ WEB_URL: "https://web" }),
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {},
}));
vi.mock("@/lib/server", () => ({ runPromise: async () => undefined }));
vi.mock("@/lib/developer-video-storage", () => ({}));
vi.mock("workflow/api", () => ({
	start: async (
		_workflow: unknown,
		[input]: [{ videoId: string; encodeId: string }],
	) => {
		if (context.startFails) throw new Error("workflow unavailable");
		context.started.push(input);
	},
}));
vi.mock("@/workflows/process-developer-video", () => ({
	processDeveloperVideoWorkflow: "workflow",
}));

vi.mock("@/lib/infra-storage", async () => {
	const schema = await import("@cap/database/schema");
	const { billableVideo, storageUsage } = await import(
		"@/lib/developer-pricing"
	);
	return {
		getAppStorageUsage: async (
			appId: string,
			newVideo?: Parameters<typeof storageUsage>[0][number]["video"],
			_executor?: unknown,
			options: { includeProcessing?: boolean; excludeVideoId?: string } = {},
		) => {
			const entries = (context.fake?.rows(schema.developerVideos) ?? [])
				.filter(
					(row) =>
						row.appId === appId &&
						!row.deletedAt &&
						row.duration !== null &&
						row.id !== options.excludeVideoId,
				)
				.map((row) => ({
					video: billableVideo({
						duration: row.duration as number,
						width: row.width as number | null,
						height: row.height as number | null,
						status: row.status as string,
						maxResolutionTier: row.maxResolutionTier as string | null,
						includeProcessing: options.includeProcessing,
					}),
					count: 1,
				}));
			if (newVideo) entries.push({ video: newVideo, count: 1 });
			return storageUsage(entries);
		},
	};
});

vi.mock("@/lib/developer-transcript-storage", () => ({
	presignDeveloperUpload: async (
		key: string,
		contentLength: number,
		contentType?: string,
	) => {
		context.presigned.push({ key, contentLength, contentType });
		return `https://storage.example/${key}`;
	},
	developerObjectSize: async (key: string) => context.objects.get(key) ?? null,
	developerObjectUrl: async (key: string) => `https://internal.example/${key}`,
	copyDeveloperObject: async (from: string, to: string) => {
		const size = context.objects.get(from);
		if (size === undefined) throw new Error("copy source missing");
		context.objects.set(to, size);
	},
	deleteDeveloperObjects: async (keys: string[]) => {
		for (const key of keys) context.objects.delete(key);
	},
}));

vi.mock("@/lib/media-container", () => ({
	urlIsSelfContainedMedia: async (url: string) => {
		context.sniffedUrls.push(url);
		return context.selfContained;
	},
}));

vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => context.mediaServer,
	probeVideoViaMediaServer: async (url: string) => {
		context.probedUrls.push(url);
		context.onProbe?.();
		if (!context.probe) throw new Error("probe unavailable");
		return context.probe;
	},
}));

import {
	developerCreditAccounts,
	developerCreditTransactions,
	developerTranscripts,
	developerVideos,
} from "@cap/database/schema";
import {
	completeDeveloperVideoUpload,
	createDeveloperVideoUpload,
	developerVideoContentType,
	developerVideoIdForIdempotencyKey,
	developerVideoRecordedSeconds,
	developerVideoUploadKey,
} from "@/lib/developer-video-upload";

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};
const account = () => fake().rows(developerCreditAccounts)[0];
const ledger = () => fake().rows(developerCreditTransactions);
const videos = () => fake().rows(developerVideos);
const setBalance = (value: number) => {
	const current = account();
	if (current) current.balanceMicroCredits = value;
};

const UPLOAD_KEY = "developer/_uploads/app-1/v-generated-1";
const INITIAL_KEY = "developer/app-1/generated-1/video";
const STORED_PREFIX = "developer/app-1/generated-1/video-";
const storedKey = () => String(videos()[0]?.s3Key);
const storedCopies = () =>
	[...context.objects.keys()].filter((key) => key.startsWith(STORED_PREFIX));
const START = Date.parse("2026-11-11T10:05:00.000Z");
const FOUR_K = { duration: 7200, width: 3840, height: 2160, fps: 30 };
const CAPPED_4K_ADMISSION = 2_380;
const UNCAPPED_4K_ADMISSION = 7_840;

const create = (overrides: Record<string, unknown> = {}) =>
	createDeveloperVideoUpload("app-1", {
		fileName: "demo.mov",
		contentLength: 1_000_000,
		...overrides,
	});

const createAndUpload = async (bytes = 1_000_000) => {
	const created = await create();
	if (!created.ok) throw new Error("create failed");
	context.objects.set(UPLOAD_KEY, bytes);
	return created.video.id;
};

const holdTranscript = (reservedMicroCredits: number) =>
	fake().seed(developerTranscripts, {
		id: "tr-held",
		appId: "app-1",
		status: "processing",
		deletedAt: null,
		reservedMicroCredits,
	});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(START);
	fake().reset();
	context.ids = 0;
	context.objects = new Map();
	context.presigned = [];
	context.mediaServer = true;
	context.probe = { duration: 120, width: 1920, height: 1080, fps: 30 };
	context.probedUrls = [];
	context.onProbe = null;
	context.started = [];
	context.startFails = false;
	context.selfContained = true;
	context.sniffedUrls = [];
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: 1_000_000,
	});
});

afterAll(() => {
	vi.useRealTimers();
});

describe("developer video recorded length", () => {
	const recorded = developerVideoRecordedSeconds;

	it("uses the measured length", () => {
		expect(
			recorded({
				measuredSeconds: 120,
				claimedSeconds: 5,
				totalBytes: 10_000_000_000,
			}),
		).toBe(120);
	});

	it("uses the larger of the claim and the size floor when it cannot measure", () => {
		expect(
			recorded({
				measuredSeconds: null,
				claimedSeconds: 10,
				totalBytes: 250_000_000,
			}),
		).toBe(100);
		expect(
			recorded({
				measuredSeconds: null,
				claimedSeconds: 600,
				totalBytes: 6_000_000,
			}),
		).toBe(600);
	});

	it("bounds a claim the file is too small to hold", () => {
		expect(
			recorded({
				measuredSeconds: null,
				claimedSeconds: 4 * 3600,
				totalBytes: 30_000,
			}),
		).toBe(30);
		expect(
			recorded({
				measuredSeconds: null,
				claimedSeconds: 600,
				totalBytes: 1_000,
			}),
		).toBe(1);
	});

	it("never bounds a measured length by the file size", () => {
		expect(
			recorded({ measuredSeconds: 600, claimedSeconds: null, totalBytes: 1 }),
		).toBe(600);
	});

	it("caps the length at four hours", () => {
		expect(
			recorded({
				measuredSeconds: 10 * 3600,
				claimedSeconds: null,
				totalBytes: 1,
			}),
		).toBe(4 * 3600);
	});
});

describe("developer video upload target", () => {
	it("signs the pending key with the size and a type from the file name", async () => {
		const created = await create();
		if (!created.ok) throw new Error("create failed");

		expect(context.presigned).toEqual([
			{
				key: UPLOAD_KEY,
				contentLength: 1_000_000,
				contentType: "video/quicktime",
			},
		]);
		expect(created.upload.headers).toEqual({
			"Content-Length": "1000000",
			"Content-Type": "video/quicktime",
		});
		expect(developerVideoUploadKey("app-1", "generated-1")).toBe(UPLOAD_KEY);
		expect(videos()[0]).toMatchObject({ s3Key: INITIAL_KEY, duration: null });
	});

	it("creates the row with a playback id, the default resolution cap and no charge", async () => {
		const created = await create();
		if (!created.ok) throw new Error("create failed");

		expect(videos()[0]).toMatchObject({
			status: "uploading",
			maxResolutionTier: "1080p",
			playbackId: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/),
		});
		expect(created.video.playbackId).toBe(videos()[0]?.playbackId);
		expect(ledger()).toHaveLength(0);
		expect(account()?.balanceMicroCredits).toBe(1_000_000);
	});

	it("only ever stores an allowed video type", () => {
		expect(developerVideoContentType("a.MP4")).toBe("video/mp4");
		expect(developerVideoContentType("a.webm")).toBe("video/webm");
		expect(developerVideoContentType("a.html")).toBe("video/mp4");
		expect(developerVideoContentType("noextension")).toBe("video/mp4");
	});

	it("refuses with 402 and what to do when the app has no credit", async () => {
		setBalance(0);
		expect(await create()).toMatchObject({
			ok: false,
			status: 402,
			code: "insufficient_credits",
			message: "This app has no credit. Add credits to start uploading.",
			shortfallMicroCredits: 1,
		});
		expect(videos()).toHaveLength(0);
	});

	it("refuses with the amount to add when the balance does not cover what is stored", async () => {
		fake().seed(developerVideos, {
			id: "stored-1",
			appId: "app-1",
			status: "ready",
			duration: 7200,
			width: 1920,
			height: 1080,
		});
		setBalance(1_000);
		expect(await create()).toMatchObject({
			ok: false,
			status: 402,
			code: "insufficient_credits",
			message:
				"Uploading needs $0.02380 of credit, enough for 7 days of storage for everything this app stores. The balance is $0.01, so add at least $0.01380.",
			shortfallMicroCredits: 1_380,
		});
	});

	it("does not count credit held for a running transcript", async () => {
		fake().seed(developerVideos, {
			id: "stored-1",
			appId: "app-1",
			status: "ready",
			duration: 7200,
			width: 1920,
			height: 1080,
		});
		setBalance(5_000);
		expect((await create({ idempotencyKey: "key-one-00000001" })).ok).toBe(
			true,
		);
		holdTranscript(3_000);
		expect(await create({ idempotencyKey: "key-two-00000002" })).toMatchObject({
			ok: false,
			status: 402,
			shortfallMicroCredits: 380,
		});
	});

	it("reuses the video for a repeated idempotency key", async () => {
		const first = await create({ idempotencyKey: "same-key-00000001" });
		const second = await create({ idempotencyKey: "same-key-00000001" });
		if (!first.ok || !second.ok) throw new Error("create failed");

		expect(second.video).toEqual(first.video);
		expect(videos()).toHaveLength(1);
		expect(first.video.id).toBe(
			developerVideoIdForIdempotencyKey("app-1", "same-key-00000001"),
		);
	});
});

describe("completing a developer video upload", () => {
	it("records a private copy of the upload, starts processing once and charges nothing", async () => {
		const id = await createAndUpload();
		const playbackId = videos()[0]?.playbackId;

		const result = await completeDeveloperVideoUpload("app-1", id, {});

		expect(result).toEqual({
			ok: true,
			video: {
				id,
				appId: "app-1",
				name: "demo",
				status: "processing",
				playbackId,
				durationSeconds: 120,
				width: 1920,
				height: 1080,
				fps: 30,
			},
		});
		expect(storedKey().startsWith(STORED_PREFIX)).toBe(true);
		expect(context.probedUrls).toEqual([
			`https://internal.example/${storedKey()}`,
		]);
		expect([...context.objects.keys()]).toEqual([storedKey()]);
		expect(context.started).toEqual([
			{
				videoId: id,
				encodeId: (videos()[0]?.processing as { encodeId: string }).encodeId,
			},
		]);
		expect(ledger()).toHaveLength(0);
		expect(account()?.balanceMicroCredits).toBe(1_000_000);
	});

	it("answers a repeated completion without starting again", async () => {
		const id = await createAndUpload();
		const first = await completeDeveloperVideoUpload("app-1", id, {});
		context.objects.set(UPLOAD_KEY, 5);
		const again = await completeDeveloperVideoUpload("app-1", id, {
			durationSeconds: 9_000,
		});

		expect(again).toEqual(first);
		expect(context.started).toHaveLength(1);
		expect(videos()[0]?.duration).toBe(120);
	});

	it("records one copy and starts once when completions overlap", async () => {
		const id = await createAndUpload();
		const results = await Promise.all([
			completeDeveloperVideoUpload("app-1", id, {}),
			completeDeveloperVideoUpload("app-1", id, {}),
			completeDeveloperVideoUpload("app-1", id, {}),
		]);

		expect(results.filter((result) => result.ok).length).toBeGreaterThan(0);
		for (const result of results) {
			if (!result.ok) {
				expect(result).toMatchObject({
					status: 409,
					code: "completion_in_progress",
				});
			}
		}
		expect(context.started).toHaveLength(1);
		expect(storedCopies()).toEqual([storedKey()]);
		expect(ledger()).toHaveLength(0);
		expect(account()?.balanceMicroCredits).toBe(1_000_000);
		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: true,
			video: { status: "processing", durationSeconds: 120 },
		});
		expect(context.started).toHaveLength(1);
	});

	it("keeps the length of the copy it recorded when overlapping completions claim different lengths", async () => {
		context.probe = null;
		const id = await createAndUpload(1_000_000);
		const results = await Promise.all([
			completeDeveloperVideoUpload("app-1", id, { durationSeconds: 60 }),
			completeDeveloperVideoUpload("app-1", id, { durationSeconds: 120 }),
		]);

		const recorded = videos()[0]?.duration as number;
		expect([60, 120]).toContain(recorded);
		for (const result of results) {
			if (result.ok) {
				expect(result.video.durationSeconds).toBe(recorded);
			} else {
				expect(result.code).toBe("completion_in_progress");
			}
		}
		expect(results.some((result) => result.ok)).toBe(true);
		expect(context.started).toHaveLength(1);
		expect(storedCopies()).toEqual([storedKey()]);
		expect(ledger()).toHaveLength(0);
	});

	it("answers busy while another request holds the completion and takes over once that one is stale", async () => {
		const id = await createAndUpload();
		const row = videos()[0];
		if (!row) throw new Error("no video");
		Object.assign(row, {
			status: "processing",
			processing: { encodeId: "abandoned", startedAt: START },
			updatedAt: new Date(START),
		});

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 409,
			code: "completion_in_progress",
		});
		expect(context.started).toHaveLength(0);
		expect(context.objects.has(UPLOAD_KEY)).toBe(true);
		expect(storedCopies()).toEqual([]);

		vi.setSystemTime(START + 16 * 60 * 1000);
		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: true,
			video: { status: "processing" },
		});
		expect(context.started).toHaveLength(1);
		expect(context.started[0]?.encodeId).not.toBe("abandoned");
	});

	it("leaves the video recorded and ready to be picked up when processing cannot start", async () => {
		context.startFails = true;
		const id = await createAndUpload();

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: true,
			video: { status: "uploading", durationSeconds: 120 },
		});
		expect(videos()[0]).toMatchObject({ processing: null, duration: 120 });
		expect([...context.objects.keys()]).toEqual([storedKey()]);
	});

	it("cannot be changed through the upload URL once completed", async () => {
		const id = await createAndUpload();
		await completeDeveloperVideoUpload("app-1", id, {});
		const kept = storedKey();
		context.objects.set(UPLOAD_KEY, 9_000_000);

		await completeDeveloperVideoUpload("app-1", id, {});

		expect(storedKey()).toBe(kept);
		expect(context.objects.get(kept)).toBe(1_000_000);
		expect(kept).not.toBe(developerVideoUploadKey("app-1", id));
	});

	it("falls back to the claim with a size floor when it cannot measure", async () => {
		context.mediaServer = false;
		const id = await createAndUpload(250_000_000);

		const result = await completeDeveloperVideoUpload("app-1", id, {
			durationSeconds: 10,
			width: 1280.4,
			height: 720,
			fps: 29.97,
		});

		expect(result).toMatchObject({
			ok: true,
			video: { durationSeconds: 100, width: 1280, height: 720, fps: 30 },
		});
		expect(context.probedUrls).toEqual([]);
	});

	it("needs a length from somewhere and leaves the upload in place to retry", async () => {
		context.mediaServer = false;
		const id = await createAndUpload();

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 400,
			code: "duration_required",
		});
		expect([...context.objects.keys()]).toEqual([UPLOAD_KEY]);
		expect(videos()[0]).toMatchObject({ status: "uploading", duration: null });
	});

	it("stores nothing when the file can be neither measured nor trusted", async () => {
		context.probe = null;
		const id = await createAndUpload();

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			code: "duration_required",
		});
		expect([...context.objects.keys()]).toEqual([UPLOAD_KEY]);
		expect(context.started).toHaveLength(0);
	});

	it("refuses to complete before the file exists", async () => {
		const created = await create();
		if (!created.ok) throw new Error("create failed");

		expect(
			await completeDeveloperVideoUpload("app-1", created.video.id, {}),
		).toMatchObject({ ok: false, status: 409, code: "upload_not_found" });
	});

	it("refuses a file that is not self-contained media before it is probed, and removes it", async () => {
		context.selfContained = false;
		const id = await createAndUpload();

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 400,
			code: "unsupported_format",
		});
		expect(context.sniffedUrls).toHaveLength(1);
		expect(context.probedUrls).toEqual([]);
		expect(context.started).toEqual([]);
		expect(context.objects.size).toBe(0);
		expect(videos()[0]?.duration ?? null).toBeNull();
	});

	it("checks the stored copy before every probe", async () => {
		const id = await createAndUpload();
		await completeDeveloperVideoUpload("app-1", id, {});

		expect(context.sniffedUrls).toHaveLength(1);
		expect(context.probedUrls).toEqual(context.sniffedUrls);
	});

	it("rejects and removes an upload over 5 GB", async () => {
		const id = await createAndUpload(5 * 1024 * 1024 * 1024 + 1);

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 400,
			code: "file_too_large",
		});
		expect(context.objects.size).toBe(0);
	});

	it("records nothing for a video deleted while it was completing", async () => {
		const id = await createAndUpload();
		context.onProbe = () => {
			const row = videos()[0];
			if (row) row.deletedAt = new Date();
		};

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(videos()[0]).toMatchObject({ duration: null, s3Key: INITIAL_KEY });
		expect(storedCopies()).toEqual([]);
		expect(context.started).toHaveLength(0);
	});

	it("does not complete another app's video", async () => {
		const id = await createAndUpload();
		expect(await completeDeveloperVideoUpload("app-2", id, {})).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(videos()[0]?.duration).toBeNull();
	});
});

describe("admission when the upload is recorded", () => {
	it("refuses a short balance with the amount to add, keeps the upload, and completes after a top-up", async () => {
		const id = await createAndUpload();
		context.probe = { duration: 7200, width: 1920, height: 1080, fps: 30 };
		setBalance(1_000);

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 402,
			code: "insufficient_credits",
			message:
				"Uploading needs $0.02380 of credit, enough for 7 days of storage for everything this app stores. The balance is $0.01, so add at least $0.01380.",
			shortfallMicroCredits: CAPPED_4K_ADMISSION - 1_000,
		});
		expect(videos()[0]).toMatchObject({
			status: "uploading",
			duration: null,
			processing: null,
			s3Key: INITIAL_KEY,
		});
		expect([...context.objects.keys()]).toEqual([UPLOAD_KEY]);
		expect(context.started).toHaveLength(0);

		setBalance(CAPPED_4K_ADMISSION);
		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: true,
			video: { status: "processing", durationSeconds: 7200 },
		});
		expect(context.started).toHaveLength(1);
		expect(account()?.balanceMicroCredits).toBe(CAPPED_4K_ADMISSION);
	});

	it("admits a 4K source at the capped price", async () => {
		const id = await createAndUpload();
		context.probe = FOUR_K;
		setBalance(CAPPED_4K_ADMISSION);

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: true,
			video: { width: 3840, height: 2160, durationSeconds: 7200 },
		});
		expect(videos()[0]).toMatchObject({ maxResolutionTier: "1080p" });
	});

	it("prices a 4K source at 4K when the video is not capped", async () => {
		const id = await createAndUpload();
		const row = videos()[0];
		if (row) row.maxResolutionTier = "2160p";
		context.probe = FOUR_K;
		setBalance(UNCAPPED_4K_ADMISSION - 1);

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 402,
			shortfallMicroCredits: 1,
		});

		setBalance(UNCAPPED_4K_ADMISSION);
		expect((await completeDeveloperVideoUpload("app-1", id, {})).ok).toBe(true);
	});

	it("refuses again under the lock when the balance dropped after the first check", async () => {
		const id = await createAndUpload();
		context.probe = { duration: 7200, width: 1920, height: 1080, fps: 30 };
		setBalance(CAPPED_4K_ADMISSION);
		const row = videos()[0];
		if (!row) throw new Error("no video");
		let status = row.status;
		Object.defineProperty(row, "status", {
			get: () => status,
			set: (value: string) => {
				status = value;
				if (value === "processing") setBalance(CAPPED_4K_ADMISSION - 1);
			},
			enumerable: true,
			configurable: true,
		});

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 402,
			shortfallMicroCredits: 1,
		});
		expect(videos()[0]).toMatchObject({
			status: "uploading",
			duration: null,
			processing: null,
		});
		expect([...context.objects.keys()]).toEqual([UPLOAD_KEY]);
		expect(context.started).toHaveLength(0);
	});

	it("leaves credit held for a running transcript out of the balance it admits on", async () => {
		const id = await createAndUpload();
		context.probe = { duration: 7200, width: 1920, height: 1080, fps: 30 };
		setBalance(CAPPED_4K_ADMISSION + 3_000);
		const held = holdTranscript(3_001);

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 402,
			shortfallMicroCredits: 1,
		});

		held.status = "complete";
		expect((await completeDeveloperVideoUpload("app-1", id, {})).ok).toBe(true);
	});

	it("refuses an app that is out of credit for storage", async () => {
		const id = await createAndUpload();
		setBalance(50);
		fake().seed(developerCreditTransactions, {
			id: "charge-1",
			accountId: "account-1",
			type: "storage_daily",
			amountMicroCredits: 0,
			balanceAfterMicroCredits: 50,
			referenceId: "2026-11-10",
			referenceType: "storage_day",
			metadata: {
				snapshotDate: "2026-11-10",
				owedMicroCredits: 400,
				chargedMicroCredits: 0,
				shortSince: "2026-11-10T00:00:00.000Z",
			},
		});

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 402,
			code: "out_of_credit",
		});
		expect(await create({ idempotencyKey: "blocked-key-00001" })).toMatchObject(
			{ ok: false, status: 402, code: "out_of_credit" },
		);
	});
});

describe("developer video responses", () => {
	it("returns named fields only, never the stored row", async () => {
		const id = await createAndUpload();
		const row = videos()[0];
		if (row) {
			Object.assign(row, {
				metadata: { secret: "internal-note" },
				renditions: [{ key: "developer/app-1/x/720p.m3u8" }],
				errorReason: "internal reason",
				storedBytes: 123_456_789,
			});
		}

		const first = await completeDeveloperVideoUpload("app-1", id, {});
		const repeat = await completeDeveloperVideoUpload("app-1", id, {});

		for (const result of [first, repeat]) {
			if (!result.ok) throw new Error("completion failed");
			expect(Object.keys(result).sort()).toEqual(["ok", "video"]);
			expect(Object.keys(result.video).sort()).toEqual([
				"appId",
				"durationSeconds",
				"fps",
				"height",
				"id",
				"name",
				"playbackId",
				"status",
				"width",
			]);
			const serialized = JSON.stringify(result);
			for (const internal of [
				"s3Key",
				"developer/",
				"_uploads",
				"internal-note",
				"internal reason",
				"123456789",
				"filesDeletedAt",
				'"processing":',
				"encodeId",
				"renditions",
				"errorReason",
				"storedBytes",
				"maxResolutionTier",
				"deletedAt",
				"externalUserId",
			]) {
				expect(serialized).not.toContain(internal);
			}
		}

		const created = await create({ idempotencyKey: "another-key-0001" });
		if (!created.ok) throw new Error("create failed");
		expect(Object.keys(created.video).sort()).toEqual([
			"appId",
			"id",
			"name",
			"playbackId",
		]);
		expect(JSON.stringify(created.video)).not.toContain("developer/");
	});
});
