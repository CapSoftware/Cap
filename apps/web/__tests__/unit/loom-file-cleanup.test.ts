import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	where: vi.fn(),
	access: vi.fn(),
	head: vi.fn(),
	remove: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: mocks.where }) }),
	}),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));

describe("completed Loom file cleanup", () => {
	const input = {
		videoId: "existing-video",
		userId: "owner-id",
		rawFileKey: "owner-id/existing-video/raw-upload.mp4",
	};

	beforeEach(() => {
		vi.resetAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.where.mockResolvedValue([
			{ id: input.videoId, ownerId: input.userId },
		]);
		mocks.access.mockImplementation(() =>
			Effect.succeed([{ headObject: mocks.head, deleteObject: mocks.remove }]),
		);
		mocks.head.mockImplementation(() => Effect.succeed({ ContentLength: 100 }));
		mocks.remove.mockImplementation(() => Effect.void);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("removes only the owned source after finding a completed output", async () => {
		const { cleanupLoomFileSource } = await import("@/lib/loom-file-cleanup");
		await cleanupLoomFileSource(input);
		expect(mocks.head).toHaveBeenCalledExactlyOnceWith(
			"owner-id/existing-video/result.mp4",
		);
		expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(input.rawFileKey);
		const [headOrder = Infinity] = mocks.head.mock.invocationCallOrder;
		const [removeOrder = 0] = mocks.remove.mock.invocationCallOrder;
		expect(headOrder).toBeLessThan(removeOrder);
	});

	it.each([
		"owner-id/existing-video/result.mp4",
		"another-owner/existing-video/raw-upload.mp4",
		"owner-id/another-video/raw-upload.mp4",
	])("never removes an output or unrelated source: %s", async (rawFileKey) => {
		const { cleanupLoomFileSource } = await import("@/lib/loom-file-cleanup");
		await cleanupLoomFileSource({ ...input, rawFileKey });
		expect(mocks.access).not.toHaveBeenCalled();
		expect(mocks.remove).not.toHaveBeenCalled();
	});

	it.each([
		{ records: [] },
		{ records: [{ id: input.videoId, ownerId: "another-owner" }] },
	])(
		"keeps the source if its recording is gone or ownership changed",
		async ({ records }) => {
			mocks.where.mockResolvedValue(records);
			const { cleanupLoomFileSource } = await import("@/lib/loom-file-cleanup");
			await cleanupLoomFileSource(input);
			expect(mocks.access).not.toHaveBeenCalled();
			expect(mocks.remove).not.toHaveBeenCalled();
		},
	);

	it.each([0, -1, undefined])(
		"keeps the source when the output has no positive size: %s",
		async (ContentLength) => {
			mocks.head.mockImplementation(() => Effect.succeed({ ContentLength }));
			const { cleanupLoomFileSource } = await import("@/lib/loom-file-cleanup");
			await cleanupLoomFileSource(input);
			expect(mocks.remove).not.toHaveBeenCalled();
		},
	);

	it("keeps the source if storage cannot confirm the output", async () => {
		mocks.head.mockImplementation(() =>
			Effect.fail(new Error("Storage unavailable")),
		);
		const { cleanupLoomFileSource } = await import("@/lib/loom-file-cleanup");
		await expect(cleanupLoomFileSource(input)).resolves.toBeUndefined();
		expect(mocks.remove).not.toHaveBeenCalled();
	});

	it("does not fail a completed import when source cleanup fails", async () => {
		mocks.remove.mockImplementation(() =>
			Effect.fail(new Error("Cleanup unavailable")),
		);
		const { cleanupLoomFileSource } = await import("@/lib/loom-file-cleanup");
		await expect(cleanupLoomFileSource(input)).resolves.toBeUndefined();
		expect(mocks.remove).toHaveBeenCalledOnce();
	});
});
