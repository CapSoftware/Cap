import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const S3_KEY = "developer/app-1/video-1/video";
const FOUR_HOURS_SECS = 4 * 60 * 60;

type StoredPart = { PartNumber: number; ETag?: string; Size?: number };

const mocks = vi.hoisted(() => ({
	balance: 0,
	accountExists: true,
	storedParts: [] as StoredPart[],
	listPartsFails: false,
	completeFailures: 0,
	storedDuration: null as number | null,
	recordedReads: [] as (number | null)[],
	events: [] as string[],
	complete: vi.fn(),
	listParts: vi.fn(),
	headObject: vi.fn(),
	deleteObject: vi.fn(),
	unrecorded: [] as { id: string; appId: string; s3Key: string | null }[],
	deletedAt: null as Date | null,
	maxTier: "1080p" as string,
	status: "uploading" as string,
	creditTransactions: [] as Record<string, unknown>[],
	videoUpdates: [] as Record<string, unknown>[],
	admission: vi.fn(),
	claim: vi.fn(),
	release: vi.fn(),
	startProcessing: vi.fn(),
}));

vi.mock("@/lib/developer-video-start", () => ({
	claimDeveloperVideoUpload: mocks.claim,
	releaseDeveloperVideoUpload: mocks.release,
	startDeveloperVideoProcessing: mocks.startProcessing,
}));

vi.mock("@/lib/infra-standing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/infra-standing")>()),
	getInfraUploadAdmission: mocks.admission,
}));

vi.mock("@cap/database", async () => {
	const { developerVideos } = await import("@cap/database/schema");
	const { MySqlDialect } = await import("drizzle-orm/mysql-core");
	const dialect = new MySqlDialect();
	type Condition = Parameters<typeof dialect.sqlToQuery>[0];

	const selectRows = (fields: Record<string, unknown>, where?: Condition) => {
		const keys = Object.keys(fields).sort().join(",");
		if (keys === "appId,deletedAt,duration,maxResolutionTier,s3Key,status") {
			return [
				{
					appId: "app-1",
					s3Key: S3_KEY,
					duration: mocks.storedDuration,
					deletedAt: mocks.deletedAt,
					maxResolutionTier: mocks.maxTier,
					status: mocks.status,
				},
			];
		}
		if (keys === "id") {
			return [{ id: "video-1" }];
		}
		if (keys === "appId,id,s3Key") {
			const cursor = where
				? dialect
						.sqlToQuery(where)
						.params.filter(
							(param): param is string =>
								typeof param === "string" && !/^\d{4}-/.test(param),
						)
				: [];
			const [after = "", upTo] = cursor;
			return mocks.unrecorded.filter(
				(row) => row.id > after && (upTo === undefined || row.id <= upTo),
			);
		}
		if (keys === "deletedAt,duration,status,updatedAt") {
			return [
				{
					status: "processing",
					duration: mocks.storedDuration,
					updatedAt: new Date(),
					deletedAt: mocks.deletedAt,
				},
			];
		}
		if (keys === "deletedAt,duration") {
			return [
				{
					duration: mocks.recordedReads.length
						? (mocks.recordedReads.shift() ?? null)
						: mocks.storedDuration,
					deletedAt: mocks.deletedAt,
				},
			];
		}
		if (keys === "duration") {
			return [{ duration: mocks.recordedReads.shift() ?? null }];
		}
		if (keys === "total") {
			return [
				{
					total: mocks.creditTransactions.reduce(
						(sum, row) => sum - Number(row.amountMicroCredits),
						0,
					),
				},
			];
		}
		if (keys === "balanceMicroCredits,id") {
			return mocks.accountExists
				? [{ id: "account-1", balanceMicroCredits: mocks.balance }]
				: [];
		}
		if (keys === "balanceMicroCredits") {
			return [{ balanceMicroCredits: mocks.balance }];
		}
		throw new Error(`Unexpected select: ${keys}`);
	};

	const selectChain = (fields: Record<string, unknown>) => ({
		from: () => ({
			where: (where?: Condition) => {
				const rows = Promise.resolve().then(() => selectRows(fields, where));
				const result = Object.assign(rows, {
					limit: () => result,
					orderBy: () => result,
					for: () => {
						mocks.events.push("lock");
						return result;
					},
				});
				return result;
			},
		}),
	});

	const writeVideo = (values: Record<string, unknown>) => {
		mocks.videoUpdates.push(values);
		if ("duration" in values) {
			mocks.storedDuration = values.duration as number | null;
		}
		if ("deletedAt" in values) {
			mocks.deletedAt = values.deletedAt as Date | null;
		}
	};

	const tx = {
		select: selectChain,
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					if (table !== developerVideos || mocks.storedDuration !== null) {
						return [{ affectedRows: 0 }];
					}
					writeVideo(values);
					mocks.events.push("deletedAt" in values ? "retire" : "store");
					return [{ affectedRows: 1 }];
				},
			}),
		}),
		insert: () => ({
			values: async (values: Record<string, unknown>) => {
				mocks.creditTransactions.push(values);
			},
		}),
	};
	return {
		db: () => ({
			select: selectChain,
			transaction: async (callback: (value: typeof tx) => Promise<unknown>) =>
				callback(tx),
			update: (table: unknown) => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						if (table === developerVideos) writeVideo(values);
					},
				}),
			}),
		}),
	};
});

vi.mock("@cap/database/helpers", () => ({
	nanoId: () => "transaction-1",
	nanoIdLength: 15,
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		provideOptionalAuth: (effect: unknown) => effect,
		S3Buckets: {
			getBucketAccess: () =>
				Effect.succeed([
					{
						headObject: mocks.headObject,
						deleteObject: mocks.deleteObject,
						multipart: {
							complete: mocks.complete,
							listParts: mocks.listParts,
						},
					},
				]),
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return {
		runPromise: (effect: Effect.Effect<unknown, unknown>) =>
			Effect.runPromise(effect),
	};
});

vi.mock("@/app/api/utils", () => ({
	withDeveloperUploadToken: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("developerAppId", "app-1");
		c.set("developerVideoId", "video-1");
		c.set("developerUploadCompleted", false);
		await next();
	},
}));

import { app } from "@/app/api/developer/sdk/v1/[...route]/upload";
import { removeUnrecordedInfraFiles } from "@/lib/infra-video-upload";

type RequestPart = { partNumber: number; etag: string; size: number };

const complete = (body: {
	parts?: RequestPart[];
	durationInSecs: number;
	width?: number;
	height?: number;
}) =>
	app.request("/complete", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId: "video-1",
			uploadId: "upload-1",
			parts: body.parts ?? [{ partNumber: 1, etag: '"etag-1"', size: 1 }],
			durationInSecs: body.durationInSecs,
			width: body.width ?? 1920,
			height: body.height ?? 1080,
		}),
	});

const CLAIM = { action: "start", encodeId: "encode-1" };

const admitted = {
	allowed: true,
	reason: null,
	standing: { state: "active" as const, pausesAt: null },
	balanceMicroCredits: 10_000_000,
	requiredMicroCredits: 20,
	shortfallMicroCredits: 0,
	message: null,
};

const refused = {
	allowed: false,
	reason: "insufficient_credits" as const,
	standing: { state: "active" as const, pausesAt: null },
	balanceMicroCredits: 100,
	requiredMicroCredits: 19_834,
	shortfallMicroCredits: 19_734,
	message:
		"Uploading needs $0.20 of credit, enough for 7 days of storage for everything this app stores. The balance is $0.00, so add at least $0.20.",
};

describe("developer SDK multipart completion", () => {
	beforeEach(() => {
		mocks.balance = 10_000_000;
		mocks.accountExists = true;
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 1_000 }];
		mocks.listPartsFails = false;
		mocks.completeFailures = 0;
		mocks.recordedReads = [];
		mocks.storedDuration = null;
		mocks.events = [];
		mocks.creditTransactions = [];
		mocks.videoUpdates = [];
		mocks.deletedAt = null;
		mocks.maxTier = "1080p";
		mocks.status = "uploading";
		mocks.admission.mockReset();
		mocks.admission.mockResolvedValue(admitted);
		mocks.claim.mockReset();
		mocks.claim.mockImplementation(async () => {
			mocks.events.push("claim");
			return CLAIM;
		});
		mocks.release.mockReset();
		mocks.release.mockResolvedValue(undefined);
		mocks.startProcessing.mockReset();
		mocks.startProcessing.mockImplementation(async () => {
			mocks.events.push("hook");
			return true;
		});
		mocks.complete.mockReset();
		mocks.complete.mockImplementation(() => {
			if (mocks.completeFailures > 0) {
				mocks.completeFailures -= 1;
				return Effect.fail(new Error("complete failed"));
			}
			return Effect.sync(() => {
				mocks.events.push("complete");
				return {};
			});
		});
		mocks.listParts.mockReset();
		mocks.listParts.mockImplementation(() =>
			mocks.listPartsFails
				? Effect.fail(new Error("list failed"))
				: Effect.succeed(mocks.storedParts),
		);
		mocks.headObject.mockReset();
		mocks.headObject.mockImplementation(() =>
			Effect.fail(new Error("not found")),
		);
		mocks.deleteObject.mockReset();
		mocks.deleteObject.mockImplementation(() => Effect.succeed({}));
		mocks.unrecorded = [];
	});

	it("charges nothing when an upload completes", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(200);
		expect(mocks.balance).toBe(10_000_000);
		expect(mocks.creditTransactions).toEqual([]);
	});

	it("completes storage first, then checks admission and records the video under the account lock", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		mocks.admission.mockImplementation(async () => {
			mocks.events.push("admission");
			return admitted;
		});

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(200);
		expect(mocks.events).toEqual([
			"admission",
			"claim",
			"complete",
			"lock",
			"admission",
			"store",
			"hook",
		]);
		expect(mocks.admission.mock.calls[0]?.[2]).toBeUndefined();
		expect(mocks.admission.mock.calls[1]?.[2]).toBeDefined();
	});

	it("starts processing exactly once, with the claim, after the video is recorded", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(200);
		expect(mocks.startProcessing).toHaveBeenCalledTimes(1);
		expect(mocks.startProcessing).toHaveBeenCalledWith("video-1", CLAIM);
		expect(mocks.release).not.toHaveBeenCalled();
	});

	it("does not start processing for a repeated completion of a recorded video", async () => {
		mocks.storedDuration = 60;

		await complete({ durationInSecs: 60 });

		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.startProcessing).not.toHaveBeenCalled();
	});

	it("refuses a second completion while the first holds the claim, without touching the file", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		mocks.claim.mockResolvedValue(null);

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			code: "completion_in_progress",
		});
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.videoUpdates).toEqual([]);
		expect(mocks.startProcessing).not.toHaveBeenCalled();
	});

	it("releases the claim when storage fails to assemble the file", async () => {
		mocks.completeFailures = 1;
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(500);
		expect(mocks.release).toHaveBeenCalledWith("video-1", CLAIM);
		expect(mocks.startProcessing).not.toHaveBeenCalled();
		errors.mockRestore();
	});

	it("removes the assembled file and says to upload again when a parallel upload took the allowance", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		mocks.admission
			.mockResolvedValueOnce(admitted)
			.mockResolvedValueOnce(refused);

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(402);
		const body = await response.json();
		expect(body).toMatchObject({
			code: "insufficient_credits",
			fileRemoved: true,
			shortfallMicroCredits: 19_734,
		});
		expect(body.message).toContain("upload it again once credit is added");
		expect(mocks.complete).toHaveBeenCalledTimes(1);
		expect(mocks.deleteObject).toHaveBeenCalledTimes(1);
		expect(mocks.deleteObject).toHaveBeenCalledWith(S3_KEY);
		expect(mocks.release).toHaveBeenCalledWith("video-1", CLAIM);
		expect(mocks.startProcessing).not.toHaveBeenCalled();
		expect(mocks.videoUpdates).toEqual([]);
		expect(mocks.storedDuration).toBe(null);
	});

	it("keeps the file when the upload is refused before storage assembles it", async () => {
		mocks.admission.mockResolvedValue(refused);

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(402);
		await expect(response.json()).resolves.not.toHaveProperty("fileRemoved");
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.deleteObject).not.toHaveBeenCalled();
	});

	it("still answers 402 when the refused file cannot be removed", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		mocks.admission
			.mockResolvedValueOnce(admitted)
			.mockResolvedValueOnce(refused);
		mocks.deleteObject.mockImplementation(() =>
			Effect.fail(new Error("storage down")),
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(402);
		expect(mocks.videoUpdates).toEqual([]);
		errors.mockRestore();
	});

	it("measures an assembled file from its size in storage, not from the request", async () => {
		mocks.listPartsFails = true;
		mocks.headObject.mockImplementation(() =>
			Effect.succeed({ ContentLength: 100_000_000 }),
		);

		const response = await complete({ durationInSecs: 0.5 });

		expect(response.status).toBe(200);
		expect(mocks.headObject).toHaveBeenCalledWith(S3_KEY);
		expect(mocks.videoUpdates).toEqual([
			{ duration: 40, width: 1920, height: 1080 },
		]);
	});

	it("measures the upload from the part sizes storage reports, not the sizes in the request", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 60_000_000 },
			{ PartNumber: 2, ETag: '"etag-2"', Size: 40_000_000 },
		];
		const response = await complete({
			parts: [
				{ partNumber: 1, etag: '"etag-1"', size: 1 },
				{ partNumber: 2, etag: '"etag-2"', size: 1 },
			],
			durationInSecs: 0.5,
		});

		expect(response.status).toBe(200);
		expect(mocks.listParts).toHaveBeenCalledWith(S3_KEY, "upload-1");
		expect(mocks.videoUpdates).toEqual([
			{ duration: 40, width: 1920, height: 1080 },
		]);
	});

	it("stores the submitted duration when it is longer than the size floor", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		const response = await complete({ durationInSecs: 12.5 });

		expect(response.status).toBe(200);
		expect(mocks.videoUpdates).toEqual([
			{ duration: 12.5, width: 1920, height: 1080 },
		]);
	});

	it("only counts the parts the request completes", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 25_000_000 },
			{ PartNumber: 2, ETag: '"etag-2"', Size: 500_000_000 },
		];
		const response = await complete({ durationInSecs: 1 });

		expect(response.status).toBe(200);
		expect(mocks.videoUpdates).toEqual([
			{ duration: 10, width: 1920, height: 1080 },
		]);
	});

	it("keeps the four hour cap for submitted and size-derived durations", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 36_000_000_000 },
		];
		const response = await complete({ durationInSecs: FOUR_HOURS_SECS + 600 });

		expect(response.status).toBe(200);
		expect(mocks.videoUpdates[0]?.duration).toBe(FOUR_HOURS_SECS);
	});

	it("bounds a declared duration by what the uploaded bytes could hold", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 30_000 }];
		const response = await complete({ durationInSecs: 3600 });

		expect(response.status).toBe(200);
		expect(mocks.videoUpdates[0]?.duration).toBe(30);
	});

	it("accepts the longest duration the uploaded bytes could hold", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 60_000 }];

		expect((await complete({ durationInSecs: 60 })).status).toBe(200);
		expect(mocks.videoUpdates[0]?.duration).toBe(60);
	});

	it("asks admission with the stored duration, size and tier of the new video", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 100_000_000 },
		];

		mocks.maxTier = "2160p";

		await complete({ durationInSecs: 90, width: 3840, height: 2160 });

		const video = {
			durationSeconds: 90,
			width: 3840,
			height: 2160,
			tier: "2160p",
		};
		expect(mocks.admission).toHaveBeenCalledTimes(2);
		const own = { excludeVideoId: "video-1" };
		expect(mocks.admission).toHaveBeenNthCalledWith(
			1,
			"app-1",
			video,
			undefined,
			own,
		);
		expect(mocks.admission).toHaveBeenNthCalledWith(
			2,
			"app-1",
			video,
			expect.anything(),
			own,
		);
	});

	it("prices a 4K source capped at 1080p as 1080p in both admission checks", async () => {
		mocks.storedParts = [
			{ PartNumber: 1, ETag: '"etag-1"', Size: 100_000_000 },
		];
		mocks.maxTier = "1080p";

		await complete({ durationInSecs: 90, width: 3840, height: 2160 });

		expect(mocks.admission).toHaveBeenCalledTimes(2);
		for (const call of mocks.admission.mock.calls) {
			expect(call[1]).toMatchObject({
				width: 3840,
				height: 2160,
				tier: "1080p",
			});
		}
	});

	it("refuses with 402 and the amount needed, and leaves the upload open for a retry", async () => {
		mocks.admission.mockResolvedValueOnce(refused);
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];

		const first = await complete({ durationInSecs: 60 });

		expect(first.status).toBe(402);
		await expect(first.json()).resolves.toEqual({
			error: "Insufficient credits",
			code: "insufficient_credits",
			message: refused.message,
			standing: "active",
			pausesAt: null,
			balanceMicroCredits: 100,
			requiredMicroCredits: 19_834,
			shortfallMicroCredits: 19_734,
		});
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.videoUpdates).toEqual([]);

		const retry = await complete({ durationInSecs: 60 });

		expect(retry.status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledTimes(1);
		expect(mocks.videoUpdates).toEqual([
			{ duration: 60, width: 1920, height: 1080 },
		]);
	});

	it("refuses an app that is out of credit", async () => {
		mocks.admission.mockResolvedValue({
			...refused,
			reason: "out_of_credit",
			standing: {
				state: "grace",
				pausesAt: new Date("2026-11-18T06:41:00Z"),
			},
			message:
				"This app is out of credit, so uploads are blocked. Add at least $0.20 to upload again.",
		});

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(402);
		await expect(response.json()).resolves.toMatchObject({
			code: "out_of_credit",
			standing: "grace",
			pausesAt: "2026-11-18T06:41:00.000Z",
		});
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("refuses a request that repeats a part, before admission", async () => {
		const response = await complete({
			parts: [
				{ partNumber: 1, etag: '"etag-1"', size: 1 },
				{ partNumber: 1, etag: '"etag-1"', size: 1 },
			],
			durationInSecs: 60,
		});

		expect(response.status).toBe(400);
		expect(mocks.admission).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("accepts part ETags with or without quotes", async () => {
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		const response = await complete({
			parts: [{ partNumber: 1, etag: "etag-1", size: 1 }],
			durationInSecs: 5,
		});

		expect(response.status).toBe(200);
	});

	it("fails without asking admission when the parts cannot be listed and no file was assembled", async () => {
		mocks.listPartsFails = true;
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(500);
		expect(mocks.headObject).toHaveBeenCalledWith(S3_KEY);
		expect(mocks.admission).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
		errors.mockRestore();
	});

	it("returns success without another check when the upload already completed", async () => {
		mocks.storedDuration = 60;

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(200);
		expect(mocks.admission).not.toHaveBeenCalled();
		expect(mocks.listParts).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("answers success when another request recorded the video before storage completion", async () => {
		mocks.recordedReads = [60];

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(200);
		expect(mocks.admission).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.videoUpdates).toEqual([]);
	});

	it("answers success when another request recorded the video while this one waited for the lock", async () => {
		mocks.recordedReads = [null, 60];
		mocks.admission.mockResolvedValueOnce({ allowed: true });
		mocks.admission.mockResolvedValue({
			allowed: false,
			reason: "insufficient_balance",
		});

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(200);
		expect(mocks.admission).toHaveBeenCalledTimes(1);
		expect(mocks.videoUpdates).toEqual([]);
	});

	it("records nothing when storage fails, so the upload can be retried", async () => {
		mocks.completeFailures = 1;
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const first = await complete({ durationInSecs: 60 });
		const retry = await complete({ durationInSecs: 60 });

		expect(first.status).toBe(500);
		expect(retry.status).toBe(200);
		expect(mocks.creditTransactions).toEqual([]);
		expect(mocks.videoUpdates).toEqual([
			{ duration: 60, width: 1920, height: 1080 },
		]);
		expect(mocks.storedDuration).toBe(60);
		errors.mockRestore();
	});
});

describe("removing files that were assembled but never recorded", () => {
	const now = new Date("2026-11-12T12:00:00Z");
	const hoursAgo = (hours: number) =>
		new Date(now.getTime() - hours * 60 * 60 * 1000);
	const row = (name: string) => ({
		id: "video-1",
		appId: "app-1",
		s3Key: `developer/app-1/${name}/video` as string | null,
	});
	const old = () => Effect.succeed({ LastModified: hoursAgo(25) });

	beforeEach(() => {
		mocks.storedDuration = null;
		mocks.deletedAt = null;
		mocks.events = [];
		mocks.videoUpdates = [];
		mocks.deleteObject.mockReset();
		mocks.deleteObject.mockImplementation(() => {
			mocks.events.push("delete");
			return Effect.succeed({});
		});
		mocks.headObject.mockReset();
		mocks.admission.mockReset();
		mocks.admission.mockResolvedValue(admitted);
		mocks.claim.mockReset();
		mocks.claim.mockResolvedValue(CLAIM);
		mocks.release.mockReset();
		mocks.release.mockResolvedValue(undefined);
		mocks.startProcessing.mockReset();
		mocks.startProcessing.mockResolvedValue(true);
		mocks.listParts.mockReset();
		mocks.listParts.mockImplementation(() =>
			Effect.fail(new Error("no such upload")),
		);
		mocks.complete.mockReset();
	});

	it("retires the video under the account lock, then deletes the file", async () => {
		mocks.unrecorded = [row("old")];
		mocks.headObject.mockImplementation(old);

		expect(await removeUnrecordedInfraFiles(now)).toBe(1);
		expect(mocks.events).toEqual(["lock", "retire", "delete"]);
		expect(mocks.videoUpdates).toEqual([{ deletedAt: now }]);
		expect(mocks.deleteObject).toHaveBeenCalledWith(
			"developer/app-1/old/video",
		);
	});

	it("keeps the file when a completion records the video between the sweep's read and its delete", async () => {
		mocks.unrecorded = [row("old")];
		mocks.headObject.mockImplementation(() => {
			mocks.storedDuration = 60;
			return old();
		});

		expect(await removeUnrecordedInfraFiles(now)).toBe(0);
		expect(mocks.deleteObject).not.toHaveBeenCalled();
		expect(mocks.deletedAt).toBe(null);
		expect(mocks.videoUpdates).toEqual([]);
	});

	it("refuses a completion that reaches the lock after the sweep retired the video", async () => {
		mocks.unrecorded = [row("old")];
		mocks.headObject.mockImplementation(old);
		mocks.storedParts = [{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }];
		mocks.listParts.mockImplementation(() => Effect.succeed(mocks.storedParts));
		mocks.complete.mockImplementation(() => Effect.succeed({}));
		mocks.admission.mockImplementationOnce(async () => {
			await removeUnrecordedInfraFiles(now);
			return admitted;
		});

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			code: "upload_removed",
			error: expect.stringContaining("upload the file again"),
		});
		expect(mocks.release).toHaveBeenCalledWith("video-1", CLAIM);
		expect(mocks.startProcessing).not.toHaveBeenCalled();
		expect(mocks.storedDuration).toBe(null);
		expect(mocks.videoUpdates).toEqual([{ deletedAt: now }]);
		expect(mocks.deleteObject).toHaveBeenCalledTimes(1);
	});

	it("answers not found for a completion that starts after the video was retired", async () => {
		mocks.unrecorded = [row("old")];
		mocks.headObject.mockImplementation(old);
		await removeUnrecordedInfraFiles(now);

		const response = await complete({ durationInSecs: 60 });

		expect(response.status).toBe(404);
		expect(mocks.storedDuration).toBe(null);
	});

	it("leaves an old video's freshly assembled file alone until the file is a day old, then removes it", async () => {
		mocks.unrecorded = [row("late")];
		const assembledAt = hoursAgo(1);
		mocks.headObject.mockImplementation(() =>
			Effect.succeed({ LastModified: assembledAt }),
		);

		expect(await removeUnrecordedInfraFiles(now)).toBe(0);
		expect(mocks.deleteObject).not.toHaveBeenCalled();
		expect(mocks.videoUpdates).toEqual([]);

		const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);

		expect(await removeUnrecordedInfraFiles(nextDay)).toBe(1);
		expect(mocks.videoUpdates).toEqual([{ deletedAt: nextDay }]);
		expect(mocks.deleteObject).toHaveBeenCalledWith(
			"developer/app-1/late/video",
		);
	});

	it("visits every unfinished video once from any starting point", async () => {
		mocks.unrecorded = ["a", "h", "p", "z"].map((id) => ({
			id,
			appId: "app-1",
			s3Key: `developer/app-1/${id}/video`,
		}));
		mocks.headObject.mockImplementation(() =>
			Effect.fail(new Error("not found")),
		);

		for (const start of ["", "k", "zz"]) {
			mocks.headObject.mockClear();
			await removeUnrecordedInfraFiles(now, start);
			expect(
				mocks.headObject.mock.calls.map(([key]) => String(key)).sort(),
			).toEqual(
				["a", "h", "p", "z"].map((id) => `developer/app-1/${id}/video`),
			);
		}
	});

	it("leaves a file assembled within the last day, and a video with no file", async () => {
		mocks.unrecorded = [
			row("fresh"),
			row("none"),
			{ ...row("x"), s3Key: null },
		];
		mocks.headObject.mockImplementation((key: string) =>
			key.includes("fresh")
				? Effect.succeed({ LastModified: hoursAgo(2) })
				: Effect.fail(new Error("not found")),
		);

		expect(await removeUnrecordedInfraFiles(now)).toBe(0);
		expect(mocks.deleteObject).not.toHaveBeenCalled();
		expect(mocks.videoUpdates).toEqual([]);
	});

	it("counts only the files it removed", async () => {
		mocks.unrecorded = [row("a"), row("b")];
		mocks.headObject.mockImplementation(old);
		mocks.deleteObject.mockImplementation((key: string) =>
			key.includes("/b/")
				? Effect.fail(new Error("storage down"))
				: Effect.succeed({}),
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await removeUnrecordedInfraFiles(now)).toBe(1);
		errors.mockRestore();
	});
});
