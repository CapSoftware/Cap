import type { VideosPolicyDeps } from "@cap/web-backend";
import {
	type CurrentUser,
	type Organisation,
	type User,
	Video,
} from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const VIDEO_ID = "analytics-video" as Video.VideoId;
const OWNER_ID = "owner-1" as User.UserId;
const VIEWER_ID = "viewer-1" as User.UserId;
const ORG_ID = "org-1" as Organisation.OrganisationId;

type Scenario = {
	exists: boolean;
	public: boolean;
	password: Option.Option<string>;
	spacePasswords: string[];
	orgMembership: boolean;
	spaceMembership: boolean;
	allowedEmailDomain: Option.Option<string>;
	viewerGrantEmail?: string;
	user: Option.Option<CurrentUser["Type"]>;
	verifiedPasswords: string[];
};

const mocks = vi.hoisted(() => ({
	scenario: {} as Scenario,
	viewCount: vi.fn(),
}));

const makeVideo = () =>
	Video.Video.make({
		id: VIDEO_ID,
		ownerId: OWNER_ID,
		orgId: ORG_ID,
		name: "Recording",
		public: mocks.scenario.public,
		source: { type: "desktopMP4" },
		metadata: Option.none(),
		bucketId: Option.none(),
		storageIntegrationId: Option.none(),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.none(),
		height: Option.none(),
		duration: Option.none(),
		createdAt: new Date(),
		updatedAt: new Date(),
	});

const makeDeps = (): VideosPolicyDeps => ({
	repo: {
		getById: () =>
			Effect.sync(() =>
				mocks.scenario.exists
					? Option.some([makeVideo(), mocks.scenario.password] as const)
					: Option.none(),
			),
		hasViewerGrant: (_, email) =>
			Effect.succeed(email === mocks.scenario.viewerGrantEmail),
	},
	orgsRepo: {
		membershipForVideo: () =>
			Effect.sync(() =>
				mocks.scenario.orgMembership ? [{ membershipId: "member" }] : [],
			),
		allowedEmailDomain: () =>
			Effect.sync(() => mocks.scenario.allowedEmailDomain),
	},
	spacesRepo: {
		membershipForVideo: () =>
			Effect.sync(() =>
				mocks.scenario.spaceMembership
					? Option.some({ membershipId: "space-member" })
					: Option.none(),
			),
		passwordsForVideo: () =>
			Effect.sync(() =>
				mocks.scenario.spacePasswords.map((password) => ({ password })),
			),
	},
});

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (mocks.scenario.exists ? [{ id: VIDEO_ID }] : []),
				}),
			}),
		}),
	}),
}));

vi.mock("@cap/web-backend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/web-backend")>();
	const { Effect, Option } = await import("effect");
	const { CurrentUser, Video } = await import("@cap/web-domain");
	class VideosPolicy extends Effect.Service<VideosPolicy>()("VideosPolicy", {
		sync: () => ({
			canView: (id: Video.VideoId) => actual.buildCanView(makeDeps(), id),
		}),
	}) {}
	return {
		VideosPolicy,
		provideOptionalAuth: <A, E, R>(app: Effect.Effect<A, E, R>) => {
			const withPolicy = app.pipe(
				Effect.provide(VideosPolicy.Default),
				Effect.provideService(Video.VideoPasswordAttachment, {
					passwords: mocks.scenario.verifiedPasswords,
				}),
			);
			return Option.match(mocks.scenario.user, {
				onNone: () => withPolicy,
				onSome: (user) => Effect.provideService(withPolicy, CurrentUser, user),
			});
		},
	};
});

vi.mock("@/lib/server", () => ({ runPromiseExit: Effect.runPromiseExit }));
vi.mock("@/lib/video-view-count", () => ({
	getVideoViewCount: mocks.viewCount,
}));

const { getVideoAnalytics } = await import("@/actions/videos/get-analytics");

const makeUser = (email: string, id: User.UserId = VIEWER_ID) =>
	Option.some<CurrentUser["Type"]>({
		id,
		email,
		activeOrganizationId: ORG_ID,
		iconUrlOrKey: Option.none(),
	});

const expectAllowed = async (options?: { rangeDays?: number }) => {
	await expect(getVideoAnalytics(VIDEO_ID, options)).resolves.toEqual({
		count: 7,
	});
	expect(mocks.viewCount).toHaveBeenCalledWith(VIDEO_ID, options);
};

const expectDenied = async () => {
	await expect(getVideoAnalytics(VIDEO_ID)).rejects.toThrow("Video not found");
	expect(mocks.viewCount).not.toHaveBeenCalled();
};

beforeEach(() => {
	mocks.scenario = {
		exists: true,
		public: true,
		password: Option.none(),
		spacePasswords: [],
		orgMembership: false,
		spaceMembership: false,
		allowedEmailDomain: Option.none(),
		viewerGrantEmail: undefined,
		user: Option.none(),
		verifiedPasswords: [],
	};
	mocks.viewCount.mockReset();
	mocks.viewCount.mockResolvedValue({ count: 7 });
});

describe("getVideoAnalytics access", () => {
	it("returns the count to anonymous viewers of public videos", async () => {
		await expectAllowed();
	});

	it("passes the range option through", async () => {
		await expectAllowed({ rangeDays: 7 });
	});

	it("returns the count to the owner of a private video", async () => {
		mocks.scenario.public = false;
		mocks.scenario.user = makeUser("owner@example.com", OWNER_ID);
		await expectAllowed();
	});

	it("returns the count to org members of a private video", async () => {
		mocks.scenario.public = false;
		mocks.scenario.orgMembership = true;
		mocks.scenario.user = makeUser("member@example.com");
		await expectAllowed();
	});

	it("returns the count to space members of a private video", async () => {
		mocks.scenario.public = false;
		mocks.scenario.spaceMembership = true;
		mocks.scenario.user = makeUser("member@example.com");
		await expectAllowed();
	});

	it("returns the count to invited viewers of a private video", async () => {
		mocks.scenario.public = false;
		mocks.scenario.viewerGrantEmail = "guest@example.com";
		mocks.scenario.user = makeUser("guest@example.com");
		await expectAllowed();
	});

	it("returns the count for a password video with a verified cookie", async () => {
		mocks.scenario.password = Option.some("hash-1");
		mocks.scenario.verifiedPasswords = ["hash-1"];
		await expectAllowed();
	});

	it("returns the count for a space password with a verified cookie", async () => {
		mocks.scenario.spacePasswords = ["space-hash"];
		mocks.scenario.verifiedPasswords = ["space-hash"];
		await expectAllowed();
	});

	it("returns the count when the viewer matches the email restriction", async () => {
		mocks.scenario.allowedEmailDomain = Option.some("example.com");
		mocks.scenario.user = makeUser("person@example.com");
		await expectAllowed();
	});

	it("denies anonymous viewers of private videos", async () => {
		mocks.scenario.public = false;
		await expectDenied();
	});

	it("denies signed-in users without access to a private video", async () => {
		mocks.scenario.public = false;
		mocks.scenario.user = makeUser("stranger@example.com");
		await expectDenied();
	});

	it("denies password videos without a verified cookie", async () => {
		mocks.scenario.password = Option.some("hash-1");
		await expectDenied();
	});

	it("denies password videos with a wrong verified password", async () => {
		mocks.scenario.password = Option.some("hash-1");
		mocks.scenario.verifiedPasswords = ["other-hash"];
		await expectDenied();
	});

	it("denies space password videos without a verified cookie", async () => {
		mocks.scenario.spacePasswords = ["space-hash"];
		mocks.scenario.orgMembership = true;
		mocks.scenario.user = makeUser("member@example.com");
		await expectDenied();
	});

	it("denies anonymous viewers when an email restriction is active", async () => {
		mocks.scenario.allowedEmailDomain = Option.some("example.com");
		await expectDenied();
	});

	it("denies viewers outside the email restriction", async () => {
		mocks.scenario.allowedEmailDomain = Option.some("example.com");
		mocks.scenario.user = makeUser("person@other.com");
		await expectDenied();
	});

	it("does not query analytics for unknown videos", async () => {
		mocks.scenario.exists = false;
		await expectDenied();
	});

	it("rejects an empty video id", async () => {
		await expect(getVideoAnalytics("")).rejects.toThrow("Video ID is required");
		expect(mocks.viewCount).not.toHaveBeenCalled();
	});
});
