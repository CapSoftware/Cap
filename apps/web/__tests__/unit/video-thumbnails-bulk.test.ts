import {
	CurrentUser,
	Organisation,
	Policy,
	User,
	Video,
} from "@cap/web-domain";
import { Effect, Exit, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getById: vi.fn(),
	getByIds: vi.fn(),
	listObjects: vi.fn(),
	storageError: undefined as Error | undefined,
}));

vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/utils", () => ({ dub: {} }));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect, Option } = await import("effect");
	const { StorageError } = await import("@cap/web-domain");
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({
			getAccessForVideo: (_video: unknown) =>
				Effect.succeed([
					{
						getSignedObjectUrl: (key: string) =>
							Effect.succeed(`signed:${key}`),
						listObjects: ({ prefix }: { prefix: string }) => {
							mocks.listObjects(prefix);
							if (mocks.storageError)
								return Effect.fail(
									new StorageError({ cause: mocks.storageError }),
								);
							return Effect.succeed({
								Contents: prefix.includes("noshot")
									? [{ Key: `${prefix}result.mp4` }]
									: [{ Key: `${prefix}screenshot/screen-capture.jpg` }],
							});
						},
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
const { Database } = await import("@cap/web-backend/src/Database");
const { Storage } = await import("@cap/web-backend/src/Storage/index");
const { Tinybird } = await import("@cap/web-backend/src/Tinybird/index");

const makeVideo = (id: string, source: Video.Video["source"]) =>
	new Video.Video({
		id: Video.VideoId.make(id),
		ownerId: User.UserId.make("owner"),
		orgId: Organisation.OrganisationId.make("org"),
		name: id,
		public: true,
		source,
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

const videosById = new Map(
	[
		makeVideo("owned", { type: "desktopMP4" }),
		makeVideo("noshot", { type: "desktopMP4" }),
		makeVideo("published", {
			type: "desktopMP4",
			thumbnailKey: "owner/published/.recording/outputs/thumb.jpg",
		}),
		makeVideo("denied", { type: "desktopMP4" }),
		makeVideo("protected", { type: "desktopMP4" }),
	].map((video) => [video.id as string, video] as const),
);

const loadedFor = (id: string) => {
	const video = videosById.get(id);
	return video
		? Option.some([
				video,
				id === "protected" ? Option.some("password-hash") : Option.none(),
			] as const)
		: Option.none();
};

const check = (
	video: { id: string },
	_password: Option.Option<string>,
): Effect.Effect<
	void,
	Policy.PolicyDeniedError | Video.VerifyVideoPasswordError
> =>
	video.id === "denied"
		? Effect.fail(new Policy.PolicyDeniedError())
		: video.id === "protected"
			? Effect.fail(
					new Video.VerifyVideoPasswordError({
						id: Video.VideoId.make(video.id),
						cause: "not-provided",
					}),
				)
			: Effect.void;

const user: CurrentUser["Type"] = {
	id: User.UserId.make("owner"),
	email: "owner@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("org"),
	iconUrlOrKey: Option.none(),
};

function provide<A, E>(
	effect: Effect.Effect<A, E, InstanceType<typeof Videos>>,
) {
	return effect.pipe(
		Effect.provide(Videos.DefaultWithoutDependencies),
		Effect.provideService(
			VideosRepo,
			VideosRepo.make({
				getById: (id: Video.VideoId) => {
					mocks.getById(id);
					return Effect.succeed(loadedFor(id));
				},
				getByIds: (ids: ReadonlyArray<Video.VideoId>) => {
					mocks.getByIds(ids);
					return Effect.succeed(
						[...new Set(ids)].flatMap((id) => Option.toArray(loadedFor(id))),
					);
				},
				hasViewerGrant: vi.fn(),
				prepareDelete: vi.fn(),
				delete: vi.fn(),
				create: vi.fn(),
			} as unknown as Parameters<typeof VideosRepo.make>[0]),
		),
		Effect.provideService(
			VideosPolicy,
			VideosPolicy.make({
				canViewLoaded: check,
				canViewLoadedBulk: (
					loaded: ReadonlyArray<
						readonly [{ id: string }, Option.Option<string>]
					>,
				) =>
					Effect.forEach(loaded, ([video, password]) =>
						check(video, password).pipe(Effect.exit),
					),
				canView: vi.fn(),
				isOwner: vi.fn(),
				isOwnerLoaded: vi.fn(),
				getViewableById: (id: Video.VideoId) => {
					const loaded = loadedFor(id);
					return Option.isNone(loaded)
						? Effect.succeed(Option.none())
						: check(loaded.value[0], loaded.value[1]).pipe(Effect.as(loaded));
				},
				getOwnedById: vi.fn(),
			} as unknown as Parameters<typeof VideosPolicy.make>[0]),
		),
		Effect.provide([Database.Default, Storage.Default, Tinybird.Default]),
		Effect.provideService(CurrentUser, user),
	);
}

const bulk = (ids: string[]) =>
	Effect.runPromise(
		provide(
			Effect.flatMap(Videos, (videos) =>
				videos.getThumbnailURLs(ids.map((id) => Video.VideoId.make(id))),
			),
		),
	);

const single = (ids: string[]) =>
	Effect.runPromise(
		provide(
			Effect.flatMap(Videos, (videos) =>
				Effect.forEach(ids, (id) =>
					videos.getThumbnailURL(Video.VideoId.make(id)).pipe(Effect.exit),
				),
			),
		),
	);

beforeEach(() => {
	mocks.getById.mockClear();
	mocks.getByIds.mockClear();
	mocks.listObjects.mockClear();
	mocks.storageError = undefined;
});

describe("bulk thumbnail URLs", () => {
	it("matches the per-video lookup for every outcome", async () => {
		const ids = [
			"owned",
			"missing",
			"noshot",
			"published",
			"denied",
			"protected",
			"owned",
		];
		const [bulkResults, singleResults] = [await bulk(ids), await single(ids)];
		expect(bulkResults).toEqual(singleResults);
		expect(bulkResults.map((exit) => Exit.getOrElse(exit, () => null))).toEqual(
			[
				Option.some("signed:owner/owned/screenshot/screen-capture.jpg"),
				Option.none(),
				Option.none(),
				Option.some("signed:owner/published/.recording/outputs/thumb.jpg"),
				null,
				null,
				Option.some("signed:owner/owned/screenshot/screen-capture.jpg"),
			],
		);
	});

	it("loads every video in one repository read", async () => {
		await bulk(["owned", "noshot", "denied", "owned"]);
		expect(mocks.getByIds).toHaveBeenCalledTimes(1);
		expect(mocks.getById).not.toHaveBeenCalled();
	});

	it("does not list storage for videos the viewer cannot see", async () => {
		await bulk(["denied", "protected", "missing"]);
		expect(mocks.listObjects).not.toHaveBeenCalled();
	});

	it("fails the whole batch on a storage error, like the per-video lookup", async () => {
		mocks.storageError = new Error("S3 unavailable");
		await expect(bulk(["owned"])).rejects.toThrow();
		await expect(
			Effect.runPromise(
				provide(
					Effect.flatMap(Videos, (videos) =>
						videos.getThumbnailURL(Video.VideoId.make("owned")),
					),
				),
			),
		).rejects.toThrow();
	});
});
