import {
	buildCanViewLoaded,
	type VideosPolicyDeps,
	type ViewableVideo,
} from "@cap/web-backend/src/Videos/VideosPolicy";
import { CurrentUser, Organisation, User, Video } from "@cap/web-domain";
import { Context, Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DownloadPolicy = {
	canViewLoaded: (
		video: ViewableVideo,
		password: Option.Option<string>,
	) => ReturnType<typeof buildCanViewLoaded>;
};
const PolicyTag = Context.GenericTag<DownloadPolicy>("DownloadActionPolicy");
const user = {
	id: User.UserId.make("test-owner"),
	email: "owner@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("other-org"),
	iconUrlOrKey: Option.none<string>(),
};
const videoId = Video.VideoId.make("test-video");
let password: string | null = null;
let spacePasswords: string[] = [];
let verifiedPasswords: string[] = [];
let directoryAccess = false;
let membership = true;
const signedUrl = vi.fn(() =>
	Effect.succeed("https://media.example.invalid/video.mp4"),
);
const storageAccess = vi.fn(() =>
	Effect.succeed([
		{ headObject: () => Effect.succeed({}), getSignedObjectUrl: signedUrl },
	]),
);
const row = () => ({
	id: videoId,
	ownerId: user.id,
	orgId: Organisation.OrganisationId.make("source-org"),
	name: "Example recording",
	public: false,
	password,
	source: { type: "desktopMP4" as const },
	metadata: null,
	bucket: null,
	storageIntegrationId: null,
	folderId: null,
	transcriptionStatus: null,
	width: null,
	height: null,
	duration: null,
	createdAt: new Date(),
	updatedAt: new Date(),
});
const deps = (): VideosPolicyDeps => ({
	repo: {
		getById: () => Effect.succeed(Option.none()),
		hasViewerGrant: () => Effect.succeed(false),
	},
	orgsRepo: {
		hasDirectoryAccess: () => Effect.succeed(directoryAccess),
		membershipForVideo: () =>
			Effect.succeed(membership ? [{ membershipId: "other-membership" }] : []),
		allowedEmailDomain: () => Effect.succeed(Option.none()),
	},
	spacesRepo: {
		membershipForVideo: () => Effect.succeed(Option.none()),
		passwordsForVideo: () =>
			Effect.succeed(spacePasswords.map((password) => ({ password }))),
	},
});
vi.mock("@cap/database/schema", () => ({
	videos: { table: "videos" },
	videoUploads: { table: "uploads" },
	videoEdits: { table: "edits" },
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: { table: string }) => ({
				where: async () =>
					table.table === "videos"
						? [row()]
						: table.table === "edits"
							? [{ sourceKey: "original.mp4" }]
							: [],
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => user,
}));
vi.mock("@cap/database/directory-sync/access", () => ({
	hasDirectoryAccess: async () => directoryAccess,
}));
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: async () => true,
}));
vi.mock("@cap/web-backend", () => ({
	VideosPolicy: PolicyTag,
	Storage: { getAccessForVideo: storageAccess },
	provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.provideService(CurrentUser, user)),
}));
vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E, DownloadPolicy>) =>
		Effect.runPromise(
			effect.pipe(
				Effect.provideService(PolicyTag, {
					canViewLoaded: (video, password) =>
						buildCanViewLoaded(deps(), video, password),
				}),
				Effect.provideService(Video.VideoPasswordAttachment, {
					passwords: verifiedPasswords,
				}),
			),
		),
}));
const { getVideoDownloadInfo } = await import("../../actions/videos/download");

describe("download action authorization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		password = null;
		spacePasswords = [];
		verifiedPasswords = [];
		directoryAccess = false;
		membership = true;
	});
	for (const variant of ["current", "original"] as const) {
		it.each(["video", "space"])(
			`rejects a direct ${variant} download without its %s password`,
			async (source) => {
				if (source === "video") password = "required-hash";
				else spacePasswords = ["required-hash"];
				await expect(getVideoDownloadInfo(videoId, variant)).rejects.toThrow();
				expect(storageAccess).not.toHaveBeenCalled();
				expect(signedUrl).not.toHaveBeenCalled();
			},
		);
		it.each(["video", "space"])(
			`allows a ${variant} download after verifying its %s password`,
			async (source) => {
				if (source === "video") password = "required-hash";
				else spacePasswords = ["required-hash"];
				verifiedPasswords = ["required-hash"];
				expect(await getVideoDownloadInfo(videoId, variant)).toMatchObject({
					success: true,
				});
				expect(signedUrl).toHaveBeenCalledOnce();
			},
		);
	}
	it("preserves the active owner's password exemption", async () => {
		directoryAccess = true;
		membership = false;
		password = "required-hash";
		expect(await getVideoDownloadInfo(videoId)).toMatchObject({
			success: true,
		});
	});
	it("rechecks view access before storage even if download membership was previously allowed", async () => {
		membership = false;
		await expect(getVideoDownloadInfo(videoId)).rejects.toThrow();
		expect(storageAccess).not.toHaveBeenCalled();
	});
});
