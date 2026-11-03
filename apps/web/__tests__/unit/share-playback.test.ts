import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	canStartPlaybackInHtml,
	getSharePlaybackSource,
	getSharePlaybackUrl,
} from "@/lib/share-playback";

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
		expect(mocks.sign).toHaveBeenCalledExactlyOnceWith(
			publishedVideo.source.outputKey,
		);
	});

	it("signs the audio leveled output when it is the published source", async () => {
		mocks.sign.mockReturnValue(
			Effect.succeed("https://media.example.com/audio.mp4"),
		);
		mocks.access.mockReturnValue(
			Effect.succeed([{ getSignedObjectUrl: mocks.sign }, Option.none()]),
		);
		const outputKey = "owner/video/.recording/outputs/generation/result.mp4";
		const audioLevelOutputKey =
			"owner/video/.recording/outputs/audio-quality-v3/result.mp4";
		await getSharePlaybackUrl({
			...video,
			source: {
				type: "desktopMP4",
				outputKey,
				audioLevelSourceKey: outputKey,
				audioLevelOutputKey,
			},
		});
		expect(mocks.sign).toHaveBeenCalledExactlyOnceWith(audioLevelOutputKey);
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

describe("share page playback source storage", () => {
	const signed = "https://media.example.com/video.mp4";
	type Case = {
		name: string;
		bucket: typeof video.bucket;
		storageIntegrationId: typeof video.storageIntegrationId;
		customBucket: Option.Option<{ id: string }>;
		defaultStorage: boolean;
	};
	const cases: Case[] = [
		{
			name: "Cap's own bucket",
			bucket: null,
			storageIntegrationId: null,
			customBucket: Option.none(),
			defaultStorage: true,
		},
		{
			name: "a custom bucket",
			bucket: video.bucket,
			storageIntegrationId: null,
			customBucket: Option.some({ id: "custom-bucket" }),
			defaultStorage: false,
		},
		{
			name: "a storage integration",
			bucket: null,
			storageIntegrationId: "drive-integration" as NonNullable<
				typeof video.storageIntegrationId
			>,
			customBucket: Option.none(),
			defaultStorage: false,
		},
	];

	it.each(cases)(
		"reports $name",
		async ({ bucket, storageIntegrationId, customBucket, defaultStorage }) => {
			mocks.sign.mockReturnValue(Effect.succeed(signed));
			mocks.access.mockReturnValue(
				Effect.succeed([{ getSignedObjectUrl: mocks.sign }, customBucket]),
			);
			expect(
				await getSharePlaybackSource({
					...video,
					bucket,
					storageIntegrationId,
				}),
			).toEqual({ url: signed, defaultStorage });
		},
	);
});

describe("starting playback from the HTML", () => {
	it.each([
		[
			"Chrome on macOS",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
			true,
		],
		[
			"Edge on Windows",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
			true,
		],
		[
			"Firefox on macOS",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 15.7; rv:144.0) Gecko/20100101 Firefox/144.0",
			true,
		],
		[
			"Chrome on Android",
			"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
			true,
		],
		[
			"Safari on iPhone",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1",
			false,
		],
		[
			"Chrome on iPad",
			"Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
			false,
		],
		[
			"Safari on macOS, which iPadOS also reports",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
			false,
		],
		["no user agent", null, false],
	] as const)("%s: %s", (_name, userAgent, expected) => {
		expect(canStartPlaybackInHtml(userAgent)).toBe(expected);
	});
});
