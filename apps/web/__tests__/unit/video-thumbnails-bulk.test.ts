import {
	CurrentUser,
	Organisation,
	Policy,
	User,
	Video,
} from "@cap/web-domain";
import { Effect, Exit, Logger, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type StoredObject = { Key: string; LastModified?: Date };

const mocks = vi.hoisted(() => ({
	getById: vi.fn(),
	getByIds: vi.fn(),
	listObjects: vi.fn(),
	storageError: undefined as Error | undefined,
	objects: new Map<string, StoredObject[]>(),
	pageSize: 1000,
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
						listObjects: ({
							prefix,
							continuationToken,
						}: {
							prefix: string;
							continuationToken?: string;
						}) => {
							mocks.listObjects(prefix);
							if (mocks.storageError && prefix.includes("broken"))
								return Effect.fail(
									new StorageError({ cause: mocks.storageError }),
								);
							const stored =
								mocks.objects.get(prefix.split("/")[1] ?? "") ?? [];
							const matching = stored
								.filter((object) => object.Key.startsWith(prefix))
								.sort((a, b) => (a.Key < b.Key ? -1 : 1));
							const start = continuationToken ? Number(continuationToken) : 0;
							const end = start + mocks.pageSize;
							return Effect.succeed({
								Contents: matching.slice(start, end),
								IsTruncated: end < matching.length,
								NextContinuationToken:
									end < matching.length ? String(end) : undefined,
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
		makeVideo("legacy", { type: "desktopMP4" }),
		makeVideo("reuploaded", { type: "desktopMP4" }),
		makeVideo("broken", { type: "desktopMP4" }),
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
		Effect.provide(Logger.remove(Logger.defaultLogger)),
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
	mocks.pageSize = 1000;
	mocks.objects.clear();
	mocks.objects.set("owned", [
		{ Key: "owner/owned/screenshot/screen-capture.jpg" },
	]);
	mocks.objects.set("noshot", [{ Key: "owner/noshot/result.mp4" }]);
	mocks.objects.set("broken", [
		{ Key: "owner/broken/screenshot/screen-capture.jpg" },
	]);
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

	it("lists only the screenshot key prefix instead of the whole video folder", async () => {
		await bulk(["owned"]);
		expect(mocks.listObjects.mock.calls).toEqual([
			["owner/owned/screenshot/screen-capture."],
		]);
	});

	it("finds a legacy root screenshot behind many other objects", async () => {
		mocks.objects.set("legacy", [
			...Array.from({ length: 25 }, (_, index) => ({
				Key: `owner/legacy/audio/segment-${index}.m4s`,
			})),
			{ Key: "owner/legacy/combined-source/source.mp4" },
			{ Key: "owner/legacy/output/result.mp4" },
			{ Key: "owner/legacy/screen-capture.jpg" },
		]);
		const [exit] = await bulk(["legacy"]);
		expect(exit).toEqual(
			Exit.succeed(Option.some("signed:owner/legacy/screen-capture.jpg")),
		);
		expect(mocks.listObjects.mock.calls).toEqual([
			["owner/legacy/screenshot/screen-capture."],
			["owner/legacy/screen-capture."],
		]);
	});

	it.each([
		["jpg", "png", "png"],
		["png", "jpg", "jpg"],
	])(
		"uses the newest screenshot when a %s is replaced by a %s",
		async (older, newer, expected) => {
			mocks.objects.set("reuploaded", [
				{
					Key: `owner/reuploaded/screenshot/screen-capture.${older}`,
					LastModified: new Date("2026-01-01T00:00:00Z"),
				},
				{
					Key: `owner/reuploaded/screenshot/screen-capture.${newer}`,
					LastModified: new Date("2026-02-01T00:00:00Z"),
				},
			]);
			const [exit] = await bulk(["reuploaded"]);
			expect(exit).toEqual(
				Exit.succeed(
					Option.some(
						`signed:owner/reuploaded/screenshot/screen-capture.${expected}`,
					),
				),
			);
		},
	);

	it("reads every page of a truncated listing", async () => {
		mocks.pageSize = 1;
		mocks.objects.set("reuploaded", [
			{
				Key: "owner/reuploaded/screenshot/screen-capture.jpeg",
				LastModified: new Date("2026-01-01T00:00:00Z"),
			},
			{
				Key: "owner/reuploaded/screenshot/screen-capture.jpg",
				LastModified: new Date("2026-02-01T00:00:00Z"),
			},
			{
				Key: "owner/reuploaded/screenshot/screen-capture.png",
				LastModified: new Date("2026-03-01T00:00:00Z"),
			},
		]);
		const [exit] = await bulk(["reuploaded"]);
		expect(exit).toEqual(
			Exit.succeed(
				Option.some("signed:owner/reuploaded/screenshot/screen-capture.png"),
			),
		);
		expect(mocks.listObjects).toHaveBeenCalledTimes(3);
	});

	it("isolates a storage error to the affected video", async () => {
		mocks.storageError = new Error("S3 unavailable");
		const owned = Exit.succeed(
			Option.some("signed:owner/owned/screenshot/screen-capture.jpg"),
		);
		await expect(bulk(["owned", "broken", "owned"])).resolves.toEqual([
			owned,
			Exit.succeed(Option.none()),
			owned,
		]);
		await expect(
			Effect.runPromise(
				provide(
					Effect.flatMap(Videos, (videos) =>
						videos.getThumbnailURL(Video.VideoId.make("broken")),
					),
				),
			),
		).rejects.toThrow();
	});
});
