import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerCreditAccounts,
	developerVideos,
} from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect } from "effect";
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Counts the database statements and storage calls one upload completion and
// one kick start make, against a real MySQL. Storage, the media server and the
// workflow runtime are stand-ins that count their calls. Opt in with
// CAP_INFRA_ROUND_TRIPS_DATABASE_URL; rows are created under fresh ids and
// removed afterwards.

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	statements: [] as string[],
	storage: [] as string[],
	storageDelayMs: 0,
	kicks: [] as Promise<unknown>[],
	objectBytes: 64 * 1024 * 1024,
}));

const storageCall = async <T>(name: string, value: T) => {
	fixture.storage.push(name);
	if (fixture.storageDelayMs > 0)
		await new Promise((resolve) => setTimeout(resolve, fixture.storageDelayMs));
	return value;
};

vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true", NEXT_PUBLIC_WEB_URL: "https://web" },
	serverEnv: () => ({ WEB_URL: "https://web" }),
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {
		getBucketAccess: () =>
			Effect.succeed([
				{
					multipart: {
						listParts: () =>
							Effect.promise(() =>
								storageCall("ListParts", [
									{ PartNumber: 1, ETag: '"e1"', Size: fixture.objectBytes },
								]),
							),
						complete: () =>
							Effect.promise(() => storageCall("CompleteMultipartUpload", {})),
					},
					headObject: () =>
						Effect.promise(() =>
							storageCall("HeadObject", { ContentLength: fixture.objectBytes }),
						),
					deleteObject: () =>
						Effect.promise(() => storageCall("DeleteObject", {})),
				},
			]),
	},
}));
vi.mock("@/lib/server", () => ({
	runPromise: (effect: Effect.Effect<unknown, unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("@/lib/developer-video-storage", () => ({
	headDeveloperVideoObject: (key: string) =>
		storageCall(`HEAD ${key.split("/").slice(3).join("/")}`, {
			bytes: fixture.objectBytes,
			contentType: "video/mp4",
		}),
	internalDeveloperVideoUrl: async (key: string) => `https://storage/${key}`,
	developerVideoUploadUrl: async (key: string) => `https://storage/${key}`,
	readDeveloperVideoText: (key: string) =>
		storageCall(`GET ${key.split("/").slice(3).join("/")}`, null),
	deleteDeveloperVideoObjects: async () => 0,
	developerVideoPrefix: () => "prefix/",
}));
vi.mock("@/lib/media-container", () => ({
	sniffMediaUrl: () => storageCall("ranged GET (sniff)", "media"),
}));
vi.mock("@/lib/media-client", () => ({
	MEDIA_SERVER_SHUTDOWN_MESSAGE: "shutdown",
	tryProbeVideoViaMediaServer: () =>
		storageCall("media server probe", {
			status: "ok",
			metadata: { width: 1920, height: 1080, duration: 60, fps: 30 },
		}),
	startMediaServerVideoJob: (path: string) =>
		storageCall(`media server ${path}`, {
			status: "started",
			jobId: `job-${path}`,
		}),
	readMediaServerVideoJob: async () => ({ status: "unreachable" }),
}));
vi.mock("next/server", () => ({
	after: (promise: Promise<unknown>) => {
		fixture.kicks.push(promise);
	},
}));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({})) }));
vi.mock("@/workflows/process-developer-video", () => ({
	processDeveloperVideoWorkflow: "workflow",
}));

const databaseUrl = process.env.CAP_INFRA_ROUND_TRIPS_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 13);
const database = () => fixture.database as MySql2Database;

const statementText = (query: unknown) =>
	(typeof query === "string"
		? query
		: String((query as { sql?: string })?.sql ?? query)
	)
		.replace(/\s+/g, " ")
		.trim();

function countStatements<T extends Pool | PoolConnection>(target: T): T {
	for (const method of ["query", "execute"] as const) {
		const original = target[method].bind(target) as (
			...args: unknown[]
		) => unknown;
		Object.defineProperty(target, method, {
			configurable: true,
			value: (...args: unknown[]) => {
				fixture.statements.push(statementText(args[0]));
				return original(...args);
			},
		});
	}
	return target;
}

function summary(statements: readonly string[]) {
	let lockedFrom = -1;
	let lockHeld = 0;
	statements.forEach((statement, index) => {
		if (
			/developer_credit_accounts/.test(statement) &&
			/for update/i.test(statement)
		) {
			lockedFrom = index;
		}
		if (/^commit/i.test(statement) && lockedFrom >= 0) {
			lockHeld += index - lockedFrom;
			lockedFrom = -1;
		}
	});
	return {
		roundTrips: statements.length,
		transactions: statements.filter((s) => /^begin/i.test(s)).length,
		statementsUnderAccountLock: lockHeld,
	};
}

const statementList = () =>
	process.env.CAP_INFRA_ROUND_TRIPS_STATEMENTS
		? { statements: fixture.statements.map((s) => s.slice(0, 110)) }
		: {};

describe.runIf(Boolean(databaseUrl))(
	"Cap Infra upload round trips against a real database",
	() => {
		let pool: Pool;
		const appId = `rt${id()}`;
		const ownerId = `rt${id()}`;
		const videoIds: string[] = [];

		beforeAll(async () => {
			pool = createPool({ uri: databaseUrl, connectionLimit: 4 });
			countStatements(pool);
			const getConnection = pool.getConnection.bind(pool);
			Object.defineProperty(pool, "getConnection", {
				configurable: true,
				value: async () => countStatements(await getConnection()),
			});
			fixture.database = drizzle(pool);
			await database().insert(developerApps).values({
				id: appId,
				ownerId,
				name: "round trips",
				environment: "development",
			});
			await database()
				.insert(developerCreditAccounts)
				.values({
					id: `rt${id()}`,
					appId,
					ownerId,
					balanceMicroCredits: 1_000_000_000,
				});
		});

		afterAll(async () => {
			if (!pool) return;
			for (const videoId of videoIds) {
				await database()
					.delete(developerVideos)
					.where(eq(developerVideos.id, videoId));
			}
			await database()
				.delete(developerCreditAccounts)
				.where(eq(developerCreditAccounts.appId, appId));
			await database().delete(developerApps).where(eq(developerApps.id, appId));
			await pool.end();
		});

		it("counts one completion, its kick start and the webhook settle", async () => {
			const { completeInfraUpload } = await import("@/lib/infra-video-upload");
			const { applyDeveloperVideoProgress } = await import(
				"@/lib/developer-video-processing"
			);
			const videoId = `rt${id()}`;
			videoIds.push(videoId);
			await database()
				.insert(developerVideos)
				.values({
					id: videoId,
					appId,
					s3Key: `developer/${appId}/${videoId}/video`,
					playbackId: `rt${id()}`,
				});

			fixture.statements.length = 0;
			fixture.storage.length = 0;
			const completed = await completeInfraUpload({
				appId,
				videoId,
				uploadId: "upload",
				parts: [{ partNumber: 1, etag: "e1", size: fixture.objectBytes }],
				durationInSecs: 60,
				width: 1920,
				height: 1080,
			});
			expect(completed.status).toBe(200);
			const complete = {
				...summary(fixture.statements),
				storage: [...fixture.storage],
				...statementList(),
			};

			fixture.statements.length = 0;
			fixture.storage.length = 0;
			expect(fixture.kicks).toHaveLength(1);
			await Promise.all(fixture.kicks.splice(0));
			const kick = {
				...summary(fixture.statements),
				storage: [...fixture.storage],
				...statementList(),
			};

			const [row] = await database()
				.select({ processing: developerVideos.processing })
				.from(developerVideos)
				.where(eq(developerVideos.id, videoId));
			const mp4 = row?.processing?.mp4;
			expect(mp4?.state).toBe("running");
			expect(row?.processing?.hls.state).toBe("running");

			fixture.statements.length = 0;
			fixture.storage.length = 0;
			fixture.storageDelayMs = 50;
			const settleStarted = performance.now();
			const settled = await applyDeveloperVideoProgress(
				{ videoId, jobId: "job", phase: "complete" },
				"mp4",
				mp4?.state === "running" ? mp4.token : null,
			);
			const settleMs = Math.round(performance.now() - settleStarted);
			fixture.storageDelayMs = 0;
			expect(settled.applied).toBe(true);
			const settle = {
				...summary(fixture.statements),
				storage: [...fixture.storage],
				...statementList(),
				wallMsWith50msStorage: settleMs,
			};

			console.log(
				JSON.stringify({ complete, kick, settleMp4: settle }, null, 2),
			);
		});
	},
);
