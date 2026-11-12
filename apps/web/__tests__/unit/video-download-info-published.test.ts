import { Organisation, User, Video } from "@cap/web-domain";
import { Effect, Logger, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	tables: new Map<string, unknown[]>(),
	objects: new Map<string, number>(),
	signed: [] as string[],
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
vi.mock("@cap/utils", () => ({ dub: {} }));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect, Option } = await import("effect");
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({
			getAccessForVideo: (_video: unknown) =>
				Effect.succeed([
					{
						headObject: (key: string) =>
							mocks.objects.has(key)
								? Effect.succeed({ ContentLength: mocks.objects.get(key) })
								: Effect.fail(new Error("NotFound")),
						listObjects: ({ prefix }: { prefix: string }) =>
							Effect.succeed({
								Contents: [...mocks.objects.keys()]
									.filter((key) => key.startsWith(prefix))
									.map((Key) => ({ Key })),
							}),
						getSignedDownloadUrl: (key: string) => {
							mocks.signed.push(key);
							return Effect.succeed(`signed:${key}`);
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

const RESULT = "owner/video/result.mp4";
const RAW = "owner/video/raw-upload.mov";
const SCREENSHOT = "owner/video/screenshot/screen-capture.jpg";

let source: Video.Video["source"] = { type: "webMP4" };

const loaded = () =>
	Option.some([
		new Video.Video({
			id: Video.VideoId.make("video"),
			ownerId: User.UserId.make("owner"),
			orgId: Organisation.OrganisationId.make("org"),
			name: "Recording",
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
		}),
		Option.none<string>(),
	] as const);

const downloadInfo = (publishedOnly?: boolean) =>
	Effect.runPromise(
		Effect.flatMap(Videos, (videos) =>
			videos.getDownloadInfo(
				Video.VideoId.make("video"),
				publishedOnly === undefined ? undefined : { publishedOnly },
			),
		).pipe(
			Effect.provide(Videos.DefaultWithoutDependencies),
			Effect.provideService(
				VideosRepo,
				VideosRepo.make({ create: vi.fn() } as unknown as Parameters<
					typeof VideosRepo.make
				>[0]),
			),
			Effect.provideService(
				VideosPolicy,
				VideosPolicy.make({
					getViewableById: () => Effect.succeed(loaded()),
				} as unknown as Parameters<typeof VideosPolicy.make>[0]),
			),
			Effect.provide([Database.Default, Storage.Default, Tinybird.Default]),
			Effect.provide(Logger.remove(Logger.defaultLogger)),
		),
	);

beforeEach(() => {
	source = { type: "webMP4" };
	mocks.tables.clear();
	mocks.objects.clear();
	mocks.signed = [];
	mocks.tables.set("videos", [{ isScreenshot: false }]);
	mocks.tables.set("video_uploads", [{ rawFileKey: RAW, phase: "processing" }]);
	mocks.objects.set(RAW, 100);
});

describe("getDownloadInfo for viewers who are not members", () => {
	it("never signs the raw upload while the web upload is processing", async () => {
		expect(Option.isNone(await downloadInfo(true))).toBe(true);
		expect(mocks.signed).toEqual([]);

		expect(await downloadInfo()).toEqual(
			Option.some({
				fileName: "Recording.mov",
				downloadUrl: `signed:${RAW}`,
			}),
		);
	});

	it.each(["uploading", "processing", "generating_thumbnail", "error"])(
		"signs nothing while the upload is %s, even with bytes in result.mp4",
		async (phase) => {
			source = { type: "desktopMP4" };
			mocks.tables.set("video_uploads", [{ rawFileKey: null, phase }]);
			mocks.objects.set(RESULT, 100);
			expect(Option.isNone(await downloadInfo(true))).toBe(true);
			expect(mocks.signed).toEqual([]);
		},
	);

	it("signs the processed MP4 once the upload is complete", async () => {
		mocks.tables.set("video_uploads", [{ rawFileKey: RAW, phase: "complete" }]);
		mocks.objects.set(RESULT, 100);
		expect(await downloadInfo(true)).toEqual(
			Option.some({
				fileName: "Recording.mp4",
				downloadUrl: `signed:${RESULT}`,
			}),
		);
	});

	it("signs the processed MP4 when no upload row is left", async () => {
		mocks.tables.set("video_uploads", []);
		mocks.objects.set(RESULT, 100);
		expect(Option.isSome(await downloadInfo(true))).toBe(true);
		expect(mocks.signed).toEqual([RESULT]);
	});

	it("ignores an empty processed MP4", async () => {
		mocks.tables.set("video_uploads", []);
		mocks.objects.set(RESULT, 0);
		expect(Option.isNone(await downloadInfo(true))).toBe(true);
		expect(mocks.signed).toEqual([]);
	});

	it("never signs a screenshot", async () => {
		mocks.tables.set("videos", [{ isScreenshot: true }]);
		mocks.objects.set(SCREENSHOT, 100);
		expect(Option.isNone(await downloadInfo(true))).toBe(true);
		expect(mocks.signed).toEqual([]);

		expect(Option.isSome(await downloadInfo())).toBe(true);
		expect(mocks.signed).toEqual([SCREENSHOT]);
	});

	it("returns nothing for a segmented recording with no MP4", async () => {
		source = { type: "desktopSegments" };
		expect(Option.isNone(await downloadInfo(true))).toBe(true);
		expect(mocks.signed).toEqual([]);
	});
});
