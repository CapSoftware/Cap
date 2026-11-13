import { randomUUID } from "node:crypto";
import {
	developerApps,
	developerVideoImports,
	developerVideos,
} from "@cap/database/schema";
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

const fixture = vi.hoisted(() => ({
	database: undefined as unknown,
	admission: { allowed: true } as Record<string, unknown>,
	createStatus: 200 as 200 | 402,
	completeResult: { status: 200, body: { success: true } } as {
		status: number;
		body: Record<string, unknown>;
	},
}));

const mocks = vi.hoisted(() => ({
	admit: vi.fn(),
	createInfraVideo: vi.fn(),
	initiate: vi.fn(),
	presign: vi.fn(),
	complete: vi.fn(),
	abort: vi.fn(),
	announce: vi.fn(),
	topUp: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "production",
	serverEnv: () => ({}),
}));
vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@/lib/developer-video-charge", () => ({
	admitDeveloperVideoUpload: mocks.admit,
}));
vi.mock("@/lib/infra-standing", () => ({
	uploadAdmissionError: (admission: Record<string, unknown>) => ({
		error: "Insufficient credits",
		code: "insufficient_credits",
		message: admission.message ?? "Insufficient credits",
	}),
}));
vi.mock("@/lib/infra-auto-top-up", () => ({ scheduleAutoTopUp: mocks.topUp }));
vi.mock("@/lib/developer-webhook-dispatch", () => ({
	announceDeveloperVideoEvent: mocks.announce,
}));
vi.mock("@/lib/infra-video-upload", () => ({
	createInfraVideo: mocks.createInfraVideo,
	initiateInfraUpload: mocks.initiate,
	presignInfraUploadParts: mocks.presign,
	completeInfraUpload: mocks.complete,
	abortInfraUpload: mocks.abort,
}));

const {
	createInfraVideoImport,
	IMPORT_MAX_PER_KEY_PER_HOUR,
	IMPORT_STALE_SLOT_MS,
	runInfraVideoImport,
} = await import("@/lib/infra-video-import");

const databaseUrl = process.env.CAP_INFRA_TEST_DATABASE_URL;
const missingTableUrl = process.env.CAP_INFRA_IMPORT_MISSING_TABLE_DATABASE_URL;
const id = () => randomUUID().replaceAll("-", "").slice(0, 15);
const database = () => fixture.database as MySql2Database;

const MP4_HEAD = new Uint8Array([
	0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00,
	0x00, 0x02, 0x00,
]);

const mp4Bytes = (length: number) => {
	const bytes = new Uint8Array(length);
	bytes.set(MP4_HEAD);
	return bytes;
};

const serving = (bytes: Uint8Array, declared = true) => ({
	isBlocked: async () => false,
	request: vi.fn(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (let offset = 0; offset < bytes.length; offset += 7) {
							controller.enqueue(bytes.slice(offset, offset + 7));
						}
						controller.close();
					},
				}),
				{
					status: 200,
					headers: {
						"content-type": "video/mp4",
						...(declared ? { "content-length": String(bytes.length) } : {}),
					},
				},
			),
	),
});

const assertLocal = (value: string | undefined, pattern: RegExp) => {
	if (!value) throw new Error("Missing isolated test database URL.");
	const url = new URL(value);
	if (
		url.protocol !== "mysql:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		!pattern.test(url.pathname)
	) {
		throw new Error("These tests require a session-scoped local database.");
	}
	return value;
};

async function seedApp() {
	const appId = id();
	await database()
		.insert(developerApps)
		.values({
			id: appId,
			ownerId: id() as never,
			name: "Import fixture",
			environment: "development",
		});
	return appId;
}

async function importRow(videoId: string) {
	const [row] = await database()
		.select()
		.from(developerVideoImports)
		.where(eq(developerVideoImports.videoId, videoId));
	return row ?? null;
}

async function videoRow(videoId: string) {
	const [row] = await database()
		.select()
		.from(developerVideos)
		.where(eq(developerVideos.id, videoId));
	return row ?? null;
}

const startImport = vi.fn(async (_videoId: string) => {});

const request = (
	appId: string,
	keyId: string,
	overrides: Partial<Parameters<typeof createInfraVideoImport>[0]> = {},
) => ({
	appId,
	keyId,
	url: "https://media.example.com/video.mp4",
	videoId: id(),
	...overrides,
});

describe.runIf(Boolean(databaseUrl))(
	"video import against a real database",
	() => {
		let pool: Pool;

		beforeAll(async () => {
			const url = assertLocal(databaseUrl, /^\/cap_infra_[a-z0-9_]+$/);
			pool = createPool({ uri: url, connectionLimit: 8 });
			fixture.database = drizzle(pool);
		});

		afterAll(async () => {
			await pool?.end();
		});

		beforeEach(() => {
			vi.clearAllMocks();
			fixture.admission = { allowed: true };
			fixture.createStatus = 200;
			fixture.completeResult = { status: 200, body: { success: true } };
			mocks.admit.mockImplementation(async () => fixture.admission);
			mocks.createInfraVideo.mockImplementation(
				async (input: { appId: string; videoId?: string; name?: string }) => {
					if (!input.videoId) return { status: 200, body: { replayed: true } };
					if (fixture.createStatus !== 200) {
						return {
							status: fixture.createStatus,
							body: {
								code: "insufficient_credits",
								error: "Insufficient credits",
							},
						};
					}
					await database()
						.insert(developerVideos)
						.values({
							id: input.videoId,
							appId: input.appId,
							name: input.name ?? "Untitled",
							s3Key: `developer/${input.appId}/${input.videoId}/video`,
						})
						.onDuplicateKeyUpdate({ set: { name: input.name ?? "Untitled" } });
					return { status: 200, body: { videoId: input.videoId } };
				},
			);
			mocks.initiate.mockImplementation(async () => ({
				status: 200,
				body: { uploadId: "upload-1" },
			}));
			mocks.complete.mockImplementation(async () => fixture.completeResult);
			mocks.abort.mockImplementation(async () => ({
				status: 200,
				body: { success: true },
			}));
		});

		describe("per-app concurrency", () => {
			it("admits two imports at once and refuses a third, even when sent together", async () => {
				const appId = await seedApp();
				const results = await Promise.all(
					Array.from({ length: 5 }, () =>
						createInfraVideoImport(request(appId, id()), {
							startImport,
							guards: serving(mp4Bytes(64)),
						}),
					),
				);
				const statuses = results.map((result) => result.status).sort();
				expect(statuses).toEqual([202, 202, 429, 429, 429]);
				const refused = results.find((result) => result.status === 429);
				expect(refused && "body" in refused && refused.body.code).toBe(
					"too_many_imports",
				);
				expect(refused && "headers" in refused && refused.headers).toEqual({
					"Retry-After": "15",
				});
				expect(startImport).toHaveBeenCalledTimes(2);
			});

			it("frees the slot when an import finishes", async () => {
				const appId = await seedApp();
				const first = request(appId, id());
				for (const input of [first, request(appId, id())]) {
					await createInfraVideoImport(input, {
						startImport,
						guards: serving(mp4Bytes(64)),
					});
				}
				await database()
					.update(developerVideoImports)
					.set({ state: "complete" })
					.where(eq(developerVideoImports.videoId, first.videoId));
				const third = await createInfraVideoImport(request(appId, id()), {
					startImport,
					guards: serving(mp4Bytes(64)),
				});
				expect(third.status).toBe(202);
			});

			it("stops counting a slot that went quiet for longer than the stale window", async () => {
				const appId = await seedApp();
				const stale = new Date(Date.now() - IMPORT_STALE_SLOT_MS - 60_000);
				for (const videoId of [id(), id()]) {
					await database().insert(developerVideoImports).values({
						videoId,
						appId,
						keyId: id(),
						sourceUrl: "https://media.example.com/old.mp4",
						startedAt: stale,
						createdAt: stale,
					});
				}
				const fresh = await createInfraVideoImport(request(appId, id()), {
					startImport,
					guards: serving(mp4Bytes(64)),
				});
				expect(fresh.status).toBe(202);
			});
		});

		describe("per-key hourly limit", () => {
			it(`refuses the ${IMPORT_MAX_PER_KEY_PER_HOUR + 1}st import in an hour with the wait in Retry-After`, async () => {
				const appId = await seedApp();
				const keyId = id();
				const now = Date.now();
				const oldest = new Date(now - 50 * 60_000);
				await database()
					.insert(developerVideoImports)
					.values(
						Array.from({ length: IMPORT_MAX_PER_KEY_PER_HOUR }, (_, index) => ({
							videoId: id(),
							appId,
							keyId,
							sourceUrl: "https://media.example.com/a.mp4",
							state: "complete" as const,
							startedAt: index === 0 ? oldest : new Date(now - 60_000),
							createdAt: index === 0 ? oldest : new Date(now - 60_000),
						})),
					);
				await database()
					.insert(developerVideoImports)
					.values({
						videoId: id(),
						appId,
						keyId,
						sourceUrl: "https://media.example.com/older.mp4",
						state: "complete",
						startedAt: new Date(now - 61 * 60_000),
						createdAt: new Date(now - 61 * 60_000),
					});

				const refused = await createInfraVideoImport(request(appId, keyId), {
					startImport,
					guards: serving(mp4Bytes(64)),
				});
				expect(refused.status).toBe(429);
				if (refused.status !== 429) return;
				expect(refused.body.code).toBe("import_rate_limited");
				const wait = Number(refused.headers?.["Retry-After"]);
				expect(wait).toBeGreaterThan(9 * 60);
				expect(wait).toBeLessThanOrEqual(10 * 60 + 5);
				expect(mocks.createInfraVideo).not.toHaveBeenCalled();

				const otherKey = await createInfraVideoImport(request(appId, id()), {
					startImport,
					guards: serving(mp4Bytes(64)),
				});
				expect(otherKey.status).toBe(202);
			});

			it("counts a refused preflight against the hour", async () => {
				const appId = await seedApp();
				const keyId = id();
				const dead = {
					isBlocked: async () => false,
					request: async () => new Response("gone", { status: 404 }),
				};
				const input = request(appId, keyId);
				const refused = await createInfraVideoImport(input, {
					startImport,
					guards: dead,
				});
				expect(refused.status).toBe(422);
				if (refused.status !== 422) return;
				expect(refused.body).toMatchObject({
					code: "url_unreachable",
					error: "The URL answered 404",
				});
				expect(Object.keys(refused.body).sort()).toEqual([
					"code",
					"docs",
					"error",
					"hint",
					"message",
				]);
				expect(await importRow(input.videoId)).toMatchObject({
					state: "failed",
					errorCode: "url_unreachable",
					keyId,
				});
				expect(await videoRow(input.videoId)).toBeNull();
			});
		});

		describe("credit admission", () => {
			it("admits on the declared size before creating anything, and refuses with 402", async () => {
				const appId = await seedApp();
				fixture.admission = { allowed: false, message: "Add credit" };
				const input = request(appId, id(), { maxResolutionTier: "2160p" });
				const result = await createInfraVideoImport(input, {
					startImport,
					guards: serving(mp4Bytes(5_000_000)),
				});
				expect(result.status).toBe(402);
				expect(mocks.admit).toHaveBeenCalledWith({
					appId,
					videoId: input.videoId,
					durationSeconds: 2,
					width: null,
					height: null,
					maxResolutionTier: "2160p",
				});
				expect(mocks.topUp).toHaveBeenCalledWith({ appId });
				expect(mocks.createInfraVideo).not.toHaveBeenCalled();
				expect(startImport).not.toHaveBeenCalled();
				expect(await importRow(input.videoId)).toMatchObject({
					state: "failed",
					errorCode: "insufficient_credits",
				});
				expect(await videoRow(input.videoId)).toBeNull();
			});

			it("releases the slot when the video itself is refused for credit", async () => {
				const appId = await seedApp();
				fixture.createStatus = 402;
				const input = request(appId, id());
				const result = await createInfraVideoImport(input, {
					startImport,
					guards: serving(mp4Bytes(64), false),
				});
				expect(result.status).toBe(402);
				expect(mocks.admit).not.toHaveBeenCalled();
				expect((await importRow(input.videoId))?.state).toBe("failed");
			});
		});

		describe("idempotency", () => {
			it("replays the same key and URL without a second download, and refuses another URL", async () => {
				const appId = await seedApp();
				const keyId = id();
				const input = request(appId, keyId, {
					idempotencyKey: "same-key",
					videoId: id(),
				});
				const first = await createInfraVideoImport(input, {
					startImport,
					guards: serving(mp4Bytes(64)),
				});
				const again = await createInfraVideoImport(input, {
					startImport,
					guards: serving(mp4Bytes(64)),
				});
				expect(first).toEqual({
					status: 202,
					videoId: input.videoId,
					replayed: false,
				});
				expect(again).toEqual({
					status: 202,
					videoId: input.videoId,
					replayed: true,
				});
				expect(startImport).toHaveBeenCalledTimes(1);

				const other = await createInfraVideoImport(
					{ ...input, url: "https://media.example.com/other.mp4" },
					{ startImport, guards: serving(mp4Bytes(64)) },
				);
				expect(other.status).toBe(409);
			});
		});

		describe("the download step", () => {
			async function seedImport(appId: string, startedAt = new Date()) {
				const videoId = id();
				await database()
					.insert(developerVideos)
					.values({
						id: videoId,
						appId,
						name: "Import",
						s3Key: `developer/${appId}/${videoId}/video`,
					});
				await database().insert(developerVideoImports).values({
					videoId,
					appId,
					keyId: id(),
					sourceUrl: "https://media.example.com/video.mp4",
					startedAt,
					createdAt: startedAt,
				});
				return videoId;
			}

			const recordingWriter = () => {
				const parts: { partNumber: number; size: number }[] = [];
				return {
					parts,
					writer: () => ({
						put: async (partNumber: number, bytes: Uint8Array) => {
							parts.push({ partNumber, size: bytes.length });
							return `etag-${partNumber}`;
						},
					}),
				};
			};

			it("streams the file into parts and completes it like an upload", async () => {
				const appId = await seedApp();
				const videoId = await seedImport(appId);
				const { parts, writer } = recordingWriter();
				const outcome = await runInfraVideoImport(videoId, {
					guards: serving(mp4Bytes(40)),
					writer,
					partBytes: 16,
				});
				expect(outcome).toBe("complete");
				expect(parts).toEqual([
					{ partNumber: 1, size: 16 },
					{ partNumber: 2, size: 16 },
					{ partNumber: 3, size: 8 },
				]);
				expect(mocks.initiate).toHaveBeenCalledWith({
					appId,
					videoId,
					contentType: "video/mp4",
					contentLength: 40,
				});
				expect(mocks.complete).toHaveBeenCalledWith({
					appId,
					videoId,
					uploadId: "upload-1",
					parts: [
						{ partNumber: 1, etag: "etag-1", size: 16 },
						{ partNumber: 2, etag: "etag-2", size: 16 },
						{ partNumber: 3, etag: "etag-3", size: 8 },
					],
					durationInSecs: 0,
				});
				expect(await importRow(videoId)).toMatchObject({
					state: "complete",
					bytes: 40,
				});
				expect(mocks.abort).not.toHaveBeenCalled();
			});

			it("stops a file that grows past the cap mid-stream and fails the video", async () => {
				const appId = await seedApp();
				const videoId = await seedImport(appId);
				const { writer } = recordingWriter();
				const outcome = await runInfraVideoImport(videoId, {
					guards: { ...serving(mp4Bytes(100), false), maxBytes: 60 },
					writer,
					partBytes: 16,
				});
				expect(outcome).toBe("failed");
				expect(mocks.abort).toHaveBeenCalledWith({
					appId,
					videoId,
					uploadId: "upload-1",
				});
				expect(mocks.complete).not.toHaveBeenCalled();
				expect(await importRow(videoId)).toMatchObject({
					state: "failed",
					errorCode: "too_large",
				});
				const video = await videoRow(videoId);
				expect(video?.status).toBe("errored");
				expect(video?.errorReason).toMatch(
					/^Import failed: The file at the URL is larger than/,
				);
				expect(mocks.announce).toHaveBeenCalledWith(
					{ id: videoId, appId },
					{ type: "video.errored" },
				);
			});

			it("fails the video when completion is refused for credit", async () => {
				const appId = await seedApp();
				const videoId = await seedImport(appId);
				fixture.completeResult = {
					status: 402,
					body: { code: "insufficient_credits", message: "Add credit" },
				};
				const outcome = await runInfraVideoImport(videoId, {
					guards: serving(mp4Bytes(40)),
					writer: recordingWriter().writer,
					partBytes: 16,
				});
				expect(outcome).toBe("failed");
				expect(await importRow(videoId)).toMatchObject({
					state: "failed",
					errorCode: "insufficient_credits",
				});
				expect((await videoRow(videoId))?.status).toBe("errored");
				expect(mocks.abort).not.toHaveBeenCalled();
			});

			it("leaves a deleted video alone", async () => {
				const appId = await seedApp();
				const videoId = await seedImport(appId);
				await database()
					.update(developerVideos)
					.set({ deletedAt: new Date() })
					.where(eq(developerVideos.id, videoId));
				const guards = serving(mp4Bytes(40));
				const outcome = await runInfraVideoImport(videoId, { guards });
				expect(outcome).toBe("failed");
				expect(guards.request).not.toHaveBeenCalled();
				expect((await importRow(videoId))?.errorCode).toBe("cancelled");
				expect((await videoRow(videoId))?.status).toBe("uploading");
				expect(mocks.announce).not.toHaveBeenCalled();
			});

			it("does not download again when a re-run comes after the deadline", async () => {
				const appId = await seedApp();
				const videoId = await seedImport(
					appId,
					new Date(Date.now() - 14 * 60_000),
				);
				const guards = serving(mp4Bytes(40));
				const outcome = await runInfraVideoImport(videoId, { guards });
				expect(outcome).toBe("failed");
				expect(guards.request).not.toHaveBeenCalled();
				expect((await importRow(videoId))?.errorCode).toBe("timeout");
				expect((await videoRow(videoId))?.status).toBe("errored");
			});

			it("does nothing for an import that already finished", async () => {
				const appId = await seedApp();
				const videoId = await seedImport(appId);
				await database()
					.update(developerVideoImports)
					.set({ state: "complete" })
					.where(eq(developerVideoImports.videoId, videoId));
				const guards = serving(mp4Bytes(40));
				expect(await runInfraVideoImport(videoId, { guards })).toBe("skipped");
				expect(guards.request).not.toHaveBeenCalled();
			});
		});
	},
);

describe.runIf(Boolean(missingTableUrl))(
	"video import before the table exists",
	() => {
		let pool: Pool;

		beforeAll(async () => {
			const url = assertLocal(
				missingTableUrl,
				/^\/cap_infra_noimport_[a-z0-9_]+$/,
			);
			pool = createPool({ uri: url, connectionLimit: 2 });
			fixture.database = drizzle(pool);
		});

		afterAll(async () => {
			await pool?.end();
		});

		it("answers 503 import_unavailable and creates nothing", async () => {
			vi.clearAllMocks();
			const appId = id();
			await database()
				.insert(developerApps)
				.values({
					id: appId,
					ownerId: id() as never,
					name: "Import fixture",
					environment: "development",
				});
			const result = await createInfraVideoImport(request(appId, id()), {
				startImport,
				guards: serving(mp4Bytes(64)),
			});
			expect(result.status).toBe(503);
			if (result.status !== 503) return;
			expect(result.body.code).toBe("import_unavailable");
			expect(mocks.createInfraVideo).not.toHaveBeenCalled();
			expect(startImport).not.toHaveBeenCalled();
		});
	},
);
