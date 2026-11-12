import { beforeEach, describe, expect, it, vi } from "vitest";

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
					deletedAt: null,
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
	developerVideoBillingSeconds,
	developerVideoContentType,
	developerVideoIdForIdempotencyKey,
	developerVideoUploadKey,
	developerVideoUploadMicroCredits,
} from "@/lib/developer-video-upload";

const fake = () => {
	if (!context.fake) throw new Error("Fake database is not ready");
	return context.fake;
};
const account = () => fake().rows(developerCreditAccounts)[0];
const ledger = () => fake().rows(developerCreditTransactions);
const videos = () => fake().rows(developerVideos);

const UPLOAD_KEY = "developer/_uploads/app-1/v-generated-1";
const INITIAL_KEY = "developer/app-1/generated-1/video";
const STORED_PREFIX = "developer/app-1/generated-1/video-";
const storedKey = () => String(videos()[0]?.s3Key);

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

beforeEach(() => {
	fake().reset();
	context.ids = 0;
	context.objects = new Map();
	context.presigned = [];
	context.mediaServer = true;
	context.probe = { duration: 120, width: 1920, height: 1080, fps: 30 };
	context.probedUrls = [];
	context.onProbe = null;
	fake().seed(developerCreditAccounts, {
		id: "account-1",
		appId: "app-1",
		balanceMicroCredits: 1_000_000,
	});
});

const billed = (input: {
	measuredSeconds: number | null;
	claimedSeconds: number | null;
	totalBytes: number;
}) => {
	const billingSeconds = developerVideoBillingSeconds(input);
	return {
		billingSeconds,
		microCredits: developerVideoUploadMicroCredits(billingSeconds),
	};
};

describe("developer video billing", () => {
	it("bills the measured length at the upload rate", () => {
		expect(
			billed({
				measuredSeconds: 120,
				claimedSeconds: 5,
				totalBytes: 10_000_000_000,
			}),
		).toEqual({ billingSeconds: 120, microCredits: 10_000 });
	});

	it("uses the larger of the claim and the size floor when it cannot measure", () => {
		expect(
			billed({
				measuredSeconds: null,
				claimedSeconds: 10,
				totalBytes: 250_000_000,
			}),
		).toEqual({ billingSeconds: 100, microCredits: 8_333 });
		expect(
			billed({
				measuredSeconds: null,
				claimedSeconds: 600,
				totalBytes: 6_000_000,
			}).billingSeconds,
		).toBe(600);
	});

	it("bounds a claim the file is too small to hold", () => {
		expect(
			billed({
				measuredSeconds: null,
				claimedSeconds: 4 * 3600,
				totalBytes: 30_000,
			}),
		).toEqual({ billingSeconds: 30, microCredits: 2_500 });
		expect(
			billed({
				measuredSeconds: null,
				claimedSeconds: 600,
				totalBytes: 1_000,
			}).billingSeconds,
		).toBe(1);
	});

	it("never bounds a measured length by the file size", () => {
		expect(
			billed({
				measuredSeconds: 600,
				claimedSeconds: null,
				totalBytes: 1_000,
			}).billingSeconds,
		).toBe(600);
	});

	it("caps the billed length at four hours", () => {
		expect(
			billed({
				measuredSeconds: 10 * 3600,
				claimedSeconds: null,
				totalBytes: 1,
			}),
		).toEqual({ billingSeconds: 4 * 3600, microCredits: 1_200_000 });
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
		expect(videos()[0]).toMatchObject({
			id: "generated-1",
			name: "demo",
			s3Key: INITIAL_KEY,
			duration: null,
		});
		expect(UPLOAD_KEY).toBe(developerVideoUploadKey("app-1", "generated-1"));
		expect(UPLOAD_KEY).not.toBe(INITIAL_KEY);
	});

	it("only ever stores an allowed video type", () => {
		expect(developerVideoContentType("a.mp4")).toBe("video/mp4");
		expect(developerVideoContentType("A.WEBM")).toBe("video/webm");
		expect(developerVideoContentType("a.mkv")).toBe("video/x-matroska");
		expect(developerVideoContentType("page.html")).toBe("video/mp4");
		expect(developerVideoContentType("script.svg")).toBe("video/mp4");
		expect(developerVideoContentType("noextension")).toBe("video/mp4");
	});

	it("answers 402 below the minimum balance", async () => {
		const current = account();
		if (current) current.balanceMicroCredits = 4_999;
		expect(await create()).toMatchObject({ ok: false, status: 402 });
		expect(videos()).toHaveLength(0);
		expect(context.presigned).toHaveLength(0);
	});

	it.each([0, -5, 1.5, 5 * 1024 * 1024 * 1024 + 1])(
		"rejects the size %s",
		async (contentLength) => {
			expect(await create({ contentLength })).toMatchObject({
				ok: false,
				status: 400,
				code: "invalid_content_length",
			});
		},
	);

	it("reuses the video for a repeated idempotency key", async () => {
		const first = await create({ idempotencyKey: "upload-key-0001" });
		const second = await create({ idempotencyKey: "upload-key-0001" });
		expect(first.ok && second.ok && first.video.id).toBe(
			second.ok && second.video.id,
		);
		expect(videos()).toHaveLength(1);
		expect(
			developerVideoIdForIdempotencyKey("app-1", "upload-key-0001"),
		).not.toBe(developerVideoIdForIdempotencyKey("app-2", "upload-key-0001"));
	});
});

describe("completing a developer video upload", () => {
	it("stores a private copy of the upload and bills its measured length", async () => {
		const id = await createAndUpload();
		const result = await completeDeveloperVideoUpload("app-1", id, {
			durationSeconds: 1,
		});

		expect(result).toMatchObject({ ok: true, chargedMicroCredits: 10_000 });
		expect(storedKey().startsWith(STORED_PREFIX)).toBe(true);
		expect([...context.objects.keys()]).toEqual([storedKey()]);
		expect(context.objects.get(storedKey())).toBe(1_000_000);
		expect(context.probedUrls).toEqual([
			`https://internal.example/${storedKey()}`,
		]);
		expect(videos()[0]).toMatchObject({
			duration: 120,
			width: 1920,
			height: 1080,
			fps: 30,
		});
		expect(account()?.balanceMicroCredits).toBe(990_000);
		expect(ledger()).toHaveLength(1);
		expect(ledger()[0]).toMatchObject({
			type: "video_create",
			amountMicroCredits: -10_000,
			referenceId: id,
			referenceType: "developer_video",
			metadata: { durationSeconds: 120, measured: true },
		});
	});

	it("cannot be changed through the upload URL once completed", async () => {
		const id = await createAndUpload();
		await completeDeveloperVideoUpload("app-1", id, {});
		const billedKey = storedKey();
		context.objects.set(UPLOAD_KEY, 999_999_999);
		context.probe = { duration: 7200, width: 1, height: 1, fps: 1 };

		const again = await completeDeveloperVideoUpload("app-1", id, {});
		expect(again).toMatchObject({ ok: true, chargedMicroCredits: 0 });
		expect(storedKey()).toBe(billedKey);
		expect(context.objects.get(billedKey)).toBe(1_000_000);
		expect(videos()[0]?.duration).toBe(120);
		expect(ledger()).toHaveLength(1);
	});

	it("keeps exactly the copy it billed when completions overlap", async () => {
		const id = await createAndUpload();
		const first = completeDeveloperVideoUpload("app-1", id, {});
		context.objects.set(UPLOAD_KEY, 1_000_000);
		const second = completeDeveloperVideoUpload("app-1", id, {});
		const results = await Promise.all([first, second]);
		await completeDeveloperVideoUpload("app-1", id, {});

		expect(results.filter((result) => result.ok).length).toBeGreaterThan(0);
		expect(ledger()).toHaveLength(1);
		expect(account()?.balanceMicroCredits).toBe(990_000);
		const stored = [...context.objects.keys()].filter((key) =>
			key.startsWith(STORED_PREFIX),
		);
		expect(stored).toEqual([storedKey()]);
	});

	it("charges only for the copy it keeps when overlapping completions claim different lengths", async () => {
		context.probe = null;
		const id = await createAndUpload(1_000_000);
		const results = await Promise.all([
			completeDeveloperVideoUpload("app-1", id, { durationSeconds: 60 }),
			completeDeveloperVideoUpload("app-1", id, { durationSeconds: 120 }),
		]);

		expect(results.every((result) => result.ok)).toBe(true);
		const kept = videos()[0]?.duration as number;
		expect([60, 120]).toContain(kept);
		expect(ledger()).toHaveLength(1);
		expect(ledger()[0]).toMatchObject({
			metadata: { durationSeconds: kept },
		});
		expect(account()?.balanceMicroCredits).toBe(
			1_000_000 - Math.floor((kept / 60) * 5_000),
		);
		const charged = results.map((result) =>
			result.ok ? result.chargedMicroCredits : -1,
		);
		expect(charged.filter((value) => value > 0)).toHaveLength(1);
	});

	it("falls back to the claim with a size floor when it cannot measure", async () => {
		context.probe = null;
		const id = await createAndUpload(250_000_000);
		const result = await completeDeveloperVideoUpload("app-1", id, {
			durationSeconds: 10,
			width: 640,
			height: 360,
			fps: 24,
		});

		expect(result).toMatchObject({ ok: true, chargedMicroCredits: 8_333 });
		expect(videos()[0]).toMatchObject({
			duration: 100,
			width: 640,
			height: 360,
		});
		expect(ledger()[0]).toMatchObject({ metadata: { measured: false } });
	});

	it("needs a length from somewhere and leaves the upload in place to retry", async () => {
		context.mediaServer = false;
		const id = await createAndUpload();
		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 400,
			code: "duration_required",
		});
		expect(ledger()).toHaveLength(0);
		expect([...context.objects.keys()]).toEqual([UPLOAD_KEY]);

		const retried = await completeDeveloperVideoUpload("app-1", id, {
			durationSeconds: 60,
		});
		expect(retried).toMatchObject({ ok: true, chargedMicroCredits: 5_000 });
	});

	it("stores nothing when the file can be neither measured nor trusted", async () => {
		context.probe = null;
		const id = await createAndUpload();
		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 400,
			code: "duration_required",
		});
		expect([...context.objects.keys()]).toEqual([UPLOAD_KEY]);
		expect(ledger()).toHaveLength(0);
	});

	it("refuses to complete before the file exists", async () => {
		const created = await create();
		if (!created.ok) throw new Error("create failed");
		expect(
			await completeDeveloperVideoUpload("app-1", created.video.id, {
				durationSeconds: 60,
			}),
		).toMatchObject({ ok: false, status: 409, code: "upload_not_found" });
		expect(ledger()).toHaveLength(0);
	});

	it("charges nothing when credits ran out and completes after a top-up", async () => {
		const id = await createAndUpload();
		const current = account();
		if (current) current.balanceMicroCredits = 9_999;

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 402,
		});
		expect([...context.objects.keys()]).toEqual([UPLOAD_KEY]);
		expect(videos()[0]?.s3Key).toBe(INITIAL_KEY);
		expect(account()?.balanceMicroCredits).toBe(9_999);
		expect(ledger()).toHaveLength(0);
		expect(videos()[0]?.duration).toBeNull();

		if (current) current.balanceMicroCredits = 50_000;
		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: true,
			chargedMicroCredits: 10_000,
		});
		expect([...context.objects.keys()]).toEqual([storedKey()]);
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

	it("charges nothing for a video deleted while it was completing", async () => {
		const id = await createAndUpload();
		context.onProbe = () => {
			const row = videos()[0];
			if (row) row.deletedAt = new Date();
		};

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(ledger()).toHaveLength(0);
		expect(account()?.balanceMicroCredits).toBe(1_000_000);
		expect([...context.objects.keys()]).toEqual([UPLOAD_KEY]);
		expect(videos()[0]?.duration).toBeNull();
	});

	it("leaves credits held for a running transcript alone", async () => {
		const id = await createAndUpload();
		const current = account();
		if (current) current.balanceMicroCredits = 15_000;
		fake().seed(developerTranscripts, {
			id: "tr-held",
			appId: "app-1",
			status: "processing",
			deletedAt: null,
			reservedMicroCredits: 10_000,
		});

		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: false,
			status: 402,
		});
		expect(account()?.balanceMicroCredits).toBe(15_000);
		expect(ledger()).toHaveLength(0);

		const held = fake()
			.rows(developerTranscripts)
			.find((row) => row.id === "tr-held");
		if (held) held.status = "complete";
		expect(await completeDeveloperVideoUpload("app-1", id, {})).toMatchObject({
			ok: true,
			chargedMicroCredits: 10_000,
		});
	});

	it("needs the minimum balance after holds to start an upload", async () => {
		const current = account();
		if (current) current.balanceMicroCredits = 12_000;
		fake().seed(developerTranscripts, {
			id: "tr-held",
			appId: "app-1",
			status: "processing",
			deletedAt: null,
			reservedMicroCredits: 10_000,
		});
		expect(await create()).toMatchObject({ ok: false, status: 402 });
	});

	it("returns named fields only, never the stored row", async () => {
		const id = await createAndUpload();
		const row = videos()[0];
		if (row) {
			Object.assign(row, {
				metadata: { secret: "internal-note" },
				filesDeletedAt: null,
				processing: { encodeId: "enc-1", probe: { duration: 1 } },
				playbackId: "pb-internal",
				renditions: [{ key: "developer/app-1/x/720p.m3u8" }],
				errorReason: "internal reason",
			});
		}

		const first = await completeDeveloperVideoUpload("app-1", id, {});
		const repeat = await completeDeveloperVideoUpload("app-1", id, {});

		for (const result of [first, repeat]) {
			if (!result.ok) throw new Error("completion failed");
			expect(Object.keys(result).sort()).toEqual([
				"chargedMicroCredits",
				"ok",
				"video",
			]);
			expect(Object.keys(result.video).sort()).toEqual([
				"appId",
				"durationSeconds",
				"fps",
				"height",
				"id",
				"name",
				"width",
			]);
			const serialized = JSON.stringify(result);
			for (const internal of [
				"s3Key",
				"developer/",
				"_uploads",
				"internal-note",
				"filesDeletedAt",
				"processing",
				"enc-1",
				"pb-internal",
				"renditions",
				"errorReason",
				"deletedAt",
				"externalUserId",
			]) {
				expect(serialized).not.toContain(internal);
			}
		}

		const created = await create({ idempotencyKey: "another-key-0001" });
		if (!created.ok) throw new Error("create failed");
		expect(Object.keys(created.video).sort()).toEqual(["appId", "id", "name"]);
		expect(JSON.stringify(created.video)).not.toContain("developer/");
	});

	it("does not complete another app's video", async () => {
		const id = await createAndUpload();
		expect(await completeDeveloperVideoUpload("app-2", id, {})).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(context.objects.has(UPLOAD_KEY)).toBe(true);
		expect(ledger()).toHaveLength(0);
	});
});
