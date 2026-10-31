import {
	CurrentUser,
	DatabaseError,
	Organisation,
	User,
	Video,
} from "@cap/web-domain";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/utils", async () => {
	const { isEmailAllowedByRestriction } = await import(
		"../../../../packages/utils/src/helpers"
	);
	return { dub: {}, isEmailAllowedByRestriction };
});
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect, Option } = await import("effect");
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({
			getAccessForVideo: (_video: unknown) =>
				Effect.succeed([
					{
						getSignedObjectUrl: (key: string) =>
							Effect.succeed(`signed:${key}`),
						listObjects: ({ prefix }: { prefix: string }) =>
							Effect.succeed({
								Contents: [{ Key: `${prefix}screenshot/screen-capture.jpg` }],
							}),
					},
					Option.none(),
				] as const),
		}),
	}) {}
	return { Storage };
});
vi.mock("@cap/web-backend/src/Tinybird/index", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		sync: () => ({}),
	}) {}
	return { Tinybird };
});

const { Videos } = await import("@cap/web-backend/src/Videos/index");
const { VideosPolicy } = await import(
	"@cap/web-backend/src/Videos/VideosPolicy"
);
const { VideosRepo } = await import("@cap/web-backend/src/Videos/VideosRepo");
const { OrganisationsRepo } = await import(
	"@cap/web-backend/src/Organisations/OrganisationsRepo"
);
const { SpacesRepo } = await import("@cap/web-backend/src/Spaces/SpacesRepo");
const { Database } = await import("@cap/web-backend/src/Database");
const { Storage } = await import("@cap/web-backend/src/Storage/index");
const { Tinybird } = await import("@cap/web-backend/src/Tinybird/index");

type Fixture = {
	ownerId: string;
	orgId: string;
	public: boolean;
	password?: string;
	orgMembers?: string[];
	spaceMembers?: string[];
	spacePasswords?: string[];
	grants?: string[];
};

const fixtures: Record<string, Fixture> = {
	"viewer-owned": { ownerId: "viewer", orgId: "open", public: false },
	public: { ownerId: "other", orgId: "open", public: true },
	private: { ownerId: "other", orgId: "open", public: false },
	"private-grant": {
		ownerId: "other",
		orgId: "open",
		public: false,
		grants: ["viewer@acme.com"],
	},
	"org-member": {
		ownerId: "other",
		orgId: "open",
		public: false,
		orgMembers: ["viewer"],
	},
	"space-member": {
		ownerId: "other",
		orgId: "open",
		public: false,
		spaceMembers: ["viewer"],
	},
	"space-password": {
		ownerId: "other",
		orgId: "open",
		public: true,
		spacePasswords: ["space-hash"],
	},
	"member-with-space-password": {
		ownerId: "other",
		orgId: "open",
		public: false,
		spaceMembers: ["viewer"],
		spacePasswords: ["space-hash"],
	},
	"video-password": {
		ownerId: "other",
		orgId: "open",
		public: true,
		password: "video-hash",
	},
	restricted: { ownerId: "other", orgId: "restricted", public: true },
	"restricted-grant": {
		ownerId: "other",
		orgId: "restricted",
		public: true,
		grants: ["viewer@acme.com"],
	},
	"restricted-allowed": { ownerId: "other", orgId: "acme", public: true },
};

const allowedDomains: Record<string, string | null> = {
	open: null,
	restricted: "other.com",
	acme: "acme.com",
};

const ids = [...Object.keys(fixtures), "missing", "public"];

const toVideo = (id: string, fixture: Fixture) =>
	new Video.Video({
		id: Video.VideoId.make(id),
		ownerId: User.UserId.make(fixture.ownerId),
		orgId: Organisation.OrganisationId.make(fixture.orgId),
		name: id,
		public: fixture.public,
		source: { type: "desktopMP4" },
		metadata: Option.none(),
		bucketId: Option.none(),
		storageIntegrationId: Option.none(),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.none(),
		height: Option.none(),
		duration: Option.none(),
		createdAt: new Date(0),
		updatedAt: new Date(0),
	});

const loaded = (id: string) => {
	const fixture = fixtures[id];
	return fixture
		? Option.some([
				toVideo(id, fixture),
				Option.fromNullable(fixture.password),
			] as const)
		: Option.none();
};

const repoLayers = (failMemberships: boolean) => {
	const membershipFailure = Effect.fail(
		new DatabaseError({ cause: new Error("membership lookup failed") }),
	);
	const known = (videoIds: readonly string[]) =>
		videoIds.flatMap((id) => {
			const fixture = fixtures[id];
			return fixture ? [[id, fixture] as const] : [];
		});
	return Layer.mergeAll(
		Layer.succeed(
			VideosRepo,
			VideosRepo.make({
				getById: (id: Video.VideoId) => Effect.succeed(loaded(id)),
				getByIds: (videoIds: ReadonlyArray<Video.VideoId>) =>
					Effect.succeed(
						[...new Set(videoIds)].flatMap((id) => Option.toArray(loaded(id))),
					),
				hasViewerGrant: (id: Video.VideoId, email: string) =>
					Effect.succeed(fixtures[id]?.grants?.includes(email) ?? false),
				prepareDelete: vi.fn(),
				delete: vi.fn(),
				create: vi.fn(),
			} as unknown as Parameters<typeof VideosRepo.make>[0]),
		),
		Layer.succeed(
			OrganisationsRepo,
			OrganisationsRepo.make({
				membershipForVideo: (userId: string, videoId: string) =>
					failMemberships
						? membershipFailure
						: Effect.succeed(
								fixtures[videoId]?.orgMembers?.includes(userId)
									? [{ membershipId: "org-membership" }]
									: [],
							),
				membershipsForVideos: (userId: string, videoIds: readonly string[]) =>
					failMemberships
						? membershipFailure
						: Effect.succeed(
								known(videoIds)
									.filter(([, fixture]) => fixture.orgMembers?.includes(userId))
									.map(([videoId]) => ({
										videoId,
										membershipId: "org-membership",
									})),
							),
				allowedEmailDomain: (orgId: string) =>
					Effect.succeed(Option.fromNullable(allowedDomains[orgId])),
			} as unknown as Parameters<typeof OrganisationsRepo.make>[0]),
		),
		Layer.succeed(
			SpacesRepo,
			SpacesRepo.make({
				membershipForVideo: (userId: string, videoId: string) =>
					failMemberships
						? membershipFailure
						: Effect.succeed(
								fixtures[videoId]?.spaceMembers?.includes(userId)
									? Option.some({ membershipId: "space-membership" })
									: Option.none(),
							),
				membershipsForVideos: (userId: string, videoIds: readonly string[]) =>
					failMemberships
						? membershipFailure
						: Effect.succeed(
								known(videoIds)
									.filter(([, fixture]) =>
										fixture.spaceMembers?.includes(userId),
									)
									.map(([videoId]) => ({
										videoId,
										membershipId: "space-membership",
									})),
							),
				passwordsForVideo: (videoId: string) =>
					Effect.succeed(
						(fixtures[videoId]?.spacePasswords ?? []).map((password) => ({
							password,
						})),
					),
				passwordsForVideos: (videoIds: readonly string[]) =>
					Effect.succeed(
						known(videoIds).flatMap(([videoId, fixture]) =>
							(fixture.spacePasswords ?? []).map((password) => ({
								videoId,
								password,
							})),
						),
					),
			} as unknown as Parameters<typeof SpacesRepo.make>[0]),
		),
	);
};

type Viewer = {
	user: Option.Option<CurrentUser["Type"]>;
	passwords: Option.Option<ReadonlyArray<string>>;
};

const signedIn = (
	id: string,
	email: string,
): Option.Option<CurrentUser["Type"]> =>
	Option.some({
		id: User.UserId.make(id),
		email,
		activeOrganizationId: Organisation.OrganisationId.make("open"),
		iconUrlOrKey: Option.none(),
	});

const viewers = {
	member: {
		user: signedIn("viewer", "viewer@acme.com"),
		passwords: Option.none(),
	},
	owner: {
		user: signedIn("other", "owner@other.com"),
		passwords: Option.none(),
	},
	anonymous: { user: Option.none(), passwords: Option.none() },
	"with password": {
		user: signedIn("viewer", "viewer@acme.com"),
		passwords: Option.some(["video-hash", "space-hash"]),
	},
} satisfies Record<string, Viewer>;

const run = <A, E>(
	viewer: Viewer,
	failMemberships: boolean,
	effect: Effect.Effect<A, E, InstanceType<typeof Videos>>,
) => {
	let program = effect.pipe(
		Effect.provide(Videos.DefaultWithoutDependencies),
		Effect.provide(VideosPolicy.DefaultWithoutDependencies),
		Effect.provide(repoLayers(failMemberships)),
		Effect.provide([Database.Default, Storage.Default, Tinybird.Default]),
	);
	if (Option.isSome(viewer.user))
		program = program.pipe(
			Effect.provideService(CurrentUser, viewer.user.value),
		);
	if (Option.isSome(viewer.passwords))
		program = program.pipe(
			Effect.provideService(Video.VideoPasswordAttachment, {
				passwords: viewer.passwords.value,
			}),
		);
	return Effect.runPromiseExit(program as Effect.Effect<A, E, never>);
};

const bulk = (viewer: Viewer, failMemberships = false) =>
	run(
		viewer,
		failMemberships,
		Effect.flatMap(Videos, (videos) =>
			videos.getThumbnailURLs(ids.map((id) => Video.VideoId.make(id))),
		),
	);

const single = (viewer: Viewer, failMemberships = false) =>
	run(
		viewer,
		failMemberships,
		Effect.flatMap(Videos, (videos) =>
			Effect.forEach(ids, (id) =>
				videos.getThumbnailURL(Video.VideoId.make(id)).pipe(
					Effect.matchEffect({
						onSuccess: (url) => Effect.succeed(Exit.succeed(url)),
						onFailure: (error) =>
							error._tag === "DatabaseError" || error._tag === "StorageError"
								? Effect.fail(error)
								: Effect.succeed(Exit.fail(error)),
					}),
				),
			),
		),
	);

const outcome = (exit: Exit.Exit<Option.Option<string>, { _tag: string }>) =>
	Exit.match(exit, {
		onSuccess: (url) => (Option.isSome(url) ? "url" : "none"),
		onFailure: (cause) =>
			Option.match(Cause.failureOption(cause), {
				onNone: () => "defect",
				onSome: (error) => error._tag,
			}),
	});

describe("bulk thumbnail URLs with the real access policy", () => {
	for (const [name, viewer] of Object.entries(viewers)) {
		it(`matches the per-video lookup for a ${name} viewer`, async () => {
			const [bulkExit, singleExit] = [await bulk(viewer), await single(viewer)];
			expect(Exit.isSuccess(bulkExit)).toBe(true);
			expect(bulkExit).toEqual(singleExit);
		});
	}

	it("covers allowed, denied and password outcomes", async () => {
		const exit = await bulk(viewers.member);
		if (!Exit.isSuccess(exit)) throw new Error("bulk lookup failed");
		const byId = Object.fromEntries(
			ids.map((id, index) => {
				const result = exit.value[index];
				return [id, result ? outcome(result) : "no result"];
			}),
		);
		expect(byId).toMatchObject({
			"viewer-owned": "url",
			public: "url",
			private: "PolicyDenied",
			"private-grant": "url",
			"org-member": "url",
			"space-member": "url",
			"space-password": "VerifyVideoPasswordError",
			"member-with-space-password": "VerifyVideoPasswordError",
			"video-password": "VerifyVideoPasswordError",
			restricted: "PolicyDenied",
			"restricted-grant": "url",
			"restricted-allowed": "url",
			missing: "none",
		});
	});

	it("fails the batch when a membership lookup fails, like the per-video lookup", async () => {
		const [bulkExit, singleExit] = [
			await bulk(viewers.member, true),
			await single(viewers.member, true),
		];
		for (const exit of [bulkExit, singleExit]) {
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit))
				expect(
					Option.getOrNull(Cause.failureOption(exit.cause)),
				).toBeInstanceOf(DatabaseError);
		}
	});

	it("still serves the owner's videos when membership lookups fail", async () => {
		const exit = await run(
			viewers.owner,
			true,
			Effect.flatMap(Videos, (videos) =>
				videos.getThumbnailURLs([
					Video.VideoId.make("public"),
					Video.VideoId.make("private"),
				]),
			),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
	});
});
