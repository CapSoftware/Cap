import { Video } from "@cap/web-domain";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isVideoStorageKey } from "@/lib/video-storage-key";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getCurrentUser: vi.fn(),
	getAccessForVideo: vi.fn(),
	headObject: vi.fn(),
	startVideoProcessingWorkflow: vi.fn(),
	selectWhere: vi.fn(),
	updateSet: vi.fn(),
	lockedFor: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: mocks.db,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id" },
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: mocks.getAccessForVideo,
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: (field: unknown, value: unknown) => ({ field, value }),
}));

vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: mocks.startVideoProcessingWorkflow,
}));

const ownerId = "user_owner1";
const videoId = Video.VideoId.make("video_abc123");
const video = { id: videoId, ownerId };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCurrentUser.mockResolvedValue({ id: ownerId });
	mocks.headObject.mockReturnValue({
		pipe: () => Promise.resolve({ ContentLength: 1024 }),
	});
	mocks.getAccessForVideo.mockReturnValue({
		pipe: () => Promise.resolve([{ headObject: mocks.headObject }]),
	});
	mocks.startVideoProcessingWorkflow.mockResolvedValue("started");
	mocks.updateSet.mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
	mocks.lockedFor.mockResolvedValue([]);
	mocks.transaction.mockImplementation((run: (tx: unknown) => unknown) =>
		run({
			select: () => ({
				from: () => ({
					where: () => ({
						for: mocks.lockedFor,
					}),
				}),
			}),
			update: () => ({
				set: mocks.updateSet,
			}),
		}),
	);
	mocks.db.mockReturnValue({
		select: () => ({
			from: () => ({
				where: mocks.selectWhere,
			}),
		}),
		update: () => ({
			set: mocks.updateSet,
		}),
		transaction: mocks.transaction,
	});
});

describe("isVideoStorageKey", () => {
	it("accepts the upload paths the server issues for a video", () => {
		for (const subpath of [
			"raw-upload.mp4",
			"raw-upload.webm",
			"raw-upload.mov",
			"agent-upload.mp4",
			"verified-upload-AbC_123-xyz.mp4",
			"result.mp4",
			".recording/sources/source-1.mp4",
		]) {
			expect(isVideoStorageKey(video, `${ownerId}/${videoId}/${subpath}`)).toBe(
				true,
			);
		}
	});

	it("rejects keys outside the video's upload path", () => {
		for (const key of [
			`other_user/${videoId}/raw-upload.mp4`,
			`${ownerId}/other_video/raw-upload.mp4`,
			`${ownerId}/${videoId}-extra/raw-upload.mp4`,
			`${ownerId}/${videoId}/`,
			`${ownerId}/${videoId}`,
			"raw-upload.mp4",
			"",
		]) {
			expect(isVideoStorageKey(video, key)).toBe(false);
		}
	});

	it("rejects relative segments, leading slashes and backslashes", () => {
		for (const key of [
			`${ownerId}/${videoId}/../../other_user/other_video/raw-upload.mp4`,
			`${ownerId}/${videoId}/./raw-upload.mp4`,
			`${ownerId}/${videoId}//raw-upload.mp4`,
			`/${ownerId}/${videoId}/raw-upload.mp4`,
			`${ownerId}/${videoId}/..\\raw-upload.mp4`,
			`${ownerId}/${videoId}/sub\\raw-upload.mp4`,
		]) {
			expect(isVideoStorageKey(video, key)).toBe(false);
		}
		expect(
			isVideoStorageKey({ id: videoId, ownerId: "" }, `/${videoId}/raw.mp4`),
		).toBe(false);
	});
});

describe("triggerVideoProcessing", () => {
	const loadAction = async () =>
		(await import("@/actions/video/trigger-processing")).triggerVideoProcessing;

	it("starts processing for the video's own upload in the default bucket", async () => {
		mocks.selectWhere.mockResolvedValue([{ ...video, bucket: null }]);
		const triggerVideoProcessing = await loadAction();

		await expect(
			triggerVideoProcessing({
				videoId,
				rawFileKey: `${ownerId}/${videoId}/raw-upload.mp4`,
				bucketId: null,
			}),
		).resolves.toEqual({ success: true });
		expect(mocks.headObject).toHaveBeenCalledWith(
			`${ownerId}/${videoId}/raw-upload.mp4`,
		);
		expect(mocks.startVideoProcessingWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				rawFileKey: `${ownerId}/${videoId}/raw-upload.mp4`,
				bucketId: null,
			}),
		);
	});

	it("starts processing for the video's own upload in a custom bucket", async () => {
		mocks.selectWhere.mockResolvedValue([{ ...video, bucket: "bucket_1" }]);
		const triggerVideoProcessing = await loadAction();

		await expect(
			triggerVideoProcessing({
				videoId,
				rawFileKey: `${ownerId}/${videoId}/raw-upload.mp4`,
				bucketId: "bucket_1",
			}),
		).resolves.toEqual({ success: true });
		expect(mocks.startVideoProcessingWorkflow).toHaveBeenCalledOnce();
	});

	it("rejects keys outside the video's upload path", async () => {
		mocks.selectWhere.mockResolvedValue([{ ...video, bucket: null }]);
		const triggerVideoProcessing = await loadAction();

		for (const rawFileKey of [
			"other_user/other_video/raw-upload.mp4",
			`${ownerId}/other_video/raw-upload.mp4`,
			`${ownerId}/${videoId}/../../other_user/other_video/raw-upload.mp4`,
			`/${ownerId}/${videoId}/raw-upload.mp4`,
		]) {
			await expect(
				triggerVideoProcessing({ videoId, rawFileKey, bucketId: null }),
			).rejects.toThrow("Upload file does not belong to this video");
		}
		expect(mocks.headObject).not.toHaveBeenCalled();
		expect(mocks.startVideoProcessingWorkflow).not.toHaveBeenCalled();
	});

	it("rejects a bucket that does not match the video", async () => {
		const triggerVideoProcessing = await loadAction();
		const rawFileKey = `${ownerId}/${videoId}/raw-upload.mp4`;

		mocks.selectWhere.mockResolvedValue([{ ...video, bucket: null }]);
		await expect(
			triggerVideoProcessing({ videoId, rawFileKey, bucketId: "bucket_1" }),
		).rejects.toThrow("Upload bucket does not match this video");

		mocks.selectWhere.mockResolvedValue([{ ...video, bucket: "bucket_1" }]);
		await expect(
			triggerVideoProcessing({ videoId, rawFileKey, bucketId: null }),
		).rejects.toThrow("Upload bucket does not match this video");
		await expect(
			triggerVideoProcessing({ videoId, rawFileKey, bucketId: "bucket_2" }),
		).rejects.toThrow("Upload bucket does not match this video");

		expect(mocks.headObject).not.toHaveBeenCalled();
		expect(mocks.startVideoProcessingWorkflow).not.toHaveBeenCalled();
	});
});

describe("video metadata route", () => {
	const put = async (metadata: unknown) => {
		const { PUT } = await import("@/app/api/video/metadata/route");
		return PUT(
			new NextRequest("http://localhost:3000/api/video/metadata", {
				method: "PUT",
				body: JSON.stringify({ videoId, metadata }),
			}),
		);
	};

	it("keeps the stored agent upload state when updating metadata", async () => {
		const agentUpload = {
			state: "accepted",
			rawFileKey: `${ownerId}/${videoId}/verified-upload-abc.mp4`,
		};
		mocks.selectWhere.mockResolvedValue([
			{ ...video, metadata: { sourceName: "a.mp4", agentUpload } },
		]);
		mocks.lockedFor.mockResolvedValue([
			{ metadata: { sourceName: "a.mp4", agentUpload } },
		]);

		const response = await put({
			sourceName: "b.mp4",
			agentUpload: { state: "accepted", rawFileKey: "other/key.mp4" },
		});

		expect(response.status).toBe(200);
		expect(mocks.updateSet).toHaveBeenCalledWith({
			metadata: { sourceName: "b.mp4", agentUpload },
		});
	});

	it("keeps an agent upload accepted after the initial read when metadata is written", async () => {
		const accepted = {
			state: "accepted",
			rawFileKey: `${ownerId}/${videoId}/verified-upload-abc.mp4`,
		};
		mocks.selectWhere.mockResolvedValue([
			{
				...video,
				metadata: { sourceName: "a.mp4", agentUpload: { state: "pending" } },
			},
		]);
		mocks.lockedFor.mockResolvedValue([
			{ metadata: { sourceName: "a.mp4", agentUpload: accepted } },
		]);

		const response = await put({ sourceName: "b.mp4" });

		expect(response.status).toBe(200);
		expect(mocks.transaction).toHaveBeenCalledOnce();
		expect(mocks.lockedFor).toHaveBeenCalledWith("update");
		expect(mocks.updateSet).toHaveBeenCalledWith({
			metadata: { sourceName: "b.mp4", agentUpload: accepted },
		});
	});

	it("does not add an agent upload state from the request", async () => {
		mocks.selectWhere.mockResolvedValue([{ ...video, metadata: null }]);
		mocks.lockedFor.mockResolvedValue([{ metadata: null }]);

		const response = await put({
			customCreatedAt: "2026-01-01T00:00:00.000Z",
			agentUpload: { state: "accepted", rawFileKey: "other/key.mp4" },
		});

		expect(response.status).toBe(200);
		expect(mocks.updateSet).toHaveBeenCalledWith({
			metadata: { customCreatedAt: "2026-01-01T00:00:00.000Z" },
		});
	});

	it("rejects metadata that is not an object", async () => {
		mocks.selectWhere.mockResolvedValue([{ ...video, metadata: null }]);

		const response = await put(["not", "an", "object"]);

		expect(response.status).toBe(400);
		expect(mocks.updateSet).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
});
