import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	video: null as null | {
		appId: string;
		duration: number | null;
		deletedAt: string | null;
	},
	paidMicroCredits: 0,
	create: vi.fn(),
	presign: vi.fn(),
	complete: vi.fn(),
	abort: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const database = drizzle(mocks.query);
	const transaction = (run: (tx: typeof database) => unknown) => run(database);
	return { db: () => Object.assign(database, { transaction }) };
});
vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	const multipart = {
		create: (...args: unknown[]) =>
			Effect.sync(() => mocks.create(...args) ?? { UploadId: "upload-1" }),
		getPresignedUploadPartUrl: (...args: unknown[]) =>
			Effect.sync(() => mocks.presign(...args) ?? "https://part"),
		complete: (...args: unknown[]) =>
			Effect.sync(() => mocks.complete(...args)),
		abort: (...args: unknown[]) => Effect.sync(() => mocks.abort(...args)),
		listParts: () =>
			Effect.succeed([{ PartNumber: 1, ETag: '"etag-1"', Size: 1_048_576 }]),
	};
	return {
		provideOptionalAuth: <T>(effect: T) => effect,
		S3Buckets: {
			getBucketAccess: () => Effect.succeed([{ multipart }]),
		},
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});
vi.mock("@/app/api/utils", async () => {
	const { createMiddleware } = await import("hono/factory");
	return {
		withDeveloperPublicAuth: createMiddleware(async (c, next) => {
			c.set("developerAppId", "app-1");
			c.set("developerKeyType", "public");
			await next();
		}),
	};
});

const { app } = await import("@/app/api/developer/sdk/v1/[...route]/upload");

const s3Key = "developer/app-1/video-1/video";
const inProgress = { appId: "app-1", duration: null, deletedAt: null };
const uploaded = { appId: "app-1", duration: 12, deletedAt: null };
const deleted = {
	appId: "app-1",
	duration: null,
	deletedAt: "2026-11-01 00:00:00",
};

function post(path: string, body: Record<string, unknown>) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ videoId: "video-1", ...body }),
	});
}

const completeBody = {
	uploadId: "upload-1",
	parts: [{ partNumber: 1, etag: "etag-1", size: 1_048_576 }],
	durationInSecs: 12,
};

function writes() {
	return mocks.query.mock.calls.filter(([query]) =>
		/^(insert|update|delete)/.test(String(query)),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.video = inProgress;
	mocks.paidMicroCredits = 0;
	mocks.query.mockImplementation(async (query: string) => {
		if (query.includes("from `developer_videos`")) {
			const video = mocks.video;
			return {
				rows: video
					? [[video.appId, s3Key, video.duration, video.deletedAt]]
					: [],
			};
		}
		if (query.includes("from `developer_credit_transactions`")) {
			return { rows: [[mocks.paidMicroCredits]] };
		}
		if (query.includes("from `developer_credit_accounts`")) {
			return {
				rows: query.includes("`id`") ? [["account-1", 1_000_000]] : [[990_000]],
			};
		}
		return { rows: [{ affectedRows: 1 }] };
	});
});

describe("developer SDK multipart upload", () => {
	it("starts and restarts an upload that has not completed", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await post("/initiate", {});
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({ uploadId: "upload-1" });
		}
		expect(mocks.create).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ name: "an uploaded video", video: uploaded, status: 409 },
		{ name: "a deleted video", video: deleted, status: 404 },
		{
			name: "another app's video",
			video: { ...inProgress, appId: "app-2" },
			status: 404,
		},
		{ name: "a missing video", video: null, status: 404 },
	])("refuses to start an upload for $name", async ({ video, status }) => {
		mocks.video = video;

		const response = await post("/initiate", {});

		expect(response.status).toBe(status);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("presigns parts while the upload is in progress", async () => {
		const response = await post("/presign-part", {
			uploadId: "upload-1",
			partNumber: 2,
		});

		expect(response.status).toBe(200);
		expect(mocks.presign).toHaveBeenCalledWith(s3Key, "upload-1", 2);
	});

	it.each([
		{ name: "an uploaded video", video: uploaded, status: 409 },
		{ name: "a deleted video", video: deleted, status: 404 },
	])("refuses to presign parts for $name", async ({ video, status }) => {
		mocks.video = video;

		const response = await post("/presign-part", {
			uploadId: "upload-1",
			partNumber: 1,
		});

		expect(response.status).toBe(status);
		expect(mocks.presign).not.toHaveBeenCalled();
	});

	it("completes an in-progress upload and records its duration", async () => {
		const response = await post("/complete", completeBody);

		expect(response.status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledTimes(1);
		expect(
			writes().some(([query]) =>
				String(query).startsWith("update `developer_videos`"),
			),
		).toBe(true);
	});

	it("answers a repeated complete without charging or touching storage again", async () => {
		mocks.video = uploaded;

		const response = await post("/complete", completeBody);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true });
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(writes()).toHaveLength(0);
	});

	it("charges a completion once even when a retry overlaps it", async () => {
		mocks.paidMicroCredits = 1_000;

		const response = await post("/complete", completeBody);

		expect(response.status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledTimes(1);
		const queries = mocks.query.mock.calls.map(([query]) => String(query));
		expect(
			queries.some((query) =>
				/from `developer_videos`.*for update/i.test(query),
			),
		).toBe(true);
		expect(
			writes().some(([query]) =>
				/^(update `developer_credit_accounts`|insert into `developer_credit_transactions`)/.test(
					String(query),
				),
			),
		).toBe(false);
	});

	it("charges only the unpaid difference when a retry reports a longer upload", async () => {
		mocks.paidMicroCredits = 400;

		const response = await post("/complete", completeBody);

		expect(response.status).toBe(200);
		const debit = writes().find(([query]) =>
			String(query).startsWith("update `developer_credit_accounts`"),
		);
		expect(debit?.[1]).toContain(600);
		const record = writes().find(([query]) =>
			String(query).startsWith("insert into `developer_credit_transactions`"),
		);
		expect(record?.[1]).toContain(-600);
	});

	it("refuses to complete an upload for a deleted video", async () => {
		mocks.video = deleted;

		const response = await post("/complete", completeBody);

		expect(response.status).toBe(404);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(writes()).toHaveLength(0);
	});

	it("still aborts an unfinished upload after the video is deleted", async () => {
		mocks.video = deleted;

		const response = await post("/abort", { uploadId: "upload-1" });

		expect(response.status).toBe(200);
		expect(mocks.abort).toHaveBeenCalledWith(s3Key, "upload-1");
	});
});
