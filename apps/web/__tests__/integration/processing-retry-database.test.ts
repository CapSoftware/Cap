import { createHash, randomUUID } from "node:crypto";
import * as Db from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Drives the real agent processCap handler and the real share page retry
// routes against a real migrated MySQL database. Only the session lookup, the
// transcription provider call and the AI workflow start are stubbed, so the
// idempotency store, the rerun charge, the rate limiter and startAiGeneration's
// own state checks all run for real.

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	sessionUserId: "",
	transcribe: vi.fn(),
	startWorkflow: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => {
		const [user] = await (fixture.database as MySql2Database)
			.select()
			.from(Db.users)
			.where(eq(Db.users.id, fixture.sessionUserId as never));
		return user ?? null;
	},
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: fixture.transcribe }));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => true }));
vi.mock("workflow/api", () => ({ start: fixture.startWorkflow }));

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;

type Owner = { userId: string; orgId: string; token: string };

const createOwner = async (): Promise<Owner> => {
	const userId = id();
	const orgId = id();
	const token = `cap_cli_${randomUUID().replaceAll("-", "")}${"a".repeat(11)}`;
	await database()
		.insert(Db.users)
		.values({
			id: userId as never,
			email: `${userId}@example.com`,
			name: "Owner",
			activeOrganizationId: orgId as never,
			defaultOrgId: orgId as never,
			stripeSubscriptionStatus: "active",
		});
	await database()
		.insert(Db.organizations)
		.values({ id: orgId as never, name: "Team", ownerId: userId as never });
	await database()
		.insert(Db.organizationMembers)
		.values({
			id: id() as never,
			userId: userId as never,
			organizationId: orgId as never,
			role: "owner",
		});
	await database()
		.insert(Db.agentApiKeys)
		.values({
			id: id() as never,
			userId: userId as never,
			name: "Test agent",
			tokenHash: createHash("sha256").update(token).digest("hex"),
			scopes: ["caps:read", "caps:process"],
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		} as never);
	return { userId, orgId, token };
};

const createVideo = async (
	owner: Owner,
	state: {
		transcriptionStatus: "COMPLETE" | "ERROR" | null;
		aiGenerationStatus?: string;
	},
) => {
	const videoId = id();
	await database()
		.insert(Db.videos)
		.values({
			id: videoId as never,
			ownerId: owner.userId as never,
			orgId: owner.orgId as never,
			name: "Recording",
			transcriptionStatus: state.transcriptionStatus,
			metadata: state.aiGenerationStatus
				? { aiGenerationStatus: state.aiGenerationStatus }
				: {},
		} as never);
	return videoId;
};

const videoState = async (videoId: string) => {
	const [video] = await database()
		.select({
			transcriptionStatus: Db.videos.transcriptionStatus,
			metadata: Db.videos.metadata,
		})
		.from(Db.videos)
		.where(eq(Db.videos.id, videoId as never));
	return {
		transcriptionStatus: video?.transcriptionStatus ?? null,
		aiGenerationStatus:
			(video?.metadata as { aiGenerationStatus?: string } | null)
				?.aiGenerationStatus ?? null,
	};
};

describe.runIf(Boolean(databaseUrl))(
	"processing retries against a real database",
	() => {
		let pool: Pool;
		let v1: typeof import("@/app/api/v1/[...route]/route").POST;
		let retryAi: typeof import("@/app/api/videos/[videoId]/retry-ai/route").POST;
		let retryTranscription: typeof import("@/app/api/videos/[videoId]/retry-transcription/route").POST;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_infra_[a-z0-9_]+$/.test(url.pathname)
			)
				throw new Error("These tests require a session-scoped local database.");
			pool = createPool({ uri: databaseUrl, connectionLimit: 8 });
			fixture.database = drizzle(pool);
			Object.assign(process.env, {
				NEXT_PUBLIC_WEB_URL: "http://localhost",
				WEB_URL: "http://localhost",
				DATABASE_URL: databaseUrl,
				NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
				NEXTAUTH_URL: "http://localhost",
				CAP_AWS_BUCKET: "synthetic",
				CAP_AWS_REGION: "us-east-1",
				CAP_AWS_ACCESS_KEY: "synthetic",
				CAP_AWS_SECRET_KEY: "synthetic",
				NODE_ENV: "test",
			});
			({ POST: v1 } = await import("@/app/api/v1/[...route]/route"));
			({ POST: retryAi } = await import(
				"@/app/api/videos/[videoId]/retry-ai/route"
			));
			({ POST: retryTranscription } = await import(
				"@/app/api/videos/[videoId]/retry-transcription/route"
			));
		});

		beforeEach(() => {
			fixture.transcribe.mockResolvedValue({ success: true, message: "ok" });
			fixture.startWorkflow.mockResolvedValue(undefined);
		});

		afterAll(async () => {
			await pool?.end();
		});

		const processCap = (
			owner: Owner,
			videoId: string,
			payload: { target: "all" | "transcript" | "ai"; retry?: boolean },
			key = randomUUID(),
		) =>
			v1(
				new Request(`http://localhost/api/v1/caps/${videoId}/process`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${owner.token}`,
						"Content-Type": "application/json",
						"Idempotency-Key": key,
						"X-Cap-Confirmation": "user",
					},
					body: JSON.stringify(payload),
				}),
			);

		const sharePageRetry = (
			route: typeof retryAi,
			owner: Owner,
			videoId: string,
		) => {
			fixture.sessionUserId = owner.userId;
			return route(
				new Request(`http://localhost/api/videos/${videoId}/retry`, {
					method: "POST",
				}),
				{ params: Promise.resolve({ videoId }) } as never,
			);
		};

		it("processes a fresh video through the agent API without charging a retry", async () => {
			const owner = await createOwner();
			for (let index = 0; index < 35; index++) {
				const videoId = await createVideo(owner, {
					transcriptionStatus: "COMPLETE",
				});
				fixture.startWorkflow.mockClear();
				const response = await processCap(owner, videoId, { target: "all" });
				expect(response.status, await response.clone().text()).toBe(200);
				expect(fixture.startWorkflow).toHaveBeenCalledOnce();
				expect((await videoState(videoId)).aiGenerationStatus).toBe("QUEUED");
			}

			const pending = await createVideo(owner, { transcriptionStatus: null });
			fixture.transcribe.mockClear();
			const transcript = await processCap(owner, pending, {
				target: "transcript",
			});
			expect(transcript.status).toBe(200);
			expect(fixture.transcribe).toHaveBeenCalledOnce();
		});

		it("retries a failed transcription and a failed AI run once through the agent API", async () => {
			const owner = await createOwner();
			const failedTranscript = await createVideo(owner, {
				transcriptionStatus: "ERROR",
			});
			fixture.transcribe.mockClear();
			const transcript = await processCap(owner, failedTranscript, {
				target: "transcript",
				retry: true,
			});
			expect(transcript.status).toBe(200);
			expect(fixture.transcribe).toHaveBeenCalledOnce();
			expect((await videoState(failedTranscript)).transcriptionStatus).toBe(
				null,
			);

			const failedAi = await createVideo(owner, {
				transcriptionStatus: "COMPLETE",
				aiGenerationStatus: "ERROR",
			});
			fixture.startWorkflow.mockClear();
			const ai = await processCap(owner, failedAi, {
				target: "ai",
				retry: true,
			});
			expect(ai.status).toBe(200);
			expect(fixture.startWorkflow).toHaveBeenCalledOnce();
			expect((await videoState(failedAi)).aiGenerationStatus).toBe("QUEUED");
		});

		it("retries a failed transcription and a failed AI run once from the share page", async () => {
			const owner = await createOwner();
			const failedTranscript = await createVideo(owner, {
				transcriptionStatus: "ERROR",
			});
			const transcript = await sharePageRetry(
				retryTranscription,
				owner,
				failedTranscript,
			);
			expect(transcript.status).toBe(200);
			expect((await videoState(failedTranscript)).transcriptionStatus).toBe(
				null,
			);

			const failedAi = await createVideo(owner, {
				transcriptionStatus: "COMPLETE",
				aiGenerationStatus: "ERROR",
			});
			fixture.startWorkflow.mockClear();
			const ai = await sharePageRetry(retryAi, owner, failedAi);
			expect(ai.status).toBe(200);
			expect(fixture.startWorkflow).toHaveBeenCalledOnce();
			expect((await videoState(failedAi)).aiGenerationStatus).toBe("QUEUED");
		});

		it("only refuses retries past 30 an hour, shared across the share page and the agent API", async () => {
			const owner = await createOwner();
			for (let index = 0; index < 15; index++) {
				const videoId = await createVideo(owner, {
					transcriptionStatus: "ERROR",
				});
				expect(
					(await sharePageRetry(retryTranscription, owner, videoId)).status,
				).toBe(200);
			}
			for (let index = 0; index < 15; index++) {
				const videoId = await createVideo(owner, {
					transcriptionStatus: "ERROR",
				});
				expect(
					(
						await processCap(owner, videoId, {
							target: "transcript",
							retry: true,
						})
					).status,
				).toBe(200);
			}

			const refusedAgent = await createVideo(owner, {
				transcriptionStatus: "ERROR",
			});
			const limited = await processCap(owner, refusedAgent, {
				target: "transcript",
				retry: true,
			});
			expect(limited.status).toBe(429);
			expect((await videoState(refusedAgent)).transcriptionStatus).toBe(
				"ERROR",
			);

			const refusedSharePage = await createVideo(owner, {
				transcriptionStatus: "ERROR",
			});
			expect(
				(await sharePageRetry(retryTranscription, owner, refusedSharePage))
					.status,
			).toBe(429);
			expect((await videoState(refusedSharePage)).transcriptionStatus).toBe(
				"ERROR",
			);

			const other = await createOwner();
			const otherVideo = await createVideo(other, {
				transcriptionStatus: "ERROR",
			});
			expect(
				(await sharePageRetry(retryTranscription, other, otherVideo)).status,
			).toBe(200);

			const fresh = await createVideo(owner, {
				transcriptionStatus: "COMPLETE",
			});
			expect((await processCap(owner, fresh, { target: "all" })).status).toBe(
				200,
			);
		});

		it("replays a saved request without charging or starting AI again", async () => {
			const owner = await createOwner();
			const failedAi = await createVideo(owner, {
				transcriptionStatus: "COMPLETE",
				aiGenerationStatus: "ERROR",
			});
			const key = randomUUID();
			fixture.startWorkflow.mockClear();
			expect(
				(await processCap(owner, failedAi, { target: "ai", retry: true }, key))
					.status,
			).toBe(200);
			expect(fixture.startWorkflow).toHaveBeenCalledOnce();

			await database()
				.update(Db.videos)
				.set({ metadata: { aiGenerationStatus: "ERROR" } } as never)
				.where(eq(Db.videos.id, failedAi as never));
			fixture.startWorkflow.mockClear();
			expect(
				(await processCap(owner, failedAi, { target: "ai", retry: true }, key))
					.status,
			).toBe(200);
			expect(fixture.startWorkflow).not.toHaveBeenCalled();
		});
	},
);
