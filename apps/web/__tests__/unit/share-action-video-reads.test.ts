import { videos } from "@cap/database/schema";
import { type CurrentUser, Organisation, User, Video } from "@cap/web-domain";
import { getTableColumns } from "drizzle-orm";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	user: null as unknown,
	video: {} as Record<string, unknown>,
	verifiedPasswords: [] as string[],
	getObject: vi.fn(),
	listObjects: vi.fn(),
	viewCount: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	return { db: () => drizzle(mocks.query) };
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => null,
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/utils", async () => {
	const { isEmailAllowedByRestriction } = await import(
		"../../../../packages/utils/src/helpers"
	);
	return { dub: {}, isEmailAllowedByRestriction };
});
vi.mock("@cap/web-backend", async () => {
	const { Effect, Logger, LogLevel } = await import("effect");
	const { CurrentUser, Video } = await import("@cap/web-domain");
	const { VideosPolicy } = await import(
		"@cap/web-backend/src/Videos/VideosPolicy"
	);
	const { VideosRepo } = await import("@cap/web-backend/src/Videos/VideosRepo");
	const { Database } = await import("@cap/web-backend/src/Database");
	const bucket = {
		getObject: (key: string) => Effect.sync(() => mocks.getObject(key)),
		listObjects: (input: unknown) =>
			Effect.sync(() => mocks.listObjects(input)),
	};
	return {
		VideosPolicy,
		Storage: { getAccessForVideo: () => Effect.succeed([bucket]) },
		provideOptionalAuth: <A, E, R>(app: Effect.Effect<A, E, R>) =>
			(mocks.user
				? app.pipe(
						Effect.provideService(
							CurrentUser,
							mocks.user as CurrentUser["Type"],
						),
					)
				: app
			).pipe(
				Effect.provide([
					VideosPolicy.Default,
					VideosRepo.Default,
					Database.Default,
				]),
				Effect.provideService(Video.VideoPasswordAttachment, {
					passwords: mocks.verifiedPasswords,
				}),
				Logger.withMinimumLogLevel(LogLevel.None),
			),
	};
});
vi.mock("@/lib/server", () => ({
	runPromise: Effect.runPromise,
	runPromiseExit: Effect.runPromiseExit,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/video-view-count", () => ({
	getVideoViewCount: mocks.viewCount,
}));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => false }));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	isRetryableDesktopSegmentsFinalizationError: () => false,
	queueDesktopSegmentsFinalization: vi.fn(),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: () => false }));

const { getTranscript } = await import("@/actions/videos/get-transcript");
const { getAvailableTranslations } = await import(
	"@/actions/videos/get-available-translations"
);
const { getVideoStatus } = await import("@/actions/videos/get-status");
const { getVideoAnalytics } = await import("@/actions/videos/get-analytics");

const videoId = Video.VideoId.make("video-1");
const viewer: CurrentUser["Type"] = {
	id: User.UserId.make("viewer"),
	email: "viewer@example.com",
	activeOrganizationId: Organisation.OrganisationId.make("org"),
	iconUrlOrKey: Option.none(),
};
const videoColumns = new Set(
	Object.values(getTableColumns(videos)).map((column) => column.name),
);

function videoRow(sql: string) {
	const selected = sql
		.slice(sql.indexOf("select ") + "select ".length, sql.indexOf(" from "))
		.split(", ")
		.map((item) => item.match(/`([^`]+)`$/)?.[1] ?? item);
	for (const column of selected) {
		if (!videoColumns.has(column)) throw new Error(`Unknown column ${column}`);
	}
	return selected.map((column) => mocks.video[column] ?? null);
}

function reply(sql: string) {
	if (sql.includes("from `videos` inner join")) return [];
	if (sql.includes("from `videos`")) return [videoRow(sql)];
	if (
		sql.includes("from `space_videos`") ||
		sql.includes("from `organization_members`") ||
		sql.includes("from `space_members`") ||
		sql.includes("from `video_viewer_grants`")
	)
		return [];
	if (sql.includes("from `organizations`")) return [[null]];
	throw new Error(`Unexpected query: ${sql}`);
}

function videoReads() {
	return mocks.query.mock.calls.filter(([sql]) =>
		(sql as string).includes("from `videos`"),
	).length;
}

const actions = [
	[
		"getTranscript",
		() => getTranscript(videoId),
		{ success: true, content: "WEBVTT" },
	],
	[
		"getAvailableTranslations",
		() => getAvailableTranslations(videoId),
		{
			success: true,
			hasOriginal: true,
			translations: [{ code: "es", name: "Spanish" }],
		},
	],
	[
		"getVideoStatus",
		() => getVideoStatus(videoId),
		{ transcriptionStatus: "COMPLETE", name: "Recording", summary: "Done" },
	],
	["getVideoAnalytics", () => getVideoAnalytics(videoId), { count: 7 }],
] as const;

beforeEach(() => {
	mocks.user = null;
	mocks.verifiedPasswords = [];
	mocks.video = {
		id: videoId,
		ownerId: "owner",
		orgId: "org",
		name: "Recording",
		public: 1,
		isScreenshot: 0,
		source: { type: "desktopMP4" },
		metadata: { summary: "Done" },
		transcriptionStatus: "COMPLETE",
		createdAt: "2026-01-01 00:00:00",
		updatedAt: "2026-01-01 00:00:00",
		effectiveCreatedAt: "2026-01-01 00:00:00",
	};
	mocks.query.mockReset();
	mocks.query.mockImplementation(async (sql: string) => ({
		rows: reply(sql),
	}));
	mocks.getObject.mockReset();
	mocks.getObject.mockReturnValue(Option.some("WEBVTT"));
	mocks.listObjects.mockReset();
	mocks.listObjects.mockReturnValue({
		Contents: [
			{ Key: "owner/video-1/transcription.vtt" },
			{ Key: "owner/video-1/transcription.es.vtt" },
		],
	});
	mocks.viewCount.mockReset();
	mocks.viewCount.mockResolvedValue({ count: 7 });
});

describe("share page actions", () => {
	describe.each(actions)("%s", (_name, run, expected) => {
		it("reads the video once for a signed-out viewer", async () => {
			await expect(run()).resolves.toMatchObject(expected);
			expect(videoReads()).toBe(1);
		});

		it("reads the video once for a signed-in viewer", async () => {
			mocks.user = viewer;
			await expect(run()).resolves.toMatchObject(expected);
			expect(videoReads()).toBe(1);
		});

		it("reads the video once for its owner", async () => {
			mocks.user = { ...viewer, id: User.UserId.make("owner") };
			await expect(run()).resolves.toMatchObject(expected);
			expect(videoReads()).toBe(1);
			expect(mocks.query).toHaveBeenCalledTimes(1);
		});

		it("reads a password-protected video once after its password is verified", async () => {
			mocks.video.password = "stored-hash";
			mocks.verifiedPasswords = ["stored-hash"];
			await expect(run()).resolves.toMatchObject(expected);
			expect(videoReads()).toBe(1);
		});
	});

	it("refuses a password-protected video until its password is verified", async () => {
		mocks.video.password = "stored-hash";
		for (const verified of [[], ["another-hash"]]) {
			mocks.verifiedPasswords = verified;
			await expect(getTranscript(videoId)).resolves.toMatchObject({
				success: false,
			});
			await expect(getAvailableTranslations(videoId)).resolves.toMatchObject({
				success: false,
			});
			await expect(getVideoStatus(videoId)).resolves.toEqual({
				success: false,
			});
			await expect(getVideoAnalytics(videoId)).rejects.toThrow(
				"Video not found",
			);
		}
		expect(mocks.getObject).not.toHaveBeenCalled();
		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.viewCount).not.toHaveBeenCalled();
	});

	it("refuses a private video without touching storage or analytics", async () => {
		mocks.video.public = 0;
		await expect(getTranscript(videoId)).resolves.toMatchObject({
			success: false,
		});
		await expect(getAvailableTranslations(videoId)).resolves.toMatchObject({
			success: false,
		});
		await expect(getVideoStatus(videoId)).resolves.toEqual({ success: false });
		await expect(getVideoAnalytics(videoId)).rejects.toThrow("Video not found");
		expect(mocks.getObject).not.toHaveBeenCalled();
		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.viewCount).not.toHaveBeenCalled();
	});

	it("reports a missing video without touching storage or analytics", async () => {
		mocks.query.mockImplementation(async (sql: string) => ({
			rows: sql.includes("from `videos`") ? [] : reply(sql),
		}));
		await expect(getTranscript(videoId)).resolves.toMatchObject({
			success: false,
			message: "Video not found",
		});
		await expect(getAvailableTranslations(videoId)).resolves.toMatchObject({
			success: false,
			message: "Video not found",
		});
		await expect(getVideoStatus(videoId)).resolves.toEqual({
			success: false,
			reason: "not_found",
		});
		await expect(getVideoAnalytics(videoId)).rejects.toThrow("Video not found");
		expect(mocks.getObject).not.toHaveBeenCalled();
		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.viewCount).not.toHaveBeenCalled();
	});
});
