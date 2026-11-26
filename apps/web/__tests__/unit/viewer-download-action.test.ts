import type { VideosPolicy as VideosPolicyService } from "@cap/web-backend";
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
	rateLimited: false,
	linkOpenToAnyone: false,
	allowedEmailDomain: null as string | null,
	spacePasswords: [] as string[],
	verifiedPasswords: [] as string[],
}));

vi.mock("server-only", () => ({}));
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
	getCurrentUser: () =>
		Promise.resolve(
			mocks.viewer && {
				...mocks.viewer,
				activeOrganizationId: "viewer-organization",
				image: null,
			},
		),
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
							isLinkOpenToAnyone: () => Effect.succeed(mocks.linkOpenToAnyone),
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
		makeCurrentUser: actual.makeCurrentUser,
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
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { VIEWER_DOWNLOAD: "rl_viewer_download" },
	isRateLimited: () => Promise.resolve(mocks.rateLimited),
}));
vi.mock("@/lib/server", async () => {
	const backend = await import("@cap/web-backend");
	return {
		runPromise: <A, E>(
			effect: Effect.Effect<
				A,
				E,
				VideosPolicyService | Video.VideoPasswordAttachment
			>,
		) =>
			effect.pipe(
				Effect.provide(backend.VideosPolicy.Default),
				Effect.provideService(Video.VideoPasswordAttachment, {
					passwords: mocks.verifiedPasswords,
				}),
				Effect.runPromise,
			),
	};
});

import { getVideoDownloadInfo } from "@/actions/videos/download";
import { currentVideoDownloadAccess } from "@/lib/video-download-access";

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
	sourceType = "desktopMP4",
}: {
	sourceType?: string;
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
			source: { type: sourceType },
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
	mocks.rateLimited = false;
	mocks.linkOpenToAnyone = false;
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

const OFF = { disableDownloads: true };
const member = { id: "member", email: "member@example.com" };

describe("viewer downloads are on by default", () => {
	it.each([
		["no settings at all", null, null],
		["empty settings", {}, {}],
		[
			"settings written before this change",
			{ disableComments: true },
			{ disableReactions: true },
		],
		[
			"a value that is not true",
			{ disableDownloads: "yes" },
			{ disableDownloads: 1 },
		],
	])(
		"lets a signed-out viewer download a public video with %s",
		async (_label, videoSettings, organizationSettings) => {
			setVideo({ videoSettings, organizationSettings });
			expect(await getVideoDownloadInfo(VIDEO)).toEqual({
				success: true,
				downloadUrl: "https://media.example.com/video.mp4",
				filename: "Recording.mp4",
			});
			expect(mocks.sign.mock.calls[0]?.[0]).toBe(CURRENT_KEY);
		},
	);

	it("lets a signed-in viewer who is not a member download", async () => {
		mocks.viewer = stranger;
		setVideo();
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("never gives a viewer the original video", async () => {
		setVideo();
		await expect(getVideoDownloadInfo(VIDEO, "original")).rejects.toThrow(
			ANONYMOUS_DENIAL,
		);
		mocks.viewer = stranger;
		await expect(getVideoDownloadInfo(VIDEO, "original")).rejects.toThrow(
			SIGNED_IN_DENIAL,
		);
		expectNoStorageAccess();
	});

	it.each(["MediaConvert", "local"])(
		"gives viewers no file for a %s cap, which has no published MP4",
		async (sourceType) => {
			setVideo({ sourceType });
			expect(await getVideoDownloadInfo(VIDEO)).toEqual({
				success: false,
				error: "Video file is not available for download yet.",
			});
			mocks.viewer = stranger;
			expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({
				success: false,
			});
			expectNoStorageAccess();

			mocks.viewer = member;
			mocks.isMember = true;
			expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({
				success: true,
			});
			expect(mocks.sign.mock.calls[0]?.[0]).toBe(CURRENT_KEY);
		},
	);

	it("denies a signed-out viewer when the video does not exist", async () => {
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();
	});
});

describe("turning downloads off", () => {
	it.each([
		["the organization", null, OFF],
		["the cap", OFF, null],
		[
			"the organization, even when the cap says on",
			{ disableDownloads: false },
			OFF,
		],
	])(
		"refuses viewers when %s turns it off",
		async (_label, videoSettings, organizationSettings) => {
			setVideo({ videoSettings, organizationSettings });
			await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(
				ANONYMOUS_DENIAL,
			);
			mocks.viewer = stranger;
			await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(
				SIGNED_IN_DENIAL,
			);
			expectNoStorageAccess();
			expect(await currentVideoDownloadAccess(VIDEO, Option.none())).toBe(
				"denied",
			);
		},
	);

	it.each(["current", "original"] as const)(
		"keeps the %s video downloadable for members",
		async (variant) => {
			mocks.viewer = member;
			mocks.isMember = true;
			setVideo({ videoSettings: OFF, organizationSettings: OFF });
			expect(await getVideoDownloadInfo(VIDEO, variant)).toMatchObject({
				success: true,
			});
		},
	);
});

describe("the view gates still apply to viewers", () => {
	it("denies a private video", async () => {
		setVideo({ isPublic: false });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		mocks.viewer = stranger;
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(SIGNED_IN_DENIAL);
		expectNoStorageAccess();
	});

	it("requires the video password to be verified first", async () => {
		setVideo({ password: "video-hash" });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expect(await currentVideoDownloadAccess(VIDEO, Option.none())).toBe(
			"denied",
		);
		mocks.verifiedPasswords = ["another-hash"];
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();

		mocks.verifiedPasswords = ["video-hash"];
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
		expect(await currentVideoDownloadAccess(VIDEO, Option.none())).toBe(
			"viewer",
		);
	});

	it("requires an inherited space password to be verified first", async () => {
		mocks.spacePasswords = ["space-hash"];
		setVideo();
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();

		mocks.verifiedPasswords = ["space-hash"];
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("keeps the organization email restriction in front of the download", async () => {
		mocks.allowedEmailDomain = "example.com";
		setVideo();
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		mocks.viewer = stranger;
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(SIGNED_IN_DENIAL);
		expectNoStorageAccess();

		mocks.viewer = { id: "colleague", email: "colleague@example.com" };
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("follows a cap opened to anyone with the link in a restricted organization", async () => {
		mocks.allowedEmailDomain = "example.com";
		mocks.linkOpenToAnyone = true;
		setVideo();
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});

	it("denies a video locked by the free plan share limit", async () => {
		mocks.shareLimited = true;
		setVideo();
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();
	});

	it("denies a video whose organization was deleted", async () => {
		setVideo({ organizationDeleted: true });
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();
	});

	it("does not reveal processing state before the view gates pass", async () => {
		setVideo({ password: "video-hash" });
		mocks.tables.set("video_uploads", [{ phase: "uploading" }]);
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);

		mocks.verifiedPasswords = ["video-hash"];
		expect(await getVideoDownloadInfo(VIDEO)).toEqual({
			success: false,
			error: "Video is still processing. Try again once it has finished.",
		});
	});
});

describe("rate limit", () => {
	it("stops a viewer before any storage access", async () => {
		mocks.rateLimited = true;
		setVideo();
		expect(await getVideoDownloadInfo(VIDEO)).toEqual({
			success: false,
			error: "Too many downloads. Please wait a moment and try again.",
		});
		expect(await currentVideoDownloadAccess(VIDEO, Option.none())).toBe(
			"denied",
		);
		expectNoStorageAccess();
	});

	it("does not apply to members", async () => {
		mocks.rateLimited = true;
		mocks.viewer = member;
		mocks.isMember = true;
		setVideo();
		expect(await getVideoDownloadInfo(VIDEO)).toMatchObject({ success: true });
	});
});

describe("the RPC download check", () => {
	const signedIn = (viewer: { id: string; email: string }) =>
		Option.some(
			CurrentUser.of({
				id: User.UserId.make(viewer.id),
				email: viewer.email,
				activeOrganizationId: Organisation.OrganisationId.make("organization"),
				iconUrlOrKey: Option.none(),
			}),
		);

	it("allows viewers by default and members always", async () => {
		setVideo();
		expect(await currentVideoDownloadAccess(VIDEO, Option.none())).toBe(
			"viewer",
		);
		expect(await currentVideoDownloadAccess(VIDEO, signedIn(stranger))).toBe(
			"viewer",
		);

		setVideo({ organizationSettings: OFF });
		expect(await currentVideoDownloadAccess(VIDEO, signedIn(stranger))).toBe(
			"denied",
		);
		mocks.isMember = true;
		expect(await currentVideoDownloadAccess(VIDEO, signedIn(member))).toBe(
			"member",
		);
	});

	it("uses the identity it is given, not the session cookie", async () => {
		mocks.viewer = { id: "colleague", email: "colleague@example.com" };
		mocks.allowedEmailDomain = "example.com";
		setVideo();
		expect(await currentVideoDownloadAccess(VIDEO, Option.none())).toBe(
			"denied",
		);
	});

	it("refuses viewers a screenshot but keeps it for members", async () => {
		setVideo();
		mocks.tables.set("videos", [
			{ ...(mocks.tables.get("videos")?.[0] as object), isScreenshot: true },
		]);
		expect(await currentVideoDownloadAccess(VIDEO, Option.none())).toBe(
			"denied",
		);
		await expect(getVideoDownloadInfo(VIDEO)).rejects.toThrow(ANONYMOUS_DENIAL);
		expectNoStorageAccess();
		mocks.isMember = true;
		expect(await currentVideoDownloadAccess(VIDEO, signedIn(member))).toBe(
			"member",
		);
	});

	it("is denied for a video that does not exist", async () => {
		expect(await currentVideoDownloadAccess(VIDEO, Option.none())).toBe(
			"denied",
		);
	});
});
