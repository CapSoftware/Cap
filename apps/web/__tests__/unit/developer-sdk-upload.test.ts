import type { Effect as EffectType } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	video: null as null | {
		appId: string;
		duration: number | null;
		deletedAt: string | null;
		status?: string;
	},
	admission: vi.fn(),
	claim: vi.fn(),
	release: vi.fn(),
	startProcessing: vi.fn(),
	create: vi.fn(),
	presign: vi.fn(),
	complete: vi.fn(),
	abort: vi.fn(),
	listParts: vi.fn(),
	headObject: vi.fn(),
	listUploads: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const database = drizzle(mocks.query);
	const transaction = (run: (tx: typeof database) => unknown) => run(database);
	return { db: () => Object.assign(database, { transaction }) };
});
vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	const { S3Error } = await import("@cap/web-domain");
	const storage = (call: () => unknown) =>
		Effect.try({ try: call, catch: (cause) => new S3Error({ cause }) });
	const multipart = {
		create: (...args: unknown[]) =>
			storage(() => mocks.create(...args) ?? { UploadId: "upload-1" }),
		getPresignedUploadPartUrl: (...args: unknown[]) =>
			storage(() => mocks.presign(...args) ?? "https://part"),
		complete: (...args: unknown[]) => storage(() => mocks.complete(...args)),
		abort: (...args: unknown[]) => storage(() => mocks.abort(...args)),
		listUploads: (...args: unknown[]) =>
			storage(() => mocks.listUploads(...args) ?? { Uploads: [] }),
		listParts: (...args: unknown[]) =>
			storage(
				() =>
					mocks.listParts(...args) ?? [
						{ PartNumber: 1, ETag: '"etag-1"', Size: 1_048_576 },
					],
			),
	};
	return {
		provideOptionalAuth: <T>(effect: T) => effect,
		S3Buckets: {
			getBucketAccess: () =>
				Effect.succeed([
					{ multipart, headObject: () => storage(() => mocks.headObject()) },
				]),
		},
	};
});
vi.mock("@/lib/infra-standing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/infra-standing")>()),
	getInfraUploadAdmission: mocks.admission,
}));
vi.mock("@/lib/developer-video-start", () => ({
	claimDeveloperVideoUpload: mocks.claim,
	releaseDeveloperVideoUpload: mocks.release,
	startDeveloperVideoProcessing: mocks.startProcessing,
}));
vi.mock("@/lib/server", async () => {
	const { Cause, Effect, Exit } = await import("effect");
	return {
		runPromise: <A, E>(effect: EffectType.Effect<A, E>) =>
			Effect.runPromiseExit(effect).then((exit) => {
				if (Exit.isFailure(exit)) {
					if (Cause.isDieType(exit.cause)) throw exit.cause.defect;
					throw exit;
				}
				return exit.value;
			}),
	};
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

const storageError = (code: string, status: number) =>
	Object.assign(new Error(code), {
		name: code,
		Code: code,
		$fault: status >= 500 ? "server" : "client",
		$metadata: { httpStatusCode: status },
	});

const fails = (code: string, status: number) => () => {
	throw storageError(code, status);
};

function writes() {
	return mocks.query.mock.calls.filter(([query]) =>
		/^(insert|update|delete)/.test(String(query)),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.video = inProgress;
	mocks.claim.mockResolvedValue({ action: "start", encodeId: "encode-1" });
	mocks.startProcessing.mockResolvedValue(true);
	mocks.release.mockResolvedValue(undefined);
	mocks.admission.mockResolvedValue({
		allowed: true,
		reason: null,
		standing: { state: "active", pausesAt: null },
		balanceMicroCredits: 1_000_000,
		requiredMicroCredits: 1,
		shortfallMicroCredits: 0,
		message: null,
	});
	mocks.query.mockImplementation(async (query: string) => {
		if (query.includes("from `developer_videos`")) {
			const video = mocks.video;
			if (/^select `duration` from/i.test(query)) {
				return { rows: video ? [[video.duration]] : [] };
			}
			if (/^select `duration`, `deletedAt` from/i.test(query)) {
				return { rows: video ? [[video.duration, video.deletedAt]] : [] };
			}
			return {
				rows: video
					? [
							[
								video.appId,
								s3Key,
								video.duration,
								video.deletedAt,
								"1080p",
								video.status ?? "uploading",
							],
						]
					: [],
			};
		}
		if (query.includes("from `developer_credit_accounts`")) {
			return { rows: [["account-1"]] };
		}
		return { rows: [{ affectedRows: 1 }] };
	});
});

describe("developer SDK multipart upload", () => {
	const openUploads = (
		...uploads: { id: string; hoursAgo: number; key?: string }[]
	) =>
		mocks.listUploads.mockImplementation(({ prefix }: { prefix: string }) => ({
			Uploads: uploads.map((upload) => ({
				Key: upload.key ?? prefix,
				UploadId: upload.id,
				Initiated: new Date(Date.now() - upload.hoursAgo * 60 * 60 * 1000),
			})),
		}));

	it("starts an upload for a video that has none open", async () => {
		const response = await post("/initiate", {});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ uploadId: "upload-1" });
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.listUploads).toHaveBeenCalledWith({
			prefix: mocks.create.mock.calls[0]?.[0],
		});
		expect(mocks.abort).not.toHaveBeenCalled();
	});

	it("hands back the open upload instead of starting another", async () => {
		openUploads({ id: "open-1", hoursAgo: 1 });

		for (let attempt = 0; attempt < 3; attempt++) {
			const response = await post("/initiate", {});
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({ uploadId: "open-1" });
		}
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.abort).not.toHaveBeenCalled();
	});

	it("keeps the newest open upload and aborts the others", async () => {
		openUploads(
			{ id: "older", hoursAgo: 3 },
			{ id: "newest", hoursAgo: 1 },
			{ id: "oldest", hoursAgo: 5 },
		);

		const response = await post("/initiate", {});

		await expect(response.json()).resolves.toEqual({ uploadId: "newest" });
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.abort.mock.calls.map(([, id]) => id).sort()).toEqual([
			"older",
			"oldest",
		]);
	});

	it("replaces an open upload that the cleanup is about to remove", async () => {
		openUploads({ id: "nearly-expired", hoursAgo: 7 });

		const response = await post("/initiate", {});

		await expect(response.json()).resolves.toEqual({ uploadId: "upload-1" });
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(mocks.abort.mock.calls.map(([, id]) => id)).toEqual([
			"nearly-expired",
		]);
	});

	it("ignores another video's upload whose key starts the same way", async () => {
		openUploads({
			id: "neighbour",
			hoursAgo: 1,
			key: "developer/app-1/video-10/video",
		});

		const response = await post("/initiate", {});

		await expect(response.json()).resolves.toEqual({ uploadId: "upload-1" });
		expect(mocks.abort).not.toHaveBeenCalled();
	});

	it("still starts the upload when open uploads cannot be listed", async () => {
		mocks.listUploads.mockImplementation(() => {
			throw storageError("SlowDown", 503);
		});

		const response = await post("/initiate", {});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ uploadId: "upload-1" });
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

	it("completes without writing to the credit ledger, holding the account lock", async () => {
		const response = await post("/complete", completeBody);

		expect(response.status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledTimes(1);
		const queries = mocks.query.mock.calls.map(([query]) => String(query));
		expect(
			queries.some((query) =>
				/from `developer_credit_accounts`.*for update/i.test(query),
			),
		).toBe(true);
		expect(
			writes().some(([query]) =>
				/developer_credit_(accounts|transactions)/.test(String(query)),
			),
		).toBe(false);
		expect(
			writes().some(([query]) =>
				/^update `developer_videos` set .*`duration` is null/i.test(
					String(query),
				),
			),
		).toBe(true);
		expect(mocks.admission).toHaveBeenCalledWith(
			"app-1",
			{ durationSeconds: 12, width: 0, height: 0, tier: "1080p" },
			expect.anything(),
			{ excludeVideoId: "video-1" },
		);
	});

	it("refuses with 402 when the balance cannot cover seven days of storage", async () => {
		mocks.admission.mockResolvedValue({
			allowed: false,
			reason: "insufficient_credits",
			standing: { state: "active", pausesAt: null },
			balanceMicroCredits: 0,
			requiredMicroCredits: 19_834,
			shortfallMicroCredits: 19_834,
			message: "This app has no credit.",
		});

		const response = await post("/complete", completeBody);

		expect(response.status).toBe(402);
		await expect(response.json()).resolves.toMatchObject({
			error: "Insufficient credits",
			code: "insufficient_credits",
			requiredMicroCredits: 19_834,
		});
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(writes()).toHaveLength(0);
	});

	it("refuses to abort an upload that another request is completing", async () => {
		mocks.video = { ...inProgress, status: "processing" };

		const response = await post("/abort", { uploadId: "upload-1" });

		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			code: "completion_in_progress",
		});
		expect(mocks.abort).not.toHaveBeenCalled();
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

describe("client mistakes on complete and abort", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.headObject.mockImplementation(fails("NotFound", 404));
	});

	async function refusal(response: Response) {
		const body = await response.json();
		expect(typeof body.error).toBe("string");
		expect(typeof body.code).toBe("string");
		expect(typeof body.hint).toBe("string");
		return { status: response.status, code: body.code, hint: body.hint };
	}

	it("refuses an empty part list before touching storage or the claim", async () => {
		const response = await post("/complete", { ...completeBody, parts: [] });

		expect(await refusal(response)).toMatchObject({
			status: 400,
			code: "parts_required",
		});
		expect(mocks.listParts).not.toHaveBeenCalled();
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(writes()).toHaveLength(0);
	});

	it("answers 404 for an uploadId that is wrong or was aborted", async () => {
		mocks.listParts.mockImplementation(fails("NoSuchUpload", 404));

		const response = await post("/complete", {
			...completeBody,
			uploadId: "not-an-upload",
		});

		expect(await refusal(response)).toMatchObject({
			status: 404,
			code: "upload_not_found",
			hint: expect.stringContaining("Call initiate"),
		});
		expect(mocks.listParts).toHaveBeenCalledWith(s3Key, "not-an-upload");
		expect(mocks.claim).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(writes()).toHaveLength(0);
		expect(console.error).not.toHaveBeenCalled();
	});

	it("still completes when the upload is gone because the file was already assembled", async () => {
		mocks.listParts.mockImplementation(fails("NoSuchUpload", 404));
		mocks.headObject.mockReturnValue({ ContentLength: 1_048_576 });

		const response = await post("/complete", completeBody);

		expect(response.status).toBe(200);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.startProcessing).toHaveBeenCalledTimes(1);
	});

	it.each([
		["SlowDown", 503],
		["InternalError", 500],
		["AccessDenied", 403],
	] as const)(
		"keeps a retryable 500 when the upload is gone and the file check fails with %s",
		async (code, status) => {
			mocks.listParts.mockImplementation(fails("NoSuchUpload", 404));
			mocks.headObject.mockImplementation(fails(code, status));

			const response = await post("/complete", completeBody);

			expect(await refusal(response)).toMatchObject({
				status: 500,
				code: "internal_error",
				hint: expect.stringContaining("Retry with backoff"),
			});
			expect(console.error).toHaveBeenCalled();
			expect(mocks.claim).not.toHaveBeenCalled();
		},
	);

	it("answers 404 when storage names the missing file NoSuchKey", async () => {
		mocks.listParts.mockImplementation(fails("NoSuchUpload", 404));
		mocks.headObject.mockImplementation(fails("NoSuchKey", 404));

		const response = await post("/complete", completeBody);

		expect(await refusal(response)).toMatchObject({
			status: 404,
			code: "upload_not_found",
		});
	});

	it("names the minimum part size when a part other than the last is too small", async () => {
		mocks.complete.mockImplementation(fails("EntityTooSmall", 400));

		const response = await post("/complete", completeBody);

		expect(await refusal(response)).toMatchObject({
			status: 400,
			code: "part_too_small",
			hint: expect.stringContaining("5242880 bytes (5 MB)"),
		});
		expect(mocks.release).toHaveBeenCalledWith("video-1", {
			action: "start",
			encodeId: "encode-1",
		});
		expect(mocks.startProcessing).not.toHaveBeenCalled();
		expect(
			writes().some(([query]) =>
				String(query).startsWith("update `developer_videos`"),
			),
		).toBe(false);
	});

	it.each(["InvalidPart", "InvalidPartOrder"])(
		"answers 400 when storage rejects the parts with %s",
		async (code) => {
			mocks.complete.mockImplementation(fails(code, 400));

			const response = await post("/complete", completeBody);

			expect(await refusal(response)).toMatchObject({
				status: 400,
				code: "parts_mismatch",
			});
			expect(mocks.release).toHaveBeenCalledTimes(1);
		},
	);

	it("answers 404 when the upload is aborted while it is being completed", async () => {
		mocks.complete.mockImplementation(fails("NoSuchUpload", 404));

		const response = await post("/complete", completeBody);

		expect(await refusal(response)).toMatchObject({
			status: 404,
			code: "upload_not_found",
		});
		expect(mocks.release).toHaveBeenCalledTimes(1);
	});

	it("answers 400 with a code when a listed part was never uploaded", async () => {
		const response = await post("/complete", {
			...completeBody,
			parts: [{ partNumber: 2, etag: "etag-2", size: 1 }],
		});

		expect(await refusal(response)).toMatchObject({
			status: 400,
			code: "parts_mismatch",
		});
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it.each([
		["complete", "SlowDown", 503],
		["complete", "InternalError", 500],
		["complete", "AccessDenied", 403],
		["listParts", "InternalError", 500],
		["listParts", "AccessDenied", 403],
	] as const)(
		"keeps a %s failure with %s a retryable 500",
		async (call, code, status) => {
			mocks[call].mockImplementation(fails(code, status));

			const response = await post("/complete", completeBody);

			expect(await refusal(response)).toMatchObject({
				status: 500,
				code: "internal_error",
				hint: expect.stringContaining("Retry with backoff"),
			});
			expect(console.error).toHaveBeenCalled();
			expect(mocks.startProcessing).not.toHaveBeenCalled();
		},
	);

	it("answers 404 when aborting an upload that does not exist", async () => {
		mocks.video = uploaded;
		mocks.abort.mockImplementation(fails("NoSuchUpload", 404));

		const response = await post("/abort", { uploadId: "not-an-upload" });

		expect(await refusal(response)).toMatchObject({
			status: 404,
			code: "upload_not_found",
			hint: expect.stringContaining("Nothing was aborted"),
		});
		expect(console.error).not.toHaveBeenCalled();
	});

	it("keeps a storage failure on abort a retryable 500", async () => {
		mocks.abort.mockImplementation(fails("InternalError", 500));

		const response = await post("/abort", { uploadId: "upload-1" });

		expect(await refusal(response)).toMatchObject({
			status: 500,
			code: "internal_error",
		});
	});

	it.each([
		["/initiate", {}, null, 404, "video_not_found"],
		[
			"/presign-part",
			{ uploadId: "u", partNumber: 1 },
			null,
			404,
			"video_not_found",
		],
		["/complete", completeBody, null, 404, "video_not_found"],
		["/abort", { uploadId: "u" }, null, 404, "video_not_found"],
		["/initiate", {}, uploaded, 409, "upload_already_completed"],
		[
			"/presign-part",
			{ uploadId: "u", partNumber: 1 },
			uploaded,
			409,
			"upload_already_completed",
		],
	] as const)(
		"gives %s a code and a hint for a video in the wrong state",
		async (path, body, video, status, code) => {
			mocks.video = video;

			const response = await post(path, body);

			expect(await refusal(response)).toMatchObject({ status, code });
		},
	);

	it("gives the completion race its code and a hint", async () => {
		mocks.claim.mockResolvedValue(null);

		const response = await post("/complete", completeBody);

		expect(await refusal(response)).toMatchObject({
			status: 409,
			code: "completion_in_progress",
		});
	});
});

describe("malformed upload requests", () => {
	const send = (path: string, init: RequestInit) =>
		app.request(path, { method: "POST", ...init });

	it("puts a string in error and the failing fields in issues", async () => {
		const response = await post("/complete", {
			uploadId: "upload-1",
			parts: [{ partNumber: 0, etag: "etag-1", size: 1 }],
		});

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.code).toBe("invalid_request");
		expect(body.error).toMatch(/^Invalid request: parts\.0\.partNumber: /);
		expect(body.error).toContain("durationInSecs: ");
		expect(typeof body.hint).toBe("string");
		expect(
			body.issues.map((issue: { path: unknown[] }) => issue.path.join(".")),
		).toEqual(["parts.0.partNumber", "durationInSecs"]);
		expect(body).not.toHaveProperty("success");
	});

	it.each(['{"videoId": "video-1"', "", "not json"])(
		"answers malformed JSON %j with a JSON body",
		async (body) => {
			const response = await send("/initiate", {
				headers: { "Content-Type": "application/json" },
				body,
			});

			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain(
				"application/json",
			);
			expect(await response.json()).toMatchObject({
				error: "Malformed JSON in request body",
				code: "invalid_json",
				hint: expect.stringContaining("Content-Type: application/json"),
			});
			expect(mocks.create).not.toHaveBeenCalled();
		},
	);

	it.each([
		["text/plain", JSON.stringify({ videoId: "video-1" })],
		["application/x-www-form-urlencoded", "videoId=video-1"],
		[undefined, JSON.stringify({ videoId: "video-1" })],
	])("refuses a body sent as %s", async (contentType, body) => {
		const response = await send("/initiate", {
			headers: contentType ? { "Content-Type": contentType } : {},
			body: new TextEncoder().encode(body),
		});

		expect(response.status).toBe(415);
		expect(await response.json()).toMatchObject({
			code: "unsupported_media_type",
			hint: expect.stringContaining("Content-Type: application/json"),
		});
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("accepts the JSON content types Hono parses", async () => {
		const response = await send("/initiate", {
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({ videoId: "video-1" }),
		});

		expect(response.status).toBe(200);
	});
});
