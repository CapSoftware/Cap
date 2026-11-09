import { CurrentUser, Organisation, User, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Settings = Record<string, unknown> | null;

const mocks = vi.hoisted(() => ({
	tables: new Map<string, unknown[]>(),
	sign: vi.fn(),
	access: vi.fn(),
	viewer: null as { id: string; email: string } | null,
	isMember: false,
	shareLimited: false,
	allowedEmailDomain: null as string | null,
	spacePasswords: [] as string[],
	verifiedPasswords: [] as string[],
}));

vi.mock("@cap/database", async () => {
	const { getTableName } = await import("drizzle-orm");
	return {
		db: () => ({
			select: () => ({
				from: (table: Parameters<typeof getTableName>[0]) => ({
					where: () =>
						Promise.resolve(mocks.tables.get(getTableName(table)) ?? []),
				}),
			}),
		}),
	};
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () => Promise.resolve(mocks.viewer),
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
								Effect.succeed(
									mocks.isMember ? [{ membershipId: "member" }] : [],
								),
							allowedEmailDomain: () =>
								Effect.succeed(Option.fromNullable(mocks.allowedEmailDomain)),
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
		Storage: { getAccessForVideo: mocks.access },
		VideosPolicy,
		provideOptionalAuth: <A, E, R>(app: Effect.Effect<A, E, R>) => {
			const withPolicy = app.pipe(
				Effect.provide(VideosPolicy.Default),
				Effect.provideService(Video.VideoPasswordAttachment, {
					passwords: mocks.verifiedPasswords,
				}),
			);
			const viewer = mocks.viewer;
			return viewer
				? withPolicy.pipe(
						Effect.provideService(CurrentUser, {
							id: User.UserId.make(viewer.id),
							email: viewer.email,
							activeOrganizationId: Organisation.OrganisationId.make(
								"viewer-organization",
							),
							iconUrlOrKey: Option.none(),
						}),
					)
				: withPolicy;
		},
	};
});
vi.mock("@/lib/video-download-permissions", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/video-download-permissions")
	>()),
	canUserDownloadVideo: () => Promise.resolve(mocks.isMember),
}));
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoLockedByShareableLinkLimit: () => Promise.resolve(mocks.shareLimited),
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

import { getVideoDownloadInfo } from "@/actions/videos/download";

const VIDEO = Video.VideoId.make("video");
const CURRENT_KEY = "owner/video/result.mp4";
const ANONYMOUS_DENIAL = "Missing required data for downloading video";
const SIGNED_IN_DENIAL = "You don't have permission to download this video";
const stranger = { id: "stranger", email: "stranger@elsewhere.test" };

const setVideo = ({
	videoSettings = null,
	organizationSettings = null,
	isPublic = true,
	password = null,
	organizationDeleted = false,
}: {
	videoSettings?: Settings;
	organizationSettings?: Settings;
	isPublic?: boolean;
	password?: string | null;
	organizationDeleted?: boolean;
} = {}) => {
	mocks.tables.set("videos", [
		{
			id: "video",
			ownerId: "owner",
			orgId: "organization",
			name: "Recording",
			public: isPublic,
			password,
			settings: videoSettings,
			source: { type: "desktopMP4" },
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	]);
	mocks.tables.set(
		"organizations",
		organizationDeleted ? [] : [{ settings: organizationSettings }],
	);
	mocks.tables.set("video_edits", [{ sourceKey: "owner/video/source.mp4" }]);
};

const expectNoStorageAccess = () => {
	expect(mocks.access).not.toHaveBeenCalled();
	expect(mocks.sign).not.toHaveBeenCalled();
};

beforeEach(() => {
	mocks.tables.clear();
	mocks.viewer = null;
	mocks.isMember = false;
	mocks.shareLimited = false;
	mocks.allowedEmailDomain = null;
	mocks.spacePasswords = [];
	mocks.verifiedPasswords = [];
	mocks.sign.mockReset();
	mocks.access.mockReset();
	mocks.sign.mockReturnValue(
		Effect.succeed("https://media.example.com/video.mp4"),
	);
	mocks.access.mockReturnValue(
		Effect.succeed([
			{
				headObject: () => Effect.succeed({}),
				getSignedObjectUrl: mocks.sign,
				getSignedDownloadUrl: mocks.sign,
			},
		]),
	);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("viewer downloads are off by default", () => {
	it.each([
		["no settings at all", null, null],
		["empty settings", {}, {}],
		["the organization turned it off", null, { allowViewerDownloads: false }],
		[
			"a value that is not a boolean",
			{ allowViewerDownloads: "yes" },
			{ allowViewerDownloads: 1 },
		],
	])(
		"denies a signed-out viewer with %s",
		async (_label, videoSettings, organizationSettings) => {
			setVideo({ videoSettings, organizationSettings });
			await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(
				ANONYMOUS_DENIAL,
			);
			expectNoStorageAccess();
		},
	);

	it("denies a signed-in viewer who is not a member", async () => {
		mocks.viewer = stranger;
		setVideo();
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(SIGNED_IN_DENIAL);
		expectNoStorageAccess();
	});

	it("denies a signed-out viewer when the video does not exist", async () => {
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();
	});

	it.each(["current", "original"] as const)(
		"still lets a member download the %s video",
		async (variant) => {
			mocks.viewer = { id: "member", email: "member@example.com" };
			mocks.isMember = true;
			setVideo();
			expect(await getVideoDownloadInfo(VIDEO, variant)).toMatchObject({
				success: true,
			});
		},
	);
});

describe("viewer downloads turned on", () => {
	const enabled = { allowViewerDownloads: true };

	it("lets a signed-out viewer download a public video", async () => {
		setVideo({ organizationSettings: enabled });
		expect(await getVideoDownloadInfo(VIDEO)).toEqual({
			success: true,
			downloadUrl: "https://media.example.com/video.mp4",
			filename: "Recording.mp4",
		});
		expect(mocks.sign.mock.calls[0]?.[0]).toBe(CURRENT_KEY);
	});

	it("lets a signed-in viewer who is not a member download", async () => {
		mocks.viewer = stranger;
		setVideo({ organizationSettings: enabled });
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("lets one video opt in while the organization default is off", async () => {
		setVideo({ videoSettings: enabled });
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("lets one video opt out while the organization default is on", async () => {
		setVideo({
			videoSettings: { allowViewerDownloads: false },
			organizationSettings: enabled,
		});
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();
	});

	it("never gives a viewer the original video", async () => {
		setVideo({ organizationSettings: enabled });
		await expect(getVideoDownloadInfo(VIDEO, "original")).rejects.toThrow(
			ANONYMOUS_DENIAL,
		);
		expectNoStorageAccess();
	});

	it("denies a private video", async () => {
		setVideo({ organizationSettings: enabled, isPublic: false });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		mocks.viewer = stranger;
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(SIGNED_IN_DENIAL);
		expectNoStorageAccess();
	});

	it("requires the video password to be verified first", async () => {
		setVideo({ organizationSettings: enabled, password: "video-hash" });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		mocks.verifiedPasswords = ["another-hash"];
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();

		mocks.verifiedPasswords = ["video-hash"];
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("requires an inherited space password to be verified first", async () => {
		mocks.spacePasswords = ["space-hash"];
		setVideo({ organizationSettings: enabled });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();

		mocks.verifiedPasswords = ["space-hash"];
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("keeps the organization email restriction in front of the download", async () => {
		mocks.allowedEmailDomain = "example.com";
		setVideo({ organizationSettings: enabled });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		mocks.viewer = stranger;
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(SIGNED_IN_DENIAL);
		expectNoStorageAccess();

		mocks.viewer = { id: "colleague", email: "colleague@example.com" };
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("denies a video locked by the free plan share limit", async () => {
		mocks.shareLimited = true;
		setVideo({ organizationSettings: enabled });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();
	});

	it("denies a video whose organization was deleted", async () => {
		setVideo({ videoSettings: enabled, organizationDeleted: true });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();
	});

	it("does not reveal processing state before the view gates pass", async () => {
		setVideo({ organizationSettings: enabled, password: "video-hash" });
		mocks.tables.set("video_uploads", [{ phase: "uploading" }]);
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);

		mocks.verifiedPasswords = ["video-hash"];
		expect(await getVideoDownloadInfo(VIDEO)).toEqual({
			success: false,
			error: "Video is still processing. Try again once it has finished.",
		});
	});
});
