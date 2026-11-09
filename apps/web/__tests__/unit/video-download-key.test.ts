import { CurrentUser, Organisation, User, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	sign: vi.fn(),
	access: vi.fn(),
	userId: "owner",
	password: null as string | null,
	spacePasswords: [] as string[],
	verifiedPasswords: [] as string[],
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: () => Promise.resolve(mocks.rows.shift() ?? []) }),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () => Promise.resolve({ id: mocks.userId }),
}));
vi.mock("@cap/web-backend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/web-backend")>();
	class VideosPolicy extends Effect.Service<VideosPolicy>()("VideosPolicy", {
		sync: () => ({
			canViewLoaded: (
				video: Parameters<typeof actual.buildCanViewLoaded>[1],
				password: Option.Option<string>,
			) =>
				actual.buildCanViewLoaded(
					{
						repo: {
							getById: () => Effect.succeedNone,
							hasViewerGrant: () => Effect.succeed(false),
						},
						orgsRepo: {
							membershipForVideo: () =>
								Effect.succeed([{ membershipId: "member" }]),
							allowedEmailDomain: () => Effect.succeedNone,
						},
						spacesRepo: {
							membershipForVideo: () => Effect.succeedNone,
							passwordsForVideo: () =>
								Effect.succeed(
									mocks.spacePasswords.map((password) => ({ password })),
								),
						},
					},
					video,
					password,
				),
		}),
	}) {}
	return {
		findScreenshotObjectKey: actual.findScreenshotObjectKey,
		Storage: { getAccessForVideo: mocks.access },
		VideosPolicy,
		provideOptionalAuth: <A, E, R>(app: Effect.Effect<A, E, R>) =>
			app.pipe(
				Effect.provide(VideosPolicy.Default),
				Effect.provideService(CurrentUser, {
					id: User.UserId.make(mocks.userId),
					email: "member@example.com",
					activeOrganizationId:
						Organisation.OrganisationId.make("organization"),
					iconUrlOrKey: Option.none(),
				}),
				Effect.provideService(Video.VideoPasswordAttachment, {
					passwords: mocks.verifiedPasswords,
				}),
			),
	};
});
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: () => Promise.resolve(true),
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

import { getVideoDownloadInfo } from "@/actions/videos/download";

const screenshot = {
	id: "video",
	ownerId: "owner",
	orgId: "organization",
	name: "Diagram",
	public: true,
	isScreenshot: true,
	source: { type: "webMP4" },
	createdAt: new Date("2026-11-09T00:00:00Z"),
	updatedAt: new Date("2026-11-09T00:00:00Z"),
};

describe("current video download", () => {
	beforeEach(() => {
		mocks.rows = [];
		mocks.userId = "owner";
		mocks.password = null;
		mocks.spacePasswords = [];
		mocks.verifiedPasswords = [];
		mocks.sign.mockReset();
		mocks.access.mockReset();
	});

	it.each(["current", "original"] as const)(
		"signs the %s MP4 key",
		async (variant) => {
			const outputKey = "owner/video/.recording/outputs/generation/result.mp4";
			const originalKey = "owner/video/.recording/sources/original.mp4";
			mocks.rows = [
				[
					{
						id: "video",
						ownerId: "owner",
						orgId: "organization",
						name: "Recording",
						public: true,
						source: { type: "desktopMP4", outputKey },
						metadata: null,
						bucket: "custom-bucket",
						storageIntegrationId: null,
						folderId: null,
						transcriptionStatus: null,
						width: null,
						height: null,
						duration: null,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				],
				variant === "current" ? [] : [{ sourceKey: originalKey }],
			];
			mocks.sign.mockReturnValue(
				Effect.succeed("https://media.example.com/video.mp4"),
			);
			mocks.access.mockReturnValue(
				Effect.succeed([
					{
						headObject: () => Effect.succeed({}),
						getSignedDownloadUrl: mocks.sign,
					},
				]),
			);

			expect(
				await getVideoDownloadInfo(Video.VideoId.make("video"), variant),
			).toMatchObject({
				success: true,
			});
			expect(mocks.sign).toHaveBeenCalledExactlyOnceWith(
				variant === "current" ? outputKey : originalKey,
				variant === "current" ? "Recording.mp4" : "Recording (original).mp4",
			);
		},
	);

	it.each([
		{ sourceType: "webMP4", extension: "png", upload: { phase: "uploading" } },
		{ sourceType: "desktopMP4", extension: "jpg", upload: undefined },
	])(
		"downloads a $sourceType screenshot as $extension",
		async ({ sourceType, extension, upload }) => {
			const imageKey = `owner/video/screenshot/screen-capture.${extension}`;
			const downloadUrl = `https://media.example.com/image.${extension}`;
			const listObjects = vi.fn(() =>
				Effect.succeed({ Contents: [{ Key: imageKey }] }),
			);
			mocks.rows = [
				[{ ...screenshot, source: { type: sourceType } }],
				upload ? [upload] : [],
			];
			mocks.sign.mockReturnValue(Effect.succeed(downloadUrl));
			mocks.access.mockReturnValue(
				Effect.succeed([
					{
						listObjects,
						headObject: (key: string) =>
							key === imageKey
								? Effect.succeed({})
								: Effect.fail(new Error("NoSuchKey")),
						getSignedDownloadUrl: mocks.sign,
					},
				]),
			);

			expect(await getVideoDownloadInfo(Video.VideoId.make("video"))).toEqual({
				success: true,
				downloadUrl,
				filename: `Diagram.${extension}`,
			});
			expect(listObjects).toHaveBeenCalledExactlyOnceWith({
				prefix: "owner/video/",
			});
			expect(mocks.sign).toHaveBeenCalledExactlyOnceWith(
				imageKey,
				`Diagram.${extension}`,
			);
		},
	);

	it("does not sign a download when the screenshot is missing", async () => {
		mocks.rows = [[screenshot], []];
		mocks.access.mockReturnValue(
			Effect.succeed([
				{
					listObjects: () => Effect.succeed({ Contents: [] }),
					headObject: () => Effect.fail(new Error("NoSuchKey")),
					getSignedDownloadUrl: mocks.sign,
				},
			]),
		);

		expect(
			await getVideoDownloadInfo(Video.VideoId.make("video")),
		).toMatchObject({
			success: false,
		});
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("checks screenshot passwords before accessing storage", async () => {
		mocks.userId = "member";
		mocks.rows = [[{ ...screenshot, password: "video-hash" }], []];
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(
			await getVideoDownloadInfo(Video.VideoId.make("video")),
		).toMatchObject({
			success: false,
		});
		expect(mocks.access).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("keeps an unfinished video blocked", async () => {
		mocks.rows = [
			[{ ...screenshot, isScreenshot: false }],
			[{ phase: "uploading" }],
		];

		expect(await getVideoDownloadInfo(Video.VideoId.make("video"))).toEqual({
			success: false,
			error: "Video is still processing. Try again once it has finished.",
		});
		expect(mocks.access).not.toHaveBeenCalled();
	});
});

describe.each(["current", "original"] as const)(
	"%s download passwords",
	(variant) => {
		beforeEach(() => {
			mocks.userId = "member";
			mocks.password = "video-hash";
			mocks.spacePasswords = [];
			mocks.verifiedPasswords = [];
			mocks.sign.mockReturnValue(
				Effect.succeed("https://media.example.com/video.mp4"),
			);
			mocks.access.mockReturnValue(
				Effect.succeed([
					{
						headObject: () => Effect.succeed({}),
						getSignedDownloadUrl: mocks.sign,
					},
				]),
			);
			vi.spyOn(console, "error").mockImplementation(() => {});
		});

		const download = () => {
			mocks.rows = [
				[
					{
						id: "video",
						ownerId: "owner",
						orgId: "organization",
						name: "Recording",
						public: true,
						password: mocks.password,
						source: { type: "desktopMP4" },
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				],
				variant === "current" ? [] : [{ sourceKey: "owner/video/source.mp4" }],
			];
			return getVideoDownloadInfo(Video.VideoId.make("video"), variant);
		};

		it.each([
			{ verified: [] },
			{ verified: ["unrelated-hash"] },
			{ verified: ["old-video-hash"] },
		])(
			"blocks unverified passwords %j before storage access",
			async ({ verified }) => {
				mocks.verifiedPasswords = verified;
				expect(await download()).toMatchObject({ success: false });
				expect(mocks.access).not.toHaveBeenCalled();
				expect(mocks.sign).not.toHaveBeenCalled();
			},
		);

		it("allows a verified video password", async () => {
			mocks.verifiedPasswords = ["video-hash"];
			expect(await download()).toMatchObject({ success: true });
		});

		it("blocks an inherited space password until verified", async () => {
			mocks.password = null;
			mocks.spacePasswords = ["space-hash"];
			expect(await download()).toMatchObject({ success: false });
			expect(mocks.access).not.toHaveBeenCalled();
			mocks.verifiedPasswords = ["space-hash"];
			expect(await download()).toMatchObject({ success: true });
		});

		it("allows a member after password removal", async () => {
			mocks.password = null;
			expect(await download()).toMatchObject({ success: true });
		});

		it("allows the owner without password verification", async () => {
			mocks.userId = "owner";
			expect(await download()).toMatchObject({ success: true });
		});
	},
);
