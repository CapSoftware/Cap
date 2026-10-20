import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { getSharePlaybackUrl } from "@/lib/share-playback";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	sign: vi.fn(),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));

vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

const video = {
	id: "video",
	owner: { id: "owner" },
	orgId: "organization",
	name: "Recording",
	public: true,
	source: { type: "desktopMP4" },
	metadata: null,
	bucket: "custom-bucket",
	storageIntegrationId: null,
	transcriptionStatus: "COMPLETE",
	width: 1920,
	height: 1080,
	duration: 60,
	createdAt: new Date("2026-09-09T00:00:00.000Z"),
	updatedAt: new Date("2026-09-09T00:00:00.000Z"),
} as unknown as Parameters<typeof getSharePlaybackUrl>[0];

describe("share page playback URL", () => {
	it.each(["desktopMP4", "webMP4"] as const)(
		"resolves %s through the existing storage access using the loaded video",
		async (type) => {
			mocks.sign.mockReturnValue(
				Effect.succeed("https://media.example.com/video.mp4"),
			);
			mocks.access.mockReturnValue(
				Effect.succeed([{ getSignedObjectUrl: mocks.sign }, Option.none()]),
			);
			expect(await getSharePlaybackUrl({ ...video, source: { type } })).toBe(
				"https://media.example.com/video.mp4",
			);
			expect(mocks.access).toHaveBeenCalledOnce();
			expect(mocks.access.mock.calls[0]?.[0]).toMatchObject({
				id: "video",
				ownerId: "owner",
				bucketId: Option.some("custom-bucket"),
				source: { type },
			});
			expect(mocks.sign).toHaveBeenCalledExactlyOnceWith(
				"owner/video/result.mp4",
			);
		},
	);

	it("retains the published output key and Google Drive integration for storage resolution", async () => {
		mocks.sign.mockReturnValue(
			Effect.succeed("https://media.example.com/output.mp4"),
		);
		mocks.access.mockReturnValue(
			Effect.succeed([{ getSignedObjectUrl: mocks.sign }, Option.none()]),
		);
		const publishedVideo = {
			...video,
			storageIntegrationId: "drive-integration" as NonNullable<
				typeof video.storageIntegrationId
			>,
			source: {
				type: "desktopMP4" as const,
				outputKey: "owner/video/.recording/outputs/generation/result.mp4",
			},
		};
		await getSharePlaybackUrl(publishedVideo);
		expect(mocks.access.mock.calls[0]?.[0]).toMatchObject({
			source: publishedVideo.source,
			storageIntegrationId: Option.some("drive-integration"),
		});
	});

	it("allows the player to use its existing route when storage resolution fails", async () => {
		mocks.access.mockReturnValue(Effect.fail(new Error("Storage unavailable")));
		expect(await getSharePlaybackUrl(video)).toBeNull();
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("keeps signing defects out of the streamed page", async () => {
		mocks.access.mockReturnValue(Effect.die(new Error("Signer configuration")));
		expect(await getSharePlaybackUrl(video)).toBeNull();
	});

	it("does not resolve storage when the loaded source is invalid", async () => {
		expect(
			await getSharePlaybackUrl({
				...video,
				name: null,
			} as unknown as typeof video),
		).toBeNull();
		expect(mocks.access).not.toHaveBeenCalled();
	});
});
