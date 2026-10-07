import { randomUUID } from "node:crypto";
import {
	importedVideos,
	loomImportJobItems,
	loomImportJobs,
	organizationMembers,
	organizations,
	spaceMembers,
	spaces,
	spaceVideos,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Organisation, User, type Video } from "@cap/web-domain";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect, Option } from "effect";
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
	database: undefined as MySql2Database | undefined,
	start: vi.fn(),
	concurrency: "2",
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({
	db: () => {
		if (!fixture.database) throw new Error("Test database is not connected.");
		return fixture.database;
	},
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	NODE_ENV: "test",
	serverEnv: () => ({
		CAP_VIDEOS_DEFAULT_PUBLIC: true,
		LOOM_IMPORT_CONCURRENCY: fixture.concurrency,
		WEB_URL: "https://cap.test",
	}),
}));
vi.mock("@cap/database/loops/queue", () => ({
	enqueueLoopsSync: vi.fn(async () => undefined),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getWritableAccessForUser: () =>
			Effect.succeed({
				bucketId: Option.none(),
				storageIntegrationId: Option.none(),
			}),
	},
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: <A, E>(effect: Effect.Effect<A, E>) =>
		Effect.runPromise(effect),
}));
vi.mock("workflow/api", () => ({ start: fixture.start }));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: "importLoomVideoWorkflow",
}));
vi.mock("@/workflows/loom-import-job", () => ({
	loomImportJobWorkflow: "loomImportJobWorkflow",
}));

import {
	dispatchLoomImportForVideo,
	dispatchLoomImportJob,
} from "@/lib/loom-import/dispatch";
import {
	cancelLoomImportJob,
	createLoomImportJob,
	listLoomImportJobs,
	markLoomImportJobStarting,
	prepareLoomImportJob,
	resetFailedLoomImportItems,
	resolveLoomImportJob,
} from "@/lib/loom-import/jobs";
import { recoverLoomImportJobs } from "@/lib/loom-import/recovery";
import {
	getLoomImportSnapshot,
	LOOM_IMPORT_CURSOR_OVERLAP_MS,
} from "@/lib/loom-import/snapshot";

const databaseUrl = process.env.CAP_LOOM_IMPORT_TEST_DATABASE_URL;

const LOOM = {
	ok1: "0dd0a01e10c742b28dbea75082c08635",
	ok2: "31f430c1a1e744b8a7b6c18a26982c71",
	ok3: "2bff5385f32643ea9d065227ebfadd0d",
	ok4: "41f6aad19fb74048a8e9dbf3105b5a6a",
	private: "43e16ce2319c4171ba9d09f7999eca16",
	missing: "ffffffffffffffffffffffffffffffff",
};

const RECORDED = {
	[LOOM.ok1]: "2022-02-15T20:02:03.132Z",
	[LOOM.ok2]: "2022-06-22T19:17:16.020Z",
	[LOOM.ok3]: "2022-06-22T19:17:34.669Z",
	[LOOM.ok4]: "2023-08-18T20:00:46.121Z",
};

function database() {
	if (!fixture.database) throw new Error("Test database is not connected.");
	return fixture.database;
}

function id() {
	return randomUUID().replaceAll("-", "").slice(0, 15);
}

function share(loomId: string) {
	return `https://www.loom.com/share/${loomId}`;
}

const loomFetchMock = vi.fn(
	async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as {
			variables: Record<string, string>;
		};
		const data: Record<string, unknown> = {};
		for (const [key, loomId] of Object.entries(body.variables)) {
			const alias = key.replace("id", "v");
			if (loomId === LOOM.private) {
				data[alias] = { __typename: "PrivateVideo", id: loomId };
			} else if (RECORDED[loomId]) {
				data[alias] = {
					__typename: "RegularUserVideo",
					name: `Video ${loomId.slice(0, 4)}`,
					createdAt: RECORDED[loomId],
					thumbnails: {
						default: `https://cdn.loom.com/sessions/thumbnails/${loomId}-00001.jpg`,
					},
					video_properties: { duration: 120.5, width: 1920, height: 1080 },
				};
			} else {
				data[alias] = null;
			}
		}
		return Response.json({ data });
	},
);
const loomFetch = loomFetchMock as unknown as typeof fetch;

async function makeOrganization({ pro }: { pro: boolean }) {
	const ownerId = User.UserId.make(id());
	const orgId = Organisation.OrganisationId.make(id());
	await database()
		.insert(users)
		.values({
			id: ownerId,
			email: `${ownerId}@example.com`,
			name: "Owner",
			activeOrganizationId: orgId,
			defaultOrgId: orgId,
			stripeSubscriptionStatus: pro ? "active" : null,
		});
	await database().insert(organizations).values({
		id: orgId,
		name: "Acme",
		ownerId,
	});
	await database().insert(organizationMembers).values({
		id: id(),
		organizationId: orgId,
		userId: ownerId,
		role: "owner",
	});
	return { ownerId, orgId };
}

async function items(jobId: string) {
	return database()
		.select()
		.from(loomImportJobItems)
		.where(eq(loomImportJobItems.jobId, jobId))
		.orderBy(asc(loomImportJobItems.rowNumber));
}

async function jobStatus(jobId: string) {
	const [job] = await database()
		.select({ status: loomImportJobs.status })
		.from(loomImportJobs)
		.where(eq(loomImportJobs.id, jobId));
	return job?.status;
}

async function finishVideo(videoId: Video.VideoId) {
	await database()
		.delete(videoUploads)
		.where(eq(videoUploads.videoId, videoId));
	return dispatchLoomImportForVideo(videoId);
}

async function failVideo(videoId: Video.VideoId, error: string) {
	await database()
		.update(videoUploads)
		.set({ phase: "error", processingError: error })
		.where(eq(videoUploads.videoId, videoId));
	return dispatchLoomImportForVideo(videoId);
}

describe.runIf(Boolean(databaseUrl))(
	"Loom CSV imports with an isolated MySQL database",
	() => {
		let pool: Pool | undefined;

		beforeAll(async () => {
			if (!databaseUrl) throw new Error("Missing isolated test database URL.");
			const url = new URL(databaseUrl);
			if (
				url.protocol !== "mysql:" ||
				!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
				!/^\/cap_loom_import_[a-z0-9_]+$/.test(url.pathname)
			) {
				throw new Error("Loom import tests require a local test database.");
			}
			pool = createPool(databaseUrl);
			fixture.database = drizzle(pool);
			await database().select().from(loomImportJobs).limit(1);
		});

		afterAll(async () => {
			await pool?.end();
			fixture.database = undefined;
		});

		beforeEach(() => {
			fixture.start.mockReset().mockResolvedValue({ runId: "run" });
			fixture.concurrency = "2";
			loomFetchMock.mockClear();
		});

		it("checks every link, waits for Pro on the free plan, then imports with original dates in a bounded window", async () => {
			const { ownerId, orgId } = await makeOrganization({ pro: false });
			const teammate = `teammate-${id()}@example.com`;
			const { jobId, totalCount } = await createLoomImportJob({
				userId: ownerId,
				orgId,
				fileName: "loom-export.csv",
				rows: [
					{
						rowNumber: 2,
						loomUrl: share(LOOM.ok1),
						ownerEmail: teammate,
						spaceName: "Sales",
					},
					{
						rowNumber: 3,
						loomUrl: `https://www.loom.com/share/My-Demo-${LOOM.ok2}?sid=1`,
					},
					{ rowNumber: 4, loomUrl: share(LOOM.ok3), spaceName: "sales" },
					{ rowNumber: 5, loomUrl: share(LOOM.private) },
					{ rowNumber: 6, loomUrl: share(LOOM.missing) },
					{ rowNumber: 7, loomUrl: "https://example.com/not-loom" },
					{ rowNumber: 8, loomUrl: share(LOOM.ok1) },
					{ rowNumber: 9, loomUrl: share(LOOM.ok4) },
				],
			});
			expect(totalCount).toBe(8);

			await resolveLoomImportJob(jobId, { fetchImpl: loomFetch });
			expect(loomFetchMock).toHaveBeenCalledTimes(1);
			const resolved = await items(jobId);
			expect(resolved.map((item) => [item.rowNumber, item.status])).toEqual([
				[2, "ready"],
				[3, "ready"],
				[4, "ready"],
				[5, "failed"],
				[6, "failed"],
				[7, "failed"],
				[8, "skipped"],
				[9, "ready"],
			]);
			expect(resolved[0]).toMatchObject({
				title: `Video ${LOOM.ok1.slice(0, 4)}`,
				durationSeconds: 120.5,
				width: 1920,
				thumbnailUrl: `https://cdn.loom.com/sessions/thumbnails/${LOOM.ok1}-00001.jpg`,
			});
			expect(resolved[0]?.loomCreatedAt?.toISOString()).toBe(
				RECORDED[LOOM.ok1],
			);
			expect(resolved[1]?.loomVideoId).toBe(LOOM.ok2);
			expect(resolved[3]?.error).toContain("private");
			expect(resolved[6]?.error).toBe("Same video as row 2.");

			expect(await prepareLoomImportJob(jobId)).toBe("awaiting_upgrade");
			const waiting = await getLoomImportSnapshot({ jobId, userId: ownerId });
			expect(waiting?.job).toMatchObject({
				status: "awaiting_upgrade",
				canStart: false,
				isPro: false,
			});
			expect(waiting?.counts).toMatchObject({
				ready: 4,
				failed: 3,
				skipped: 1,
			});
			expect(waiting?.totalDuration).toBeCloseTo(482);
			expect(fixture.start).not.toHaveBeenCalled();
			expect(
				await database().select().from(videos).where(eq(videos.orgId, orgId)),
			).toEqual([]);

			await database()
				.update(users)
				.set({ stripeSubscriptionStatus: "active" })
				.where(eq(users.id, ownerId));
			expect(
				(await getLoomImportSnapshot({ jobId, userId: ownerId }))?.job.canStart,
			).toBe(true);
			expect(await markLoomImportJobStarting(jobId)).toBe(true);
			expect(await markLoomImportJobStarting(jobId)).toBe(false);
			await resolveLoomImportJob(jobId, { fetchImpl: loomFetch });
			expect(await prepareLoomImportJob(jobId)).toBe("importing");

			const [teammateUser] = await database()
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, teammate));
			expect(teammateUser).toBeDefined();
			const [salesSpace, ...otherSpaces] = await database()
				.select({ id: spaces.id, name: spaces.name })
				.from(spaces)
				.where(eq(spaces.organizationId, orgId));
			expect(otherSpaces).toEqual([]);
			if (!salesSpace) throw new Error("Expected the Sales space to exist.");
			expect(salesSpace.name).toBe("Sales");
			const members = await database()
				.select({ userId: spaceMembers.userId, role: spaceMembers.role })
				.from(spaceMembers)
				.where(eq(spaceMembers.spaceId, salesSpace.id));
			expect(members).toEqual(
				expect.arrayContaining([
					{ userId: ownerId, role: "admin" },
					{ userId: teammateUser?.id, role: "member" },
				]),
			);

			expect(await dispatchLoomImportJob(jobId)).toEqual({
				started: 2,
				completed: false,
			});
			let state = await items(jobId);
			expect(
				state
					.filter((item) => item.status === "importing")
					.map((item) => item.rowNumber),
			).toEqual([2, 3]);
			expect(fixture.start).toHaveBeenCalledTimes(2);
			const first = state[0];
			const firstVideoId = first?.videoId as Video.VideoId;
			const [firstVideo] = await database()
				.select()
				.from(videos)
				.where(eq(videos.id, firstVideoId));
			expect(firstVideo).toMatchObject({
				ownerId: teammateUser?.id,
				orgId,
				name: `Video ${LOOM.ok1.slice(0, 4)}`,
				duration: 120.5,
				transcriptionStatus: null,
			});
			expect(firstVideo?.metadata).toEqual({
				customCreatedAt: RECORDED[LOOM.ok1],
			});
			expect(firstVideo?.effectiveCreatedAt?.toISOString().slice(0, 19)).toBe(
				RECORDED[LOOM.ok1]?.slice(0, 19),
			);
			const [upload] = await database()
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, firstVideoId));
			expect(upload?.rawFileKey).toBe(
				`${teammateUser?.id}/${firstVideoId}/raw-upload.mp4`,
			);
			expect(
				await database()
					.select()
					.from(spaceVideos)
					.where(eq(spaceVideos.videoId, firstVideoId)),
			).toHaveLength(1);
			expect(fixture.start.mock.calls[0]?.[1]?.[0]).toMatchObject({
				videoId: firstVideoId,
				userId: teammateUser?.id,
				loomVideoId: LOOM.ok1,
			});

			expect(await dispatchLoomImportJob(jobId)).toEqual({
				started: 0,
				completed: false,
			});

			await finishVideo(firstVideoId);
			state = await items(jobId);
			expect(state[0]?.status).toBe("complete");
			expect(
				state
					.filter((item) => item.status === "importing")
					.map((item) => item.rowNumber),
			).toEqual([3, 4]);

			await failVideo(
				state[1]?.videoId as Video.VideoId,
				"Media server unavailable",
			);
			state = await items(jobId);
			expect(state[1]).toMatchObject({
				status: "failed",
				error: "Media server unavailable",
			});
			expect(state[7]?.status).toBe("importing");

			const live = await getLoomImportSnapshot({ jobId, userId: ownerId });
			expect(live?.counts).toMatchObject({
				imported: 1,
				importing: 2,
				failed: 4,
				skipped: 1,
			});
			const earlier = new Date(Date.now() - 60_000);
			await database()
				.update(loomImportJobItems)
				.set({ updatedAt: earlier })
				.where(eq(loomImportJobItems.jobId, jobId));
			for (const item of state) {
				if (!item.videoId) continue;
				await database()
					.update(videos)
					.set({ updatedAt: earlier })
					.where(eq(videos.id, item.videoId));
				await database()
					.update(videoUploads)
					.set({ updatedAt: earlier })
					.where(eq(videoUploads.videoId, item.videoId));
			}
			const pollStartedAt = Date.now();
			const settledView = await getLoomImportSnapshot({
				jobId,
				userId: ownerId,
			});
			expect(settledView?.cursor).toBeGreaterThanOrEqual(pollStartedAt);
			const quiet = await getLoomImportSnapshot({
				jobId,
				userId: ownerId,
				since:
					(settledView?.cursor ?? 0) + LOOM_IMPORT_CURSOR_OVERLAP_MS + 1_000,
			});
			expect(quiet?.items).toEqual([]);
			const lastPoll = Date.now() - 1_000;
			await database()
				.update(videoUploads)
				.set({ processingProgress: 40, updatedAt: new Date() })
				.where(eq(videoUploads.videoId, state[7]?.videoId as Video.VideoId));
			const delta = await getLoomImportSnapshot({
				jobId,
				userId: ownerId,
				since: lastPoll + LOOM_IMPORT_CURSOR_OVERLAP_MS,
			});
			expect(delta?.full).toBe(false);
			expect(
				delta?.items.map((item) => [item.row, item.status, item.progress]),
			).toEqual([[9, "importing", 40]]);
			expect(delta?.counts.total).toBe(8);

			await finishVideo(state[2]?.videoId as Video.VideoId);
			await finishVideo(state[7]?.videoId as Video.VideoId);
			expect(await jobStatus(jobId)).toBe("completed");

			const retried = await resetFailedLoomImportItems(jobId);
			expect(retried).toBe(3);
			expect(await jobStatus(jobId)).toBe("checking");
			state = await items(jobId);
			expect(state[1]).toMatchObject({ status: "ready", error: null });
			expect(state[4]?.status).toBe("pending");
			await resolveLoomImportJob(jobId, { fetchImpl: loomFetch });
			expect(await prepareLoomImportJob(jobId)).toBe("importing");
			fixture.start.mockClear();
			expect((await dispatchLoomImportJob(jobId)).started).toBe(1);
			expect(fixture.start.mock.calls[0]?.[1]?.[0]).toMatchObject({
				videoId: state[1]?.videoId,
				reuseExistingRawUpload: true,
			});

			const [summary] = await listLoomImportJobs({ userId: ownerId, orgId });
			expect(summary).toMatchObject({ id: jobId, imported: 3, totalCount: 8 });
		});

		it("skips videos already in Cap and stops queued work when cancelled", async () => {
			const { ownerId, orgId } = await makeOrganization({ pro: true });
			fixture.concurrency = "1";
			const first = await createLoomImportJob({
				userId: ownerId,
				orgId,
				fileName: "first.csv",
				rows: [{ rowNumber: 2, loomUrl: share(LOOM.ok1) }],
			});
			await resolveLoomImportJob(first.jobId, { fetchImpl: loomFetch });
			await prepareLoomImportJob(first.jobId);
			await dispatchLoomImportJob(first.jobId);

			const second = await createLoomImportJob({
				userId: ownerId,
				orgId,
				fileName: "second.csv",
				rows: [
					{ rowNumber: 2, loomUrl: share(LOOM.ok1) },
					{ rowNumber: 3, loomUrl: share(LOOM.ok2) },
					{ rowNumber: 4, loomUrl: share(LOOM.ok3) },
				],
			});
			await resolveLoomImportJob(second.jobId, { fetchImpl: loomFetch });
			const [duplicate] = await items(second.jobId);
			const [existing] = await database()
				.select({ id: importedVideos.id })
				.from(importedVideos)
				.where(
					and(
						eq(importedVideos.orgId, orgId),
						eq(importedVideos.sourceId, LOOM.ok1),
					),
				);
			expect(duplicate).toMatchObject({
				status: "skipped",
				error: "Already in Cap.",
				videoId: existing?.id,
			});

			await prepareLoomImportJob(second.jobId);
			await dispatchLoomImportJob(second.jobId);
			await cancelLoomImportJob(second.jobId);
			const state = await items(second.jobId);
			expect(state.map((item) => item.status)).toEqual([
				"skipped",
				"importing",
				"cancelled",
			]);
			expect(await jobStatus(second.jobId)).toBe("cancelled");
			expect(await dispatchLoomImportJob(second.jobId)).toEqual({
				started: 0,
				completed: false,
			});

			await finishVideo(state[1]?.videoId as Video.VideoId);
			expect((await items(second.jobId))[1]).toMatchObject({
				status: "complete",
				error: null,
			});
			expect(await jobStatus(second.jobId)).toBe("cancelled");
		});

		it("marks a failed video imported once a retry from the video page finishes, even after the import ended", async () => {
			const { ownerId, orgId } = await makeOrganization({ pro: true });
			const { jobId } = await createLoomImportJob({
				userId: ownerId,
				orgId,
				fileName: "retry.csv",
				rows: [{ rowNumber: 2, loomUrl: share(LOOM.ok1) }],
			});
			await resolveLoomImportJob(jobId, { fetchImpl: loomFetch });
			await prepareLoomImportJob(jobId);
			await dispatchLoomImportJob(jobId);
			const videoId = (await items(jobId))[0]?.videoId as Video.VideoId;
			await failVideo(videoId, "Media server unavailable");
			expect(await jobStatus(jobId)).toBe("completed");
			expect((await items(jobId))[0]).toMatchObject({
				status: "failed",
				error: "Media server unavailable",
			});

			await database()
				.update(videoUploads)
				.set({
					phase: "processing",
					processingError: null,
					processingMessage: "Retrying Loom import...",
				})
				.where(eq(videoUploads.videoId, videoId));
			await dispatchLoomImportForVideo(videoId);
			expect((await items(jobId))[0]?.status).toBe("failed");
			expect(
				(await getLoomImportSnapshot({ jobId, userId: ownerId }))?.counts
					.importing,
			).toBe(1);

			await finishVideo(videoId);
			expect((await items(jobId))[0]).toMatchObject({
				status: "complete",
				error: null,
				videoId,
			});
			const finished = await getLoomImportSnapshot({ jobId, userId: ownerId });
			expect(finished?.counts).toMatchObject({ imported: 1, failed: 0 });
			expect(finished?.items[0]).toMatchObject({ status: "imported", videoId });
			expect(await jobStatus(jobId)).toBe("completed");
			const [summary] = await listLoomImportJobs({ userId: ownerId, orgId });
			expect(summary).toMatchObject({ id: jobId, imported: 1, failed: 0 });

			await database()
				.update(loomImportJobItems)
				.set({ status: "failed", error: "Media server unavailable" })
				.where(eq(loomImportJobItems.jobId, jobId));
			expect(await resetFailedLoomImportItems(jobId)).toBe(0);
			expect((await items(jobId))[0]).toMatchObject({
				status: "complete",
				error: null,
			});
			expect(await jobStatus(jobId)).toBe("completed");
		});

		it("restarts a stuck import only once when two recovery runs overlap", async () => {
			const { ownerId, orgId } = await makeOrganization({ pro: true });
			const stuck = await createLoomImportJob({
				userId: ownerId,
				orgId,
				fileName: "stuck.csv",
				rows: [{ rowNumber: 2, loomUrl: share(LOOM.ok1) }],
			});
			await resolveLoomImportJob(stuck.jobId, { fetchImpl: loomFetch });
			expect(await prepareLoomImportJob(stuck.jobId)).toBe("importing");
			await dispatchLoomImportJob(stuck.jobId);
			const videoId = (await items(stuck.jobId))[0]?.videoId as Video.VideoId;
			const checking = await createLoomImportJob({
				userId: ownerId,
				orgId,
				fileName: "checking.csv",
				rows: [{ rowNumber: 2, loomUrl: share(LOOM.ok2) }],
			});
			const ours = [stuck.jobId, checking.jobId];

			await database()
				.update(loomImportJobs)
				.set({ status: "cancelled" })
				.where(
					and(
						inArray(loomImportJobs.status, ["checking", "importing"]),
						notInArray(loomImportJobs.id, ours),
					),
				);
			const longAgo = new Date(Date.now() - 60 * 60 * 1000);
			await database()
				.update(loomImportJobs)
				.set({ updatedAt: longAgo })
				.where(inArray(loomImportJobs.id, ours));
			await database()
				.update(videoUploads)
				.set({ updatedAt: longAgo })
				.where(eq(videoUploads.videoId, videoId));
			fixture.start.mockClear();

			const runs = await Promise.all([
				recoverLoomImportJobs(),
				recoverLoomImportJobs(),
			]);

			const startsFor = (workflow: string, key: string, value: string) =>
				fixture.start.mock.calls.filter(
					([started, [payload]]) =>
						started === workflow &&
						(payload as Record<string, unknown>)[key] === value,
				);
			expect(
				startsFor("importLoomVideoWorkflow", "videoId", videoId),
			).toHaveLength(1);
			expect(
				startsFor("loomImportJobWorkflow", "jobId", checking.jobId),
			).toHaveLength(1);
			expect(runs.reduce((sum, run) => sum + run.restarted, 0)).toBe(1);
			expect(runs.reduce((sum, run) => sum + run.resumed, 0)).toBe(1);
			const [upload] = await database()
				.select()
				.from(videoUploads)
				.where(eq(videoUploads.videoId, videoId));
			expect(upload).toMatchObject({
				phase: "uploading",
				processingMessage: "Retrying Loom import...",
			});

			fixture.start.mockClear();
			await recoverLoomImportJobs();
			expect(fixture.start).not.toHaveBeenCalled();
		});

		it("rejects files over the 2,000 video limit without creating anything", async () => {
			const { ownerId, orgId } = await makeOrganization({ pro: true });
			const rows = Array.from({ length: 2001 }, (_, index) => ({
				rowNumber: index + 2,
				loomUrl: share(`a${index.toString(16).padStart(31, "0")}`),
			}));
			await expect(
				createLoomImportJob({
					userId: ownerId,
					orgId,
					fileName: "big.csv",
					rows,
				}),
			).rejects.toThrow("Split your list");
			expect(
				await database()
					.select()
					.from(loomImportJobs)
					.where(eq(loomImportJobs.orgId, orgId)),
			).toEqual([]);
		});

		it("limits how many imports one person can start in an hour", async () => {
			const { ownerId, orgId } = await makeOrganization({ pro: false });
			const rows = [{ rowNumber: 2, loomUrl: share(LOOM.ok1) }];
			for (let index = 0; index < 30; index++) {
				await createLoomImportJob({
					userId: ownerId,
					orgId,
					fileName: `${index}.csv`,
					rows,
				});
			}
			await expect(
				createLoomImportJob({
					userId: ownerId,
					orgId,
					fileName: "one-more.csv",
					rows,
				}),
			).rejects.toThrow("a lot of imports");
		});

		it("creates a 2,000 video import in one request", async () => {
			const { ownerId, orgId } = await makeOrganization({ pro: true });
			const rows = Array.from({ length: 2000 }, (_, index) => ({
				rowNumber: index + 2,
				loomUrl: share(`b${index.toString(16).padStart(31, "0")}`),
			}));
			const startedAt = performance.now();
			const { jobId, totalCount } = await createLoomImportJob({
				userId: ownerId,
				orgId,
				fileName: "big.csv",
				rows,
			});
			const elapsed = performance.now() - startedAt;
			expect(totalCount).toBe(2000);
			expect(await items(jobId)).toHaveLength(2000);
			const snapshotStartedAt = performance.now();
			const snapshot = await getLoomImportSnapshot({ jobId, userId: ownerId });
			const snapshotElapsed = performance.now() - snapshotStartedAt;
			expect(snapshot?.counts.checking).toBe(2000);
			console.info(
				`[loom-import benchmark] create 2000 rows: ${elapsed.toFixed(0)}ms, full snapshot: ${snapshotElapsed.toFixed(0)}ms`,
			);
		});
	},
);
