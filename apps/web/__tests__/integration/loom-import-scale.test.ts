import { randomUUID } from "node:crypto";
import {
	importedVideos,
	loomImportJobItems,
	loomImportJobs,
	organizationMembers,
	organizations,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect, Option } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	database: undefined as MySql2Database | undefined,
	start: vi.fn(),
	sleepScale: 0.05,
	queries: 0,
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
vi.mock("workflow", () => ({
	sleep: async (duration: string) => {
		const seconds = Number.parseFloat(duration);
		await new Promise((resolve) =>
			setTimeout(resolve, seconds * 1000 * fixture.sleepScale),
		);
	},
}));
vi.mock("workflow/api", () => ({ start: fixture.start }));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: "importLoomVideoWorkflow",
}));

import {
	dispatchLoomImportForVideo,
	dispatchLoomImports,
	loomImportConcurrency,
	loomImportGlobalConcurrency,
} from "@/lib/loom-import/dispatch";
import {
	cancelLoomImportJob,
	createLoomImportJob,
} from "@/lib/loom-import/jobs";
import { getLoomImportSnapshot } from "@/lib/loom-import/snapshot";
import { loomImportJobWorkflow } from "@/workflows/loom-import-job";

const databaseUrl = process.env.CAP_LOOM_IMPORT_TEST_DATABASE_URL;
const enabled =
	Boolean(databaseUrl) && process.env.CAP_LOOM_IMPORT_SCALE_TEST === "1";

const LOOM_CAPACITY = 16;
const MEDIA_CAPACITY = 9;
const FAILURE_RATE = 0.01;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function database() {
	if (!fixture.database) throw new Error("Test database is not connected.");
	return fixture.database;
}

function id() {
	return randomUUID().replaceAll("-", "").slice(0, 15);
}

function percentile(values: number[], fraction: number) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0
	);
}

function stats(values: number[]) {
	return {
		count: values.length,
		p50: Math.round(percentile(values, 0.5)),
		p95: Math.round(percentile(values, 0.95)),
		max: Math.round(Math.max(0, ...values)),
	};
}

type Simulation = {
	loom: {
		active: number;
		most: number;
		requests: number;
		limited: number;
		errors: number;
	};
	media: {
		active: number;
		most: number;
		turnedAway: number;
		completed: number;
		failed: number;
	};
	dispatchMs: number[];
	running: Set<Promise<void>>;
	launched: number;
	errors: number;
	processing: [number, number];
};

function newSimulation(processing: [number, number]): Simulation {
	return {
		loom: { active: 0, most: 0, requests: 0, limited: 0, errors: 0 },
		media: { active: 0, most: 0, turnedAway: 0, completed: 0, failed: 0 },
		dispatchMs: [],
		running: new Set(),
		launched: 0,
		errors: 0,
		processing,
	};
}

function fakeLoom(simulation: Simulation): typeof fetch {
	return (async (_url: string | URL | Request, init?: RequestInit) => {
		const { loom } = simulation;
		loom.requests++;
		if (loom.active >= LOOM_CAPACITY) {
			loom.limited++;
			return new Response("slow down", {
				status: 429,
				headers: { "Retry-After": "0.2" },
			});
		}
		if (Math.random() < 0.02) {
			loom.errors++;
			return new Response("unavailable", { status: 503 });
		}
		loom.active++;
		loom.most = Math.max(loom.most, loom.active);
		try {
			await wait(30 + Math.random() * 40);
			const { variables } = JSON.parse(String(init?.body)) as {
				variables: Record<string, string>;
			};
			const data: Record<string, unknown> = {};
			for (const [key, loomId] of Object.entries(variables)) {
				data[key.replace("id", "v")] = {
					__typename: "RegularUserVideo",
					name: `Recording ${loomId.slice(0, 6)}`,
					createdAt: "2023-03-14T15:09:26.535Z",
					thumbnails: {
						default: `https://cdn.loom.com/sessions/thumbnails/${loomId}-00001.jpg`,
					},
					video_properties: { duration: 95, width: 1920, height: 1080 },
				};
			}
			return Response.json({ data });
		} finally {
			loom.active--;
		}
	}) as typeof fetch;
}

async function timedDispatch(simulation: Simulation, videoId: string) {
	const startedAt = performance.now();
	await dispatchLoomImportForVideo(videoId);
	simulation.dispatchMs.push(performance.now() - startedAt);
}

async function simulateVideo(simulation: Simulation, videoId: Video.VideoId) {
	const { media } = simulation;
	const upload = (values: Partial<typeof videoUploads.$inferInsert>) =>
		database()
			.update(videoUploads)
			.set({ ...values, updatedAt: new Date() })
			.where(eq(videoUploads.videoId, videoId));

	while (media.active >= MEDIA_CAPACITY) {
		media.turnedAway++;
		await upload({ processingMessage: "Queued for Loom import processing..." });
		await wait(100 + Math.random() * 100);
	}
	media.active++;
	media.most = Math.max(media.most, media.active);
	await upload({
		phase: "processing",
		processingProgress: 0,
		processingMessage: "Starting video processing...",
	});
	await timedDispatch(simulation, videoId);
	const [shortest, longest] = simulation.processing;
	const duration = shortest + Math.random() * (longest - shortest);
	await wait(duration / 2);
	await upload({
		processingProgress: 50,
		processingMessage: "Processing video",
	});
	await wait(duration / 2);
	media.active--;
	if (Math.random() < FAILURE_RATE) {
		media.failed++;
		await upload({
			phase: "error",
			processingError: "Simulated media failure",
		});
	} else {
		media.completed++;
		await database()
			.delete(videoUploads)
			.where(eq(videoUploads.videoId, videoId));
	}
	await timedDispatch(simulation, videoId);
	await timedDispatch(simulation, videoId);
}

async function makePeople(count: number) {
	const people: { ownerId: User.UserId; orgId: Organisation.OrganisationId }[] =
		[];
	for (let index = 0; index < count; index++) {
		const ownerId = User.UserId.make(id());
		const orgId = Organisation.OrganisationId.make(id());
		await database()
			.insert(users)
			.values({
				id: ownerId,
				email: `${ownerId}@scale.test`,
				name: `Person ${index}`,
				activeOrganizationId: orgId,
				defaultOrgId: orgId,
				stripeSubscriptionStatus: "active",
			});
		await database()
			.insert(organizations)
			.values({ id: orgId, name: `Org ${index}`, ownerId });
		await database().insert(organizationMembers).values({
			id: id(),
			organizationId: orgId,
			userId: ownerId,
			role: "owner",
		});
		people.push({ ownerId, orgId });
	}
	return people;
}

async function cleanUp(orgIds: string[]) {
	await database().delete(loomImportJobItems);
	await database().delete(loomImportJobs);
	if (orgIds.length === 0) return;
	const created = await database()
		.select({ id: videos.id })
		.from(videos)
		.where(inArray(videos.orgId, orgIds as Organisation.OrganisationId[]));
	for (let index = 0; index < created.length; index += 1000) {
		const ids = created
			.slice(index, index + 1000)
			.map((row) => Video.VideoId.make(row.id));
		await database()
			.delete(videoUploads)
			.where(inArray(videoUploads.videoId, ids));
		await database()
			.delete(importedVideos)
			.where(inArray(importedVideos.id, ids));
		await database().delete(videos).where(inArray(videos.id, ids));
	}
}

async function inFlightCount() {
	const [row] = await database()
		.select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
		.from(loomImportJobItems)
		.where(eq(loomImportJobItems.status, "importing"));
	return row?.count ?? 0;
}

async function statusesByJob() {
	return database()
		.select({
			jobId: loomImportJobItems.jobId,
			status: loomImportJobItems.status,
			count: sql<number>`COUNT(*)`.mapWith(Number),
		})
		.from(loomImportJobItems)
		.groupBy(loomImportJobItems.jobId, loomImportJobItems.status);
}

function wireStart(simulation: Simulation) {
	fixture.start
		.mockReset()
		.mockImplementation(
			async (_workflow: unknown, [payload]: [{ videoId: string }]) => {
				simulation.launched++;
				const run = simulateVideo(
					simulation,
					Video.VideoId.make(payload.videoId),
				).catch((error) => {
					simulation.errors++;
					console.error("[scale] simulated video failed", error);
				});
				simulation.running.add(run);
				run.finally(() => simulation.running.delete(run));
				return { runId: payload.videoId };
			},
		);
}

async function measure<T>(runs: number, run: () => Promise<T>) {
	const ms: number[] = [];
	const queries: number[] = [];
	let result: T | undefined;
	for (let index = 0; index < runs; index++) {
		const before = fixture.queries;
		const startedAt = performance.now();
		result = await run();
		ms.push(performance.now() - startedAt);
		queries.push(fixture.queries - before);
	}
	return {
		result: result as T,
		ms: stats(ms),
		queries: Math.max(...queries),
	};
}

describe.runIf(enabled)("Loom CSV imports under load", () => {
	let pool: Pool | undefined;
	const orgIds: string[] = [];

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
		pool = createPool({ uri: databaseUrl, connectionLimit: 60 });
		fixture.database = drizzle(pool, {
			logger: {
				logQuery: () => {
					fixture.queries++;
				},
			},
		});
		await cleanUp([]);
	});

	afterAll(async () => {
		await cleanUp(orgIds);
		await pool?.end();
		fixture.database = undefined;
	});

	it(
		"keeps each scheduling pass and each poll small with 100,000 rows queued",
		async () => {
			const people = await makePeople(50);
			orgIds.push(...people.map((person) => person.orgId));
			fixture.start.mockReset().mockResolvedValue({ runId: "run" });
			const now = new Date();
			const jobIds: string[] = [];
			for (const [index, person] of people.entries()) {
				const jobId = id();
				jobIds.push(jobId);
				await database()
					.insert(loomImportJobs)
					.values({
						id: jobId,
						orgId: person.orgId,
						createdById: person.ownerId,
						fileName: `cost-${index}.csv`,
						status: "importing",
						totalCount: 2000,
						startedAt: now,
					});
				const rows = Array.from({ length: 2000 }, (_, row) => {
					const loomVideoId = randomUUID().replaceAll("-", "");
					return {
						id: id(),
						jobId,
						rowNumber: row + 2,
						loomUrl: `https://www.loom.com/share/${loomVideoId}`,
						loomVideoId,
						status: "ready" as const,
						ownerId: person.ownerId,
						title: `Recording ${row}`,
						durationSeconds: 95,
						updatedAt: now,
					};
				});
				for (let offset = 0; offset < rows.length; offset += 500) {
					await database()
						.insert(loomImportJobItems)
						.values(rows.slice(offset, offset + 500));
				}
			}

			const cold = await measure(1, () => dispatchLoomImports());
			await dispatchLoomImports();
			await dispatchLoomImports();
			expect(await inFlightCount()).toBe(12);
			const full = await measure(20, () => dispatchLoomImports());
			expect(full.result.started).toBe(0);

			const finishOne = await measure(20, async () => {
				const [running] = await database()
					.select({ videoId: loomImportJobItems.videoId })
					.from(loomImportJobItems)
					.where(eq(loomImportJobItems.status, "importing"))
					.limit(1);
				const videoId = running?.videoId as Video.VideoId;
				await database()
					.delete(videoUploads)
					.where(eq(videoUploads.videoId, videoId));
				const before = fixture.queries;
				const startedAt = performance.now();
				const outcome = await dispatchLoomImportForVideo(videoId);
				const elapsed = performance.now() - startedAt;
				const repeatBefore = fixture.queries;
				await dispatchLoomImportForVideo(videoId);
				return {
					outcome,
					elapsed,
					queries: repeatBefore - before,
					repeatQueries: fixture.queries - repeatBefore,
				};
			});
			expect(finishOne.result.outcome?.started).toBe(1);
			expect(await inFlightCount()).toBe(12);

			const [busy] = await database()
				.select({ videoId: loomImportJobItems.videoId })
				.from(loomImportJobItems)
				.where(eq(loomImportJobItems.status, "importing"))
				.limit(1);
			const admission = await measure(20, () =>
				dispatchLoomImportForVideo(busy?.videoId as Video.VideoId),
			);

			const owner = people[0] as (typeof people)[number];
			const jobId = jobIds[0] as string;
			const first = await getLoomImportSnapshot({
				jobId,
				userId: owner.ownerId,
			});
			const deltaPoll = await measure(20, () =>
				getLoomImportSnapshot({
					jobId,
					userId: owner.ownerId,
					since: first?.cursor,
				}),
			);
			const fullPoll = await measure(5, () =>
				getLoomImportSnapshot({ jobId, userId: owner.ownerId }),
			);

			const explain = async (label: string, query: string) => {
				const [rows] = (await pool?.query(`EXPLAIN ANALYZE ${query}`)) as [
					Array<Record<string, string>>,
					unknown,
				];
				return { label, plan: Object.values(rows[0] ?? {})[0] };
			};
			const plans = [
				await explain(
					"in-flight rows across all imports",
					"SELECT i.id FROM loom_import_job_items i JOIN loom_import_jobs j ON j.id = i.job_id LEFT JOIN videos v ON v.id = i.video_id LEFT JOIN video_uploads u ON u.video_id = i.video_id WHERE i.status = 'importing'",
				),
				await explain(
					"next queued row of one import, without the index hint",
					`SELECT id FROM loom_import_job_items WHERE job_id = '${jobId}' AND status = 'ready' ORDER BY csv_row LIMIT 1`,
				),
				await explain(
					"next queued row of one import, as the dispatcher asks",
					`SELECT id FROM loom_import_job_items FORCE INDEX (job_status_row_idx) WHERE job_id = '${jobId}' AND status = 'ready' ORDER BY csv_row LIMIT 1`,
				),

				await explain(
					"rows changed since the last poll",
					`SELECT id FROM loom_import_job_items WHERE job_id = '${jobId}' AND updated_at > NOW(3) - INTERVAL 3 SECOND`,
				),
			];

			await database()
				.update(loomImportJobItems)
				.set({ status: "complete" })
				.where(
					and(
						eq(loomImportJobItems.status, "ready"),
						sql`${loomImportJobItems.rowNumber} <= 1991`,
					),
				);
			await wait(15_000);
			await pool?.query(
				"TRUNCATE performance_schema.events_statements_summary_by_digest",
			);
			const lateFull = await measure(20, () => dispatchLoomImports());
			const [slowest] = (await pool?.query(
				"SELECT LEFT(DIGEST_TEXT, 160) AS statement, COUNT_STAR AS calls, ROUND(AVG_TIMER_WAIT / 1e9, 2) AS avg_ms, SUM_ROWS_EXAMINED AS rows_examined FROM performance_schema.events_statements_summary_by_digest WHERE SCHEMA_NAME = DATABASE() ORDER BY SUM_TIMER_WAIT DESC LIMIT 6",
			)) as [Array<Record<string, unknown>>, unknown];
			console.info(
				`[loom-import cost] slowest statements late in imports\n${JSON.stringify(slowest, null, 1)}`,
			);
			const lateFinish = await measure(10, async () => {
				const [running] = await database()
					.select({ videoId: loomImportJobItems.videoId })
					.from(loomImportJobItems)
					.where(eq(loomImportJobItems.status, "importing"))
					.limit(1);
				const videoId = running?.videoId as Video.VideoId;
				await database()
					.delete(videoUploads)
					.where(eq(videoUploads.videoId, videoId));
				return dispatchLoomImportForVideo(videoId);
			});
			expect(lateFinish.result?.started).toBe(1);
			const lateDelta = await measure(20, () =>
				getLoomImportSnapshot({
					jobId,
					userId: owner.ownerId,
					since: Date.now(),
				}),
			);
			plans.push(
				await explain(
					"imports with nothing left, late in imports",
					`SELECT j.id FROM loom_import_jobs j WHERE j.id IN (${jobIds
						.map((value) => `'${value}'`)
						.join(",")}) AND j.status = 'importing' ${[
						"pending",
						"ready",
						"importing",
					]
						.map(
							(status) =>
								`AND NOT EXISTS (SELECT 1 FROM loom_import_job_items i FORCE INDEX (job_status_row_idx) WHERE i.job_id = j.id AND i.status = '${status}')`,
						)
						.join(" ")}`,
				),
				await explain(
					"next queued row late in an import, without the index hint",
					`SELECT id FROM loom_import_job_items WHERE job_id = '${jobId}' AND status = 'ready' ORDER BY csv_row LIMIT 1`,
				),
				await explain(
					"next queued row late in an import, as the dispatcher asks",
					`SELECT id FROM loom_import_job_items FORCE INDEX (job_status_row_idx) WHERE job_id = '${jobId}' AND status = 'ready' ORDER BY csv_row LIMIT 1`,
				),
			);

			const report = {
				queuedRows: 100_000,
				activeImports: jobIds.length,
				lateInImports: {
					passWhenFull: { queries: lateFull.queries, ms: lateFull.ms },
					videoFinished: { queries: lateFinish.queries, ms: lateFinish.ms },
					deltaPoll: { queries: lateDelta.queries, ms: lateDelta.ms },
				},
				coldPass: { queries: cold.queries, ms: cold.ms.max },
				passWhenFull: { queries: full.queries, ms: full.ms },
				videoFinished: {
					queries: finishOne.result.queries,
					repeatTriggerQueries: finishOne.result.repeatQueries,
					ms: finishOne.ms,
				},
				mediaServerAccepted: { queries: admission.queries, ms: admission.ms },
				deltaPoll: {
					queries: deltaPoll.queries,
					ms: deltaPoll.ms,
					rows: deltaPoll.result?.items.length,
				},
				fullPoll: {
					queries: fullPoll.queries,
					ms: fullPoll.ms,
					rows: fullPoll.result?.items.length,
				},
			};
			console.info(`[loom-import cost] ${JSON.stringify(report, null, 1)}`);
			for (const plan of plans) {
				console.info(`[loom-import plan] ${plan.label}\n${plan.plan}`);
			}

			expect(full.queries).toBeLessThanOrEqual(8);
			expect(finishOne.result.repeatQueries).toBe(1);
			expect(deltaPoll.result?.items.length).toBeLessThanOrEqual(4);
			await cleanUp([]);
		},
		10 * 60 * 1000,
	);

	it(
		"50 people importing 2,000 videos each stay within capacity and all make progress",
		async () => {
			const people = await makePeople(50);
			orgIds.push(...people.map((person) => person.orgId));
			const simulation = newSimulation([150, 350]);
			wireStart(simulation);
			vi.stubGlobal("fetch", fakeLoom(simulation));

			const createdAt = performance.now();
			const jobIds: string[] = [];
			for (const person of people) {
				const { jobId } = await createLoomImportJob({
					userId: person.ownerId,
					orgId: person.orgId,
					fileName: "loom-export.csv",
					rows: Array.from({ length: 2000 }, (_, index) => ({
						rowNumber: index + 2,
						loomUrl: `https://www.loom.com/share/${randomUUID().replaceAll("-", "")}`,
					})),
				});
				jobIds.push(jobId);
			}
			const createMs = performance.now() - createdAt;

			const globalLimit = loomImportGlobalConcurrency();
			const perJob = loomImportConcurrency();
			let most = 0;
			let sampling = true;
			const sampler = (async () => {
				while (sampling) {
					most = Math.max(most, await inFlightCount());
					await wait(100);
				}
			})();

			const pollMs: number[] = [];
			const pollRows: number[] = [];
			let polling = true;
			const pollers = people.map(async (person, index) => {
				const jobId = jobIds[index] as string;
				const first = await getLoomImportSnapshot({
					jobId,
					userId: person.ownerId,
				});
				let cursor = first?.cursor ?? Date.now();
				while (polling) {
					await wait(2000);
					const startedAt = performance.now();
					const delta = await getLoomImportSnapshot({
						jobId,
						userId: person.ownerId,
						since: cursor,
					});
					pollMs.push(performance.now() - startedAt);
					pollRows.push(delta?.items.length ?? 0);
					cursor = delta?.cursor ?? cursor;
				}
			});

			const workflowsStartedAt = performance.now();
			const results = await Promise.all(
				jobIds.map((jobId) => loomImportJobWorkflow({ jobId })),
			);
			const checkedMs = performance.now() - workflowsStartedAt;
			expect(results.every((result) => result.status === "importing")).toBe(
				true,
			);

			const afterChecks = await statusesByJob();
			const lookupFailures = afterChecks
				.filter((row) => row.status === "failed" || row.status === "pending")
				.reduce((total, row) => total + row.count, 0);

			await wait(90_000);

			for (const jobId of jobIds) await cancelLoomImportJob(jobId);
			polling = false;
			await Promise.all(pollers);
			while (simulation.running.size > 0) {
				await Promise.all(Array.from(simulation.running));
			}
			sampling = false;
			await sampler;

			const finalStatuses = await statusesByJob();
			const completedByJob = new Map<string, number>();
			for (const row of finalStatuses) {
				if (row.status === "complete") completedByJob.set(row.jobId, row.count);
			}
			const perJobCompleted = jobIds.map(
				(jobId) => completedByJob.get(jobId) ?? 0,
			);
			const stillImporting = finalStatuses
				.filter((row) => row.status === "importing")
				.reduce((total, row) => total + row.count, 0);

			const fullStartedAt = performance.now();
			const full = await getLoomImportSnapshot({
				jobId: jobIds[0] as string,
				userId: people[0]?.ownerId as User.UserId,
			});
			const fullMs = performance.now() - fullStartedAt;

			const report = {
				people: people.length,
				rows: people.length * 2000,
				limits: { globalLimit, perJob, mediaCapacity: MEDIA_CAPACITY },
				createAllJobsMs: Math.round(createMs),
				allLinksCheckedMs: Math.round(checkedMs),
				lookupFailures,
				loom: simulation.loom,
				mostInFlight: most,
				media: simulation.media,
				videosLaunched: simulation.launched,
				completedPerImport: {
					min: Math.min(...perJobCompleted),
					max: Math.max(...perJobCompleted),
					total: perJobCompleted.reduce((total, value) => total + value, 0),
				},
				stillImportingAfterDrain: stillImporting,
				simulationErrors: simulation.errors,
				dispatchMs: stats(simulation.dispatchMs),
				deltaPollMs: stats(pollMs),
				deltaPollRows: stats(pollRows),
				fullSnapshotMs: Math.round(fullMs),
				fullSnapshotRows: full?.items.length ?? 0,
			};
			console.info(`[loom-import scale] ${JSON.stringify(report, null, 1)}`);

			expect(lookupFailures).toBe(0);
			expect(most).toBeLessThanOrEqual(globalLimit);
			expect(simulation.media.most).toBeLessThanOrEqual(MEDIA_CAPACITY);
			expect(Math.min(...perJobCompleted)).toBeGreaterThan(0);
			expect(stillImporting).toBe(0);
			expect(simulation.errors).toBe(0);
		},
		20 * 60 * 1000,
	);

	it(
		"50 people importing at the same time all finish, with only real failures left",
		async () => {
			await cleanUp([]);
			const people = await makePeople(50);
			orgIds.push(...people.map((person) => person.orgId));
			const simulation = newSimulation([40, 120]);
			wireStart(simulation);
			vi.stubGlobal("fetch", fakeLoom(simulation));

			const jobIds: string[] = [];
			for (const person of people) {
				const { jobId } = await createLoomImportJob({
					userId: person.ownerId,
					orgId: person.orgId,
					fileName: "small.csv",
					rows: Array.from({ length: 40 }, (_, index) => ({
						rowNumber: index + 2,
						loomUrl: `https://www.loom.com/share/${randomUUID().replaceAll("-", "")}`,
					})),
				});
				jobIds.push(jobId);
			}

			const startedAt = performance.now();
			await Promise.all(
				jobIds.map((jobId) => loomImportJobWorkflow({ jobId })),
			);
			const deadline = Date.now() + 10 * 60 * 1000;
			let most = 0;
			while (Date.now() < deadline) {
				most = Math.max(most, await inFlightCount());
				const [open] = await database()
					.select({ count: sql<number>`COUNT(*)`.mapWith(Number) })
					.from(loomImportJobs)
					.where(
						and(
							inArray(loomImportJobs.id, jobIds),
							ne(loomImportJobs.status, "completed"),
						),
					);
				if (!open?.count && simulation.running.size === 0) break;
				await wait(200);
			}
			const elapsed = performance.now() - startedAt;

			const finalStatuses = await statusesByJob();
			const totals = new Map<string, number>();
			for (const row of finalStatuses) {
				totals.set(row.status, (totals.get(row.status) ?? 0) + row.count);
			}
			const jobs = await database()
				.select({ status: loomImportJobs.status })
				.from(loomImportJobs)
				.where(inArray(loomImportJobs.id, jobIds));
			const report = {
				people: people.length,
				videos: people.length * 40,
				finishedInMs: Math.round(elapsed),
				mostInFlight: most,
				media: simulation.media,
				itemStatuses: Object.fromEntries(totals),
				simulationErrors: simulation.errors,
				jobsCompleted: jobs.filter((job) => job.status === "completed").length,
				dispatchMs: stats(simulation.dispatchMs),
			};
			console.info(`[loom-import scale] ${JSON.stringify(report, null, 1)}`);

			expect(report.jobsCompleted).toBe(50);
			expect(simulation.errors).toBe(0);
			expect(totals.get("complete")).toBe(simulation.media.completed);
			expect(totals.get("failed") ?? 0).toBe(simulation.media.failed);
			expect((totals.get("complete") ?? 0) + (totals.get("failed") ?? 0)).toBe(
				2000,
			);
			expect(most).toBeLessThanOrEqual(loomImportGlobalConcurrency());
		},
		20 * 60 * 1000,
	);
});
