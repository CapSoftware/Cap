import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoFixture,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	video: null as Record<string, unknown> | null,
	updates: [] as Record<string, unknown>[],
	admission: vi.fn(),
	start: vi.fn(),
	listParts: vi.fn(),
	complete: vi.fn(),
	headObject: vi.fn(),
	deleteObject: vi.fn(),
}));

vi.mock("@cap/database", () => {
	const rows = () => {
		const result = Object.assign(
			Promise.resolve(mocks.video ? [mocks.video] : []),
			{ limit: () => result, for: () => result },
		);
		return result;
	};
	const database = {
		select: () => ({ from: () => ({ where: rows }) }),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					mocks.updates.push(values);
					if (mocks.video) mocks.video = { ...mocks.video, ...values };
					return [{ affectedRows: 1 }];
				},
			}),
		}),
		transaction: (run: (tx: unknown) => Promise<unknown>) => run(database),
	};
	return { db: () => database };
});
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true", NEXT_PUBLIC_WEB_URL: "https://web" },
	serverEnv: () => ({ WEB_URL: "https://web" }),
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {
		getBucketAccess: () =>
			Effect.succeed([
				{
					headObject: mocks.headObject,
					deleteObject: mocks.deleteObject,
					multipart: { listParts: mocks.listParts, complete: mocks.complete },
				},
			]),
	},
}));
vi.mock("@/lib/server", () => ({
	runPromise: (effect: Effect.Effect<unknown, unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("@/lib/infra-standing", () => ({
	getInfraUploadAdmission: mocks.admission,
	uploadAdmissionError: () => ({ error: "Insufficient credits" }),
}));
vi.mock("@/lib/developer-video-storage", () => ({}));
vi.mock("@/lib/media-client", () => ({}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/process-developer-video", () => ({
	processDeveloperVideoWorkflow: "workflow",
}));

const { abortInfraUpload, completeInfraUpload } = await import(
	"@/lib/infra-video-upload"
);

const uploading = (overrides: Partial<DeveloperVideoFixture> = {}) =>
	developerVideo({
		status: "uploading",
		duration: null,
		width: null,
		height: null,
		fps: null,
		processing: null,
		...overrides,
	});

const complete = () =>
	completeInfraUpload({
		appId: "app-1",
		videoId: "video-1",
		uploadId: "upload-1",
		parts: [{ partNumber: 1, etag: "etag-1", size: 10_000_000 }],
		durationInSecs: 60,
		width: 1920,
		height: 1080,
	});

beforeEach(() => {
	mocks.updates = [];
	mocks.admission.mockReset();
	mocks.admission.mockResolvedValue({ allowed: true });
	mocks.start.mockReset();
	mocks.start.mockResolvedValue(undefined);
	mocks.listParts.mockReset();
	mocks.listParts.mockImplementation(() =>
		Effect.succeed([{ PartNumber: 1, ETag: '"etag-1"', Size: 10_000_000 }]),
	);
	mocks.complete.mockReset();
	mocks.complete.mockImplementation(() => Effect.succeed({}));
	mocks.headObject.mockReset();
	mocks.headObject.mockImplementation(() => Effect.fail(new Error("none")));
	mocks.deleteObject.mockReset();
	mocks.deleteObject.mockImplementation(() => Effect.succeed({}));
});

describe("completing an upload through the processing claim", () => {
	it("gives a video created without a playback id one when its upload completes", async () => {
		mocks.video = uploading({ playbackId: null });

		const result = await complete();

		expect(result.status).toBe(200);
		expect(mocks.video).toMatchObject({
			status: "processing",
			duration: 60,
			playbackId: expect.stringMatching(/^[A-Za-z0-9_-]{16,}$/),
		});
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("keeps an existing playback id", async () => {
		mocks.video = uploading({ playbackId: "playback-id-0123456789ab" });

		await complete();

		expect(mocks.video?.playbackId).toBe("playback-id-0123456789ab");
	});

	it("claims the video before storage assembles the file and starts processing once with that claim", async () => {
		mocks.video = uploading();
		let statusAtAssembly: unknown;
		mocks.complete.mockImplementation(() =>
			Effect.sync(() => {
				statusAtAssembly = mocks.video?.status;
				return {};
			}),
		);

		const result = await complete();

		expect(result.status).toBe(200);
		expect(statusAtAssembly).toBe("processing");
		const encodeId = (mocks.video?.processing as { encodeId: string }).encodeId;
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(mocks.start).toHaveBeenCalledWith("workflow", [
			{ videoId: "video-1", encodeId },
		]);
	});

	it("refuses a second completion while another holds the claim, and leaves storage untouched", async () => {
		mocks.video = uploading({
			status: "processing",
			processing: processingState({ startedAt: Date.now(), probe: null }),
			updatedAt: new Date(),
		});

		const result = await complete();

		expect(result.status).toBe(409);
		expect(result.body).toMatchObject({ code: "completion_in_progress" });
		expect(result).toMatchObject({ headers: { "Retry-After": "5" } });
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.deleteObject).not.toHaveBeenCalled();
		expect(mocks.updates).toEqual([]);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("refuses to abort while a completion holds the claim, then lets that completion finish", async () => {
		mocks.video = uploading({
			status: "processing",
			processing: processingState({ startedAt: Date.now(), probe: null }),
			updatedAt: new Date(),
		});

		const aborted = await abortInfraUpload({
			appId: "app-1",
			videoId: "video-1",
			uploadId: "upload-1",
		});

		expect(aborted.status).toBe(409);
		expect(aborted.body).toMatchObject({ code: "completion_in_progress" });
		expect(mocks.video).toMatchObject({
			status: "processing",
			deletedAt: null,
		});
	});

	it("passes the video's saved resolution cap to admission", async () => {
		mocks.video = uploading({ maxResolutionTier: "1080p" });

		await completeInfraUpload({
			appId: "app-1",
			videoId: "video-1",
			uploadId: "upload-1",
			parts: [{ partNumber: 1, etag: "etag-1", size: 10_000_000 }],
			durationInSecs: 60,
			width: 3840,
			height: 2160,
		});

		expect(mocks.admission).toHaveBeenCalledTimes(2);
		for (const call of mocks.admission.mock.calls) {
			expect(call[1]).toMatchObject({ tier: "1080p" });
		}
	});

	it("still refuses a claim held for 14 minutes and says the wait can reach 15", async () => {
		const recently = Date.now() - 14 * 60 * 1000;
		mocks.video = uploading({
			status: "processing",
			processing: processingState({ startedAt: recently, probe: null }),
			updatedAt: new Date(recently),
		});

		const result = await complete();

		expect(result.status).toBe(409);
		expect(result.body).toMatchObject({
			hint: expect.stringContaining("up to 15 minutes"),
		});
		expect(mocks.updates).toEqual([]);
	});

	it("takes over a claim left by a completion that died before recording the video", async () => {
		const longAgo = Date.now() - 16 * 60 * 1000;
		mocks.video = uploading({
			status: "processing",
			processing: processingState({ startedAt: longAgo, probe: null }),
			updatedAt: new Date(longAgo),
		});

		const result = await complete();

		expect(result.status).toBe(200);
		expect(mocks.video).toMatchObject({ status: "processing", duration: 60 });
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("does not take over a claim on a video the pipeline is already encoding", async () => {
		const longAgo = Date.now() - 16 * 60 * 1000;
		mocks.video = developerVideo({
			status: "processing",
			duration: 60,
			processing: processingState({ startedAt: longAgo }),
			updatedAt: new Date(longAgo),
		});

		const result = await complete();

		expect(result).toEqual({ status: 200, body: { success: true } });
		expect(mocks.updates).toEqual([]);
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("gives the claim back when storage fails to assemble the file", async () => {
		mocks.video = uploading();
		mocks.complete.mockImplementation(() =>
			Effect.fail(new Error("storage down")),
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await complete();

		expect(result.status).toBe(500);
		expect(mocks.video).toMatchObject({
			status: "uploading",
			processing: null,
			duration: null,
		});
		expect(mocks.start).not.toHaveBeenCalled();
		errors.mockRestore();
	});

	it("gives the claim back and removes the file when the locked balance check refuses", async () => {
		mocks.video = uploading();
		mocks.admission
			.mockResolvedValueOnce({ allowed: true })
			.mockResolvedValueOnce({
				allowed: false,
				reason: "insufficient_credits",
			});

		const result = await complete();

		expect(result.status).toBe(402);
		expect(mocks.deleteObject).toHaveBeenCalledWith(
			"developer/app-1/video-1/video",
		);
		expect(mocks.video).toMatchObject({
			status: "uploading",
			processing: null,
			duration: null,
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});
});
