import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
import { agentCapabilities, agentStatus } from "@/lib/agent-api";
import {
	Database,
	type DbClient,
} from "../../../../packages/web-backend/src/Database";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "http://localhost" }),
}));
vi.mock("@cap/database/auth/auth-options", () => ({ authOptions: () => ({}) }));
vi.mock("@cap/database/emails/config", () => ({}));
vi.mock("@/actions/loom", () => ({}));
vi.mock("@/app/(org)/dashboard/analytics/data", () => ({}));
vi.mock("@/lib/generate-ai", () => ({}));
vi.mock("@/lib/Notification", () => ({}));
vi.mock("@/lib/organization-provisioning", () => ({}));
vi.mock("@/lib/sync-video-storage-names", () => ({}));
vi.mock("@/lib/transcribe", () => ({}));
vi.mock("@/lib/video-processing", () => ({}));
vi.mock("@/workflows/agent-cap-operation", () => ({}));
vi.mock("@/workflows/import-loom-video", () => ({}));
vi.mock("workflow/api", () => ({}));
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
		Videos: Context.GenericTag("agent-detail-test/Videos"),
	};
});

const videoId = Video.VideoId.make("video");
const userId = User.UserId.make("viewer");
const orgId = Organisation.OrganisationId.make("org");
const date = "2026-10-24 12:00:00";
const isoDate = "2026-10-24T12:00:00.000Z";
const metadata = { summary: "A ten minute recording", aiTitle: "Demo" };
let ownerId = "viewer";
let access: "allowed" | "denied" | "missing" | "locked" = "allowed";
let missingRow = false;
let failedQuery = "";
let disabled = false;
let spaceCount = 3;
let latency = 0;
let authorized = false;
let authorizationCalls = 0;
let activeQueries = 0;
let peakQueries = 0;
let queries: string[] = [];

const client = drizzle(async (sql) => {
	expect(authorized).toBe(true);
	queries.push(sql);
	peakQueries = Math.max(peakQueries, ++activeQueries);
	try {
		if (latency) await delay(latency);
		if (failedQuery && sql.includes(failedQuery)) {
			throw new Error("database unavailable");
		}
		if (sql.includes("from `videos`")) {
			return {
				rows: missingRow
					? []
					: [
							[
								"video",
								ownerId,
								"Owner",
								"org",
								"Demo recording",
								false,
								false,
								600,
								null,
								date,
								date,
								1920,
								1080,
								30,
								{ type: "desktopMP4" },
								metadata,
								"COMPLETE",
								null,
								null,
								30,
								2,
								null,
								null,
							],
						],
			};
		}
		if (sql.includes("from `space_videos`")) {
			if (sql.startsWith("select `space_videos`.`spaceId`")) {
				return { rows: [["space-0", "Space 0", "org", null, date]] };
			}
			return {
				rows: Array.from({ length: spaceCount }, (_, index) => [
					"video",
					`space-${index}`,
					`Space ${index}`,
					disabled ? { disableTranscript: true, disableComments: true } : {},
					index === 0,
				]),
			};
		}
		if (sql.includes("from `shared_videos`")) {
			return { rows: [["org", "Organization", "folder", date]] };
		}
		throw new Error(`Unexpected query: ${sql}`);
	} finally {
		activeQueries--;
	}
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
						Layer.mock(Videos, {
							_tag: "Videos",
							getByIdForViewing: () =>
								Effect.gen(function* () {
									authorizationCalls++;
									if (latency) yield* Effect.promise(() => delay(latency));
									if (access === "denied")
										return yield* new Policy.PolicyDeniedError();
									if (access === "missing") return Option.none();
									if (access === "locked")
										return yield* new Video.VerifyVideoPasswordError({
											id: videoId,
											cause: "not-provided",
										});
									authorized = true;
									return Option.some([
										new Video.Video({
											id: videoId,
											ownerId: User.UserId.make(ownerId),
											orgId,
											name: "Demo recording",
											public: false,
											source: { type: "desktopMP4" },
											metadata: Option.some(metadata),
											bucketId: Option.none(),
											storageIntegrationId: Option.none(),
											folderId: Option.none(),
											transcriptionStatus: Option.some("COMPLETE"),
											width: Option.some(1920),
											height: Option.some(1080),
											duration: Option.some(600),
											createdAt: new Date(isoDate),
											updatedAt: new Date(isoDate),
										}),
										Option.none(),
									] as const);
								}),
						}),
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
const request = (suffix = "") =>
	GET(new Request(`http://localhost/api/v1/caps/video${suffix}`));

function expectedCap() {
	return {
		id: "video",
		shareUrl: "http://localhost/s/video",
		title: "Demo recording",
		aiTitle: "Demo",
		createdAt: isoDate,
		updatedAt: isoDate,
		durationMs: 600_000,
		owner: { id: ownerId, name: "Owner" },
		organizationId: "org",
		folderId: null,
		access: ownerId === "viewer" ? "owned" : "shared",
		sharing: { public: false, protected: spaceCount > 0 },
		counts: { comments: 30, reactions: 2 },
		status: agentStatus({
			id: videoId,
			updatedAt: new Date(isoDate),
			transcriptionStatus: "COMPLETE",
			aiGenerationStatus: undefined,
			uploadPhase: null,
			uploadError: null,
		}),
		capabilities: agentCapabilities({
			isOwner: ownerId === "viewer",
			hasReadScope: true,
			hasCommentScope: false,
			hasWriteScope: false,
			hasProcessScope: false,
			hasDeleteScope: false,
			passwordRequired: false,
			transcriptStatus: "COMPLETE",
			hasSummary: true,
			hasChapters: false,
			settings: {
				disableSummary: false,
				disableChapters: false,
				disableReactions: false,
				disableTranscript: disabled,
				disableComments: disabled,
			},
		}),
	};
}

beforeEach(() => {
	ownerId = "viewer";
	access = "allowed";
	missingRow = false;
	failedQuery = "";
	disabled = false;
	spaceCount = 3;
	latency = 0;
	authorized = false;
	authorizationCalls = 0;
	activeQueries = 0;
	peakQueries = 0;
	queries = [];
});
afterAll(() => dispose());

describe("agent Cap detail reads", () => {
	it.each(["viewer", "owner"])(
		"preserves %s's summary and inherited rules",
		async (owner) => {
			ownerId = owner;
			const response = await request();
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(expectedCap());
			expect(authorizationCalls).toBe(1);
		},
	);

	it("preserves empty space rules", async () => {
		spaceCount = 0;
		const response = await request();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(expectedCap());
	});

	it("preserves disabled content and settings inheritance", async () => {
		disabled = true;
		const cap = await request();
		expect(await cap.json()).toEqual(expectedCap());
		const settings = await request("/settings");
		expect(settings.status).toBe(200);
		expect(await settings.json()).toMatchObject({
			effective: { disableTranscript: true, disableComments: true },
			inherited: {
				disableTranscript: [
					{ id: "space-0", name: "Space 0" },
					{ id: "space-1", name: "Space 1" },
					{ id: "space-2", name: "Space 2" },
				],
			},
		});
		const transcript = await request("/transcript");
		expect(transcript.status).toBe(403);
		expect(await transcript.json()).toMatchObject({ code: "CONTENT_DISABLED" });
	});

	it.each(["denied", "missing"] as const)(
		"rejects %s access before detail queries",
		async (value) => {
			access = value;
			const response = await request();
			expect(response.status).toBe(value === "denied" ? 403 : 404);
			expect(queries).toEqual([]);
		},
	);

	it("returns not found if the Cap disappears after authorization", async () => {
		missingRow = true;
		expect((await request()).status).toBe(404);
	});

	it("requires an access grant before reading password-protected details", async () => {
		access = "locked";
		const response = await request();
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "PASSWORD_REQUIRED" });
		expect(queries).toEqual([]);
	});

	it("rechecks authorization and rules for each request", async () => {
		expect((await request()).status).toBe(200);
		disabled = true;
		expect(await (await request()).json()).toEqual(expectedCap());
		access = "denied";
		queries = [];
		expect((await request()).status).toBe(403);
		expect(authorizationCalls).toBe(3);
		expect(queries).toEqual([]);
	});

	it("preserves not-found precedence when space rules also fail", async () => {
		missingRow = true;
		failedQuery = "from `space_videos`";
		expect((await request()).status).toBe(404);
	});

	it("rejects sharing-target reads for non-owners", async () => {
		ownerId = "owner";
		const response = await request("/shares");
		expect(response.status).toBe(403);
		expect(queries).toHaveLength(2);
	});

	it("preserves sharing targets and owner-only write capabilities", async () => {
		const response = await request("/shares");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: "video",
			public: false,
			protected: true,
			organizations: [
				{
					organizationId: "org",
					organizationName: "Organization",
					folderId: "folder",
					sharedAt: isoDate,
				},
			],
			spaces: [
				{
					spaceId: "space-0",
					spaceName: "Space 0",
					organizationId: "org",
					folderId: null,
					addedAt: isoDate,
				},
			],
			capabilities: { update: { allowed: false, reason: "SCOPE_REQUIRED" } },
		});
		expect(queries).toHaveLength(4);
		expect(authorizationCalls).toBe(1);
	});

	it.each(["from `videos`", "from `space_videos`"])(
		"returns retryable errors for %s failures",
		async (query) => {
			failedQuery = query;
			const response = await request();
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				code: "TEMPORARY_UNAVAILABLE",
				retryable: true,
			});
		},
	);

	it("overlaps the two detail queries after authorization", async () => {
		latency = 5;
		expect((await request()).status).toBe(200);
		expect(queries).toHaveLength(2);
		expect(peakQueries).toBe(2);
	});

	it.skipIf(!process.env.CAP_API_DETAIL_BENCH)(
		"benchmarks the GET handler with 40 ms dependency latency",
		async () => {
			latency = 40;
			for (const spaces of [0, 3, 10]) {
				spaceCount = spaces;
				await request();
				const samples: number[] = [];
				let responseHash = "";
				for (let sample = 0; sample < 9; sample++) {
					queries = [];
					peakQueries = 0;
					authorizationCalls = 0;
					authorized = false;
					const start = performance.now();
					const response = await request();
					const body = await response.text();
					samples.push(performance.now() - start);
					expect(response.status).toBe(200);
					expect(JSON.parse(body)).toEqual(expectedCap());
					responseHash = createHash("sha256").update(body).digest("hex");
				}
				console.log(
					JSON.stringify({
						spaces,
						latency,
						medianMs: samples.sort((a, b) => a - b)[4],
						sqlRequests: queries.length,
						authorizationCalls,
						peakQueries,
						responseHash,
					}),
				);
			}
		},
	);
});
