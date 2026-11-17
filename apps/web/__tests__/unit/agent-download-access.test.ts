import {
	Agent,
	DatabaseError,
	Organisation,
	Policy,
	User,
	Video,
} from "@cap/web-domain";
import { type HttpApi, HttpApiBuilder, HttpServer } from "@effect/platform";
import { drizzle } from "drizzle-orm/mysql-proxy";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Database,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";

type Settings = Record<string, unknown> | null;

const mocks = vi.hoisted(() => ({
	ownerId: "viewer",
	isMember: false,
	canView: true,
	videoSettings: null as Record<string, unknown> | null,
	organizationSettings: null as Record<string, unknown> | null,
	uploadPhase: null as string | null,
	accessFails: false,
	downloadCalls: [] as Array<{ publishedOnly?: boolean } | undefined>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "http://localhost" }),
}));
vi.mock("@cap/database/auth/auth-options", () => ({ authOptions: () => ({}) }));
vi.mock("@cap/database/emails/config", () => ({}));
vi.mock("@/actions/loom", () => ({}));
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({}));
vi.mock("@/lib/generate-ai", () => ({}));
vi.mock("@/lib/loom-csv-import", () => ({}));
vi.mock("@/lib/Notification", () => ({}));
vi.mock("@/lib/organization-provisioning", () => ({}));
vi.mock("@/lib/sync-video-storage-names", () => ({}));
vi.mock("@/lib/transcribe", () => ({}));
vi.mock("@/lib/video-processing", () => ({}));
vi.mock("@/workflows/agent-cap-operation", () => ({}));
vi.mock("@/workflows/import-loom-video", () => ({}));
vi.mock("workflow/api", () => ({}));

// The download check reads the cap and its organization through the shared
// web database client.
vi.mock("@cap/database", async () => {
	const { getTableName } = await import("drizzle-orm");
	return {
		db: () => ({
			select: () => ({
				from: (table: Parameters<typeof getTableName>[0]) => ({
					where: () => {
						if (mocks.accessFails) {
							return Promise.reject(new Error("database unavailable"));
						}
						const name = getTableName(table);
						if (name === "videos") {
							return Promise.resolve([
								{
									id: "video",
									ownerId: mocks.ownerId,
									orgId: "org",
									name: "Demo recording",
									public: true,
									password: null,
									isScreenshot: false,
									settings: mocks.videoSettings,
									source: { type: "desktopMP4" },
									createdAt: new Date(),
									updatedAt: new Date(),
								},
							]);
						}
						if (name === "organizations") {
							return Promise.resolve([
								{ settings: mocks.organizationSettings },
							]);
						}
						return Promise.resolve([]);
					},
				}),
			}),
		}),
	};
});
vi.mock("@/lib/video-download-permissions", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/video-download-permissions")
	>()),
	canUserDownloadVideo: ({
		userId,
		ownerId,
	}: {
		userId: string;
		ownerId: string;
	}) => Promise.resolve(userId === ownerId || mocks.isMember),
}));
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoLockedByShareableLinkLimit: () => Promise.resolve(false),
}));
vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: new Proxy({}, { get: (_, key) => String(key) }),
	isRateLimited: () => Promise.resolve(false),
}));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	const { resolveEffectiveVideoRules } = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	return {
		Database,
		resolveEffectiveVideoRules,
		Videos: Context.GenericTag("agent-download-test/Videos"),
		VideosPolicy: Context.GenericTag("agent-download-test/VideosPolicy"),
	};
});
vi.mock("@/lib/server", async () => {
	const { VideosPolicy } = await import("@cap/web-backend");
	return {
		runPromise: <A, E>(effect: Effect.Effect<A, E, never>) =>
			effect.pipe(
				Effect.provideService(
					VideosPolicy as never,
					{
						canViewLoaded: () =>
							mocks.canView
								? Effect.void
								: Effect.fail(new Policy.PolicyDeniedError()),
					} as never,
				),
				Effect.runPromise,
			),
	};
});

const videoId = Video.VideoId.make("video");
const userId = User.UserId.make("viewer");
const orgId = Organisation.OrganisationId.make("org");
const date = "2026-10-24 12:00:00";
const RAW_URL = "https://media.example.com/raw/result.mp4";
const PUBLISHED_URL = "https://media.example.com/published/result.mp4";

// The cap detail row the agent API reads before it answers.
const client = drizzle(async (sql) => {
	if (sql.includes("from `videos`")) {
		return {
			rows: [
				[
					"video",
					mocks.ownerId,
					"Owner",
					"org",
					"Demo recording",
					true,
					false,
					600,
					null,
					date,
					date,
					1920,
					1080,
					30,
					{ type: "desktopMP4" },
					{},
					"COMPLETE",
					null,
					null,
					0,
					0,
					mocks.uploadPhase,
					null,
				],
			],
		};
	}
	if (sql.includes("from `space_videos`")) return { rows: [] };
	throw new Error(`Unexpected query: ${sql}`);
});

let dispose: () => Promise<void>;
vi.mock("@/lib/agent-server", async () => {
	const { Videos } = await import("@cap/web-backend");
	return {
		agentApiToHandler: (
			api: Layer.Layer<
				HttpApi.Api,
				never,
				Database | Agent.AgentHttpAuthMiddleware
			>,
		) => {
			const web = HttpApiBuilder.toWebHandler(
				api.pipe(
					Layer.provide(
						Layer.succeed(
							Database,
							Database.make({
								use: (callback) =>
									Effect.tryPromise({
										try: () => callback(client as unknown as DbClient),
										catch: (cause) => new DatabaseError({ cause }),
									}),
							}),
						),
					),
					Layer.provide(
						Layer.succeed(
							Videos as never,
							{
								getByIdForViewing: () =>
									Effect.succeed(
										Option.some([
											new Video.Video({
												id: videoId,
												ownerId: User.UserId.make(mocks.ownerId),
												orgId,
												name: "Demo recording",
												public: true,
												source: { type: "desktopMP4" },
												metadata: Option.none(),
												bucketId: Option.none(),
												storageIntegrationId: Option.none(),
												folderId: Option.none(),
												transcriptionStatus: Option.some("COMPLETE"),
												width: Option.some(1920),
												height: Option.some(1080),
												duration: Option.some(600),
												createdAt: new Date(),
												updatedAt: new Date(),
											}),
											Option.none(),
										] as const),
									),
								// Mirrors Videos.getDownloadInfo: members get whatever is in the
								// bucket, including the raw upload while it is processing;
								// publishedOnly returns nothing until the upload is complete.
								getDownloadInfo: (
									_id: Video.VideoId,
									options?: { publishedOnly?: boolean },
								) =>
									Effect.sync(() => {
										mocks.downloadCalls.push(options);
										if (!options?.publishedOnly) {
											return Option.some({
												fileName: "Demo recording.mp4",
												downloadUrl: RAW_URL,
											});
										}
										if (
											mocks.uploadPhase !== null &&
											mocks.uploadPhase !== "complete"
										) {
											return Option.none();
										}
										return Option.some({
											fileName: "Demo recording.mp4",
											downloadUrl: PUBLISHED_URL,
										});
									}),
							} as never,
						),
					),
					Layer.provide(
						Layer.succeed(
							Agent.AgentHttpAuthMiddleware,
							Effect.succeed(
								Agent.AgentPrincipal.of({
									id: userId,
									email: "viewer@example.com",
									activeOrganizationId: orgId,
									scopes: new Set(["caps:read"]),
									tokenId: "token",
									tokenKind: "agent",
									expiresAt: null,
								}),
							),
						),
					),
					Layer.merge(HttpServer.layerContext),
				),
			);
			dispose = web.dispose;
			return web.handler;
		},
	};
});

const { GET } = await import("@/app/api/v1/[...route]/route");
const download = async () => {
	const response = await GET(
		new Request("http://localhost/api/v1/caps/video/download"),
	);
	return { status: response.status, body: await response.json() };
};

const OFF: Settings = { disableDownloads: true };

beforeEach(() => {
	mocks.ownerId = "viewer";
	mocks.isMember = false;
	mocks.canView = true;
	mocks.videoSettings = null;
	mocks.organizationSettings = null;
	mocks.uploadPhase = null;
	mocks.accessFails = false;
	mocks.downloadCalls = [];
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => dispose());

describe("agent API cap downloads", () => {
	describe("owners and members keep every download", () => {
		it("gives the owner the stored file even while it is processing", async () => {
			mocks.uploadPhase = "processing";
			const { status, body } = await download();
			expect(status).toBe(200);
			expect(body).toMatchObject({ url: RAW_URL });
			expect(mocks.downloadCalls).toHaveLength(1);
			expect(mocks.downloadCalls[0]?.publishedOnly).toBeFalsy();
		});

		it("gives a member the stored file when viewer downloads are off", async () => {
			mocks.ownerId = "owner";
			mocks.isMember = true;
			mocks.videoSettings = OFF;
			mocks.organizationSettings = OFF;
			const { status, body } = await download();
			expect(status).toBe(200);
			expect(body).toMatchObject({ url: RAW_URL });
			expect(mocks.downloadCalls[0]?.publishedOnly).toBeFalsy();
		});
	});

	describe("viewers who are not members", () => {
		beforeEach(() => {
			mocks.ownerId = "owner";
		});

		it("only get the published MP4 by default", async () => {
			const { status, body } = await download();
			expect(status).toBe(200);
			expect(body).toMatchObject({
				fileName: "Demo recording.mp4",
				url: PUBLISHED_URL,
			});
			expect(mocks.downloadCalls).toEqual([{ publishedOnly: true }]);
		});

		it("get nothing while the upload is still processing", async () => {
			mocks.uploadPhase = "processing";
			const { status, body } = await download();
			expect(status).toBe(409);
			expect(body).toMatchObject({ code: "NOT_READY" });
			expect(body.url).toBeUndefined();
			expect(mocks.downloadCalls).toEqual([{ publishedOnly: true }]);
		});

		it.each([
			["the cap", { videoSettings: OFF, organizationSettings: null }],
			["the organization", { videoSettings: null, organizationSettings: OFF }],
		])(
			"are refused without signing when %s turns downloads off",
			async (_, settings) => {
				mocks.videoSettings = settings.videoSettings;
				mocks.organizationSettings = settings.organizationSettings;
				const { status, body } = await download();
				expect(status).toBe(403);
				expect(body).toMatchObject({ code: "FORBIDDEN" });
				expect(mocks.downloadCalls).toEqual([]);
			},
		);

		it("are refused without signing when they fail the view gates", async () => {
			mocks.canView = false;
			const { status } = await download();
			expect(status).toBe(403);
			expect(mocks.downloadCalls).toEqual([]);
		});

		it("are refused without signing when the download check fails", async () => {
			mocks.accessFails = true;
			const { status } = await download();
			expect(status).toBe(403);
			expect(mocks.downloadCalls).toEqual([]);
		});
	});
});
