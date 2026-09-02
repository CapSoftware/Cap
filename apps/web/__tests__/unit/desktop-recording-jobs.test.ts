import type { User, Video } from "@cap/web-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	attachRemoteJob,
	claimProcessingAttempt,
	type DesktopRecordingAttemptFence,
	type DesktopRecordingJob,
	ensureSegmentProcessingJob,
	getDesktopRecordingRetryDelay,
	heartbeatAttempt,
	initializeSourceCommitCheckpoint,
	isDesktopRecordingJobRecoverable,
	markSourceBlocked,
	persistCommittedSource,
	persistSourceCommitCheckpoint,
	retireDesktopRecordingJobForOutputReplacement,
	scheduleRetry,
} from "@/lib/desktop-recording-jobs";
import type { RecordingVerification } from "@/lib/desktop-recording-verification";

const mocks = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => {
	const table = (name: string, fields: string[]) =>
		Object.fromEntries([
			["table", name],
			...fields.map((field) => [field, `${name}.${field}`]),
		]);
	return {
		videos: table("videos", ["id", "ownerId", "source"]),
		videoUploads: table("uploads", ["videoId"]),
		videoProcessingJobs: table("jobs", [
			"videoId",
			"ownerId",
			"generation",
			"state",
			"attemptId",
			"attemptCount",
			"source",
			"nextRetryAt",
			"leaseExpiresAt",
			"remoteJobId",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ op: "and", args }),
	or: (...args: unknown[]) => ({ op: "or", args }),
	eq: (column: string, value: unknown) => ({ op: "eq", column, value }),
	ne: (column: string, value: unknown) => ({ op: "ne", column, value }),
	lte: (column: string, value: unknown) => ({ op: "lte", column, value }),
	gt: (column: string, value: unknown) => ({ op: "gt", column, value }),
	inArray: (column: string, value: unknown[]) => ({ op: "in", column, value }),
	isNull: (column: string) => ({ op: "null", column }),
	asc: (column: string) => column,
	getTableColumns: (table: Record<string, string>) => table,
}));

type Row = Record<string, unknown>;
type Table = { table: string };
type Condition = {
	op: string;
	args?: (Condition | undefined)[];
	column?: string;
	value?: unknown;
};

const videoId = "video" as Video.VideoId;
const userId = "user" as User.UserId;
const now = new Date("2026-09-02T12:00:00.000Z");
const manifestSha256 = "a".repeat(64);
const source = {
	version: 1 as const,
	kind: "segments" as const,
	manifestSha256,
	inventorySha256: "b".repeat(64),
	inventoryKey: "user/video/.recording/sources/generation/inventory.json",
	requiredAudio: true,
};
const verification: RecordingVerification = {
	version: 1,
	artifact: { kind: "segments", manifestSha256 },
	requiredAudio: true,
};

let rows: Record<string, Row[]>;
let lockingOperations: string[];

function matches(row: Row, condition?: Condition): boolean {
	if (!condition) return true;
	if (condition.op === "and")
		return (condition.args ?? []).every((part) => matches(row, part));
	if (condition.op === "or")
		return (condition.args ?? []).some((part) => matches(row, part));
	const value = row[condition.column?.split(".")[1] ?? ""];
	if (condition.op === "eq") return value === condition.value;
	if (condition.op === "ne") return value !== condition.value;
	if (condition.op === "null") return value === null || value === undefined;
	if (condition.op === "in")
		return Array.isArray(condition.value) && condition.value.includes(value);
	if (condition.op === "lte") return Number(value) <= Number(condition.value);
	if (condition.op === "gt") return Number(value) > Number(condition.value);
	throw new Error(`Unexpected condition ${condition.op}`);
}

function createClient() {
	const client = {
		select(fields?: Record<string, string>) {
			let table = "";
			let condition: Condition | undefined;
			const run = () =>
				(rows[table] ?? [])
					.filter((row) => matches(row, condition))
					.map((row) => {
						if (!fields) return { ...row };
						return Object.fromEntries(
							Object.entries(fields).map(([name, column]) => [
								name,
								row[column.split(".")[1] ?? ""],
							]),
						);
					});
			const query = {
				from(value: Table) {
					table = value.table;
					return query;
				},
				where(value: Condition) {
					condition = value;
					return query;
				},
				for: async () => {
					lockingOperations.push(`select:${table}`);
					return run();
				},
				limit: async (limit: number) => run().slice(0, limit),
			};
			return query;
		},
		update(table: Table) {
			return {
				set(values: Row) {
					return {
						where: async (condition: Condition) => {
							const matching = (rows[table.table] ?? []).filter((row) =>
								matches(row, condition),
							);
							for (const row of matching) Object.assign(row, values);
							return [{ affectedRows: matching.length }];
						},
					};
				},
			};
		},
		insert(table: Table) {
			return {
				values(values: Row) {
					const run = async (update?: Row) => {
						lockingOperations.push(
							`${update ? "upsert" : "insert"}:${table.table}`,
						);
						const stored = (rows[table.table] ?? []).find(
							(row) => row.videoId === values.videoId,
						);
						if (stored) {
							if (!update) throw new Error("Duplicate row");
							Object.assign(stored, update);
						} else {
							rows[table.table]?.push({ ...values });
						}
						return [{ affectedRows: 1 }];
					};
					let updates: Row | undefined;
					const pending = Promise.resolve().then(() => run(updates));
					return Object.assign(pending, {
						onDuplicateKeyUpdate: ({ set }: { set: Row }) => {
							updates = set;
							return pending;
						},
					});
				},
			};
		},
	};
	let tail = Promise.resolve();
	return {
		...client,
		async transaction(callback: (tx: typeof client) => Promise<unknown>) {
			const previous = tail;
			let release = () => {};
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			const before = structuredClone(rows);
			try {
				return await callback(client);
			} catch (error) {
				rows = before;
				throw error;
			} finally {
				release();
			}
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	lockingOperations = [];
	rows = {
		videos: [
			{ id: videoId, ownerId: userId, source: { type: "desktopSegments" } },
		],
		jobs: [],
		uploads: [],
	};
	mocks.db.mockReturnValue(createClient());
});

afterEach(() => vi.useRealTimers());

async function createAttempt(withVerification = true) {
	const { job } = await ensureSegmentProcessingJob({
		videoId,
		userId,
		verification: withVerification ? verification : undefined,
	});
	const attempt = await claimProcessingAttempt({
		videoId,
		generation: job.generation,
	});
	if (!attempt) throw new Error("Fixture attempt was not claimed");
	return attempt;
}

describe("durable recording job ownership", () => {
	it("establishes the job row before taking locking reads to prevent concurrent first-insert deadlocks", async () => {
		await ensureSegmentProcessingJob({ videoId, userId });
		expect(lockingOperations.slice(0, 3)).toEqual([
			"upsert:jobs",
			"select:jobs",
			"select:videos",
		]);
	});

	it("creates one logical generation for concurrent completion requests", async () => {
		const results = await Promise.all([
			ensureSegmentProcessingJob({ videoId, userId, verification }),
			ensureSegmentProcessingJob({ videoId, userId, verification }),
		]);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(new Set(results.map((result) => result.job.generation)).size).toBe(
			1,
		);
		expect(rows.jobs).toHaveLength(1);
	});

	it("claims only one attempt when two workflows wake together", async () => {
		const { job } = await ensureSegmentProcessingJob({ videoId, userId });
		const results = await Promise.all([
			claimProcessingAttempt({ videoId, generation: job.generation }),
			claimProcessingAttempt({ videoId, generation: job.generation }),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(rows.jobs?.[0]?.attemptCount).toBe(1);
	});

	it("rejects stale attempt heartbeats, remote jobs, and errors after a retry takes over", async () => {
		const old = await createAttempt();
		vi.setSystemTime(new Date(now.getTime() + 6 * 60_000));
		const next = await claimProcessingAttempt({
			videoId,
			generation: old.generation,
		});
		expect(next?.attemptId).not.toBe(old.attemptId);
		expect(await heartbeatAttempt(old)).toBe(false);
		expect(await attachRemoteJob({ ...old, remoteJobId: "stale-worker" })).toBe(
			false,
		);
		expect(
			await scheduleRetry({
				...old,
				errorCode: "stale-error",
				errorMessage: "old callback",
			}),
		).toBe(false);
		expect(rows.jobs?.[0]?.attemptId).toBe(next?.attemptId);
	});

	it("does not mutate an upload owned by another account", async () => {
		await expect(
			ensureSegmentProcessingJob({ videoId, userId: "other" as User.UserId }),
		).rejects.toThrow("does not exist");
		expect(rows.jobs).toEqual([]);
	});

	it("does not revive an expired attempt before another worker has claimed it", async () => {
		const expired = await createAttempt();
		const checkpoint = await initializeSourceCommitCheckpoint(expired);
		if (!checkpoint) throw new Error("Missing checkpoint");
		vi.setSystemTime(new Date(now.getTime() + 6 * 60_000));
		expect(await heartbeatAttempt(expired)).toBe(false);
		expect(
			await attachRemoteJob({ ...expired, remoteJobId: "late-worker" }),
		).toBe(false);
		expect(await persistCommittedSource(expired, source)).toBe(false);
		expect(
			await persistSourceCommitCheckpoint(expired, {
				...checkpoint,
				revision: 1,
			}),
		).toBe(false);
		expect(rows.jobs?.[0]).toMatchObject({
			attemptId: expired.attemptId,
			source: null,
			remoteJobId: null,
			output: checkpoint,
		});
		const next = await claimProcessingAttempt({
			videoId,
			generation: expired.generation,
		});
		if (!next) throw new Error("Expired attempt was not recoverable");
		expect(next.attemptId).not.toBe(expired.attemptId);
		expect(await initializeSourceCommitCheckpoint(next)).toEqual(checkpoint);
	});
});

describe("late verification and source commitment", () => {
	it("retains bounded source-copy progress across retries and rejects stale checkpoint writes", async () => {
		const first = await createAttempt(false);
		const checkpoint = await initializeSourceCommitCheckpoint(first);
		if (!checkpoint) throw new Error("Missing checkpoint");
		const advanced = {
			...checkpoint,
			revision: 1,
			phase: "enumerate" as const,
		};
		expect(await persistSourceCommitCheckpoint(first, advanced)).toBe(true);
		expect(await persistSourceCommitCheckpoint(first, advanced)).toBe(false);
		await scheduleRetry({
			...first,
			errorCode: "worker-lost",
			errorMessage: "interrupted",
		});
		vi.setSystemTime(new Date(now.getTime() + 60_000));
		const second = await claimProcessingAttempt({
			videoId,
			generation: first.generation,
		});
		if (!second) throw new Error("Missing replacement attempt");
		expect(await initializeSourceCommitCheckpoint(second)).toEqual(advanced);
		expect(
			await persistSourceCommitCheckpoint(first, { ...advanced, revision: 2 }),
		).toBe(false);
		expect(
			await persistSourceCommitCheckpoint(second, { ...advanced, revision: 2 }),
		).toBe(true);
		const late = await ensureSegmentProcessingJob({
			videoId,
			userId,
			verification,
		});
		expect(late.job.generation).toBe(first.generation);
		expect(await persistCommittedSource(second, source)).toBe(true);
		expect(rows.jobs?.[0]).toMatchObject({
			source,
			verification,
			output: null,
		});
		expect(
			await persistSourceCommitCheckpoint(second, { ...advanced, revision: 3 }),
		).toBe(false);
	});

	it("starts a fresh uncommitted plan after missing or replaced source objects are repaired", async () => {
		const first = await createAttempt(false);
		const checkpoint = await initializeSourceCommitCheckpoint(first);
		if (!checkpoint) throw new Error("Missing checkpoint");
		await markSourceBlocked({
			...first,
			errorCode: "source-changed",
			errorMessage: "Original object was replaced",
		});
		const reopened = await ensureSegmentProcessingJob({ videoId, userId });
		expect(reopened.job).toMatchObject({
			generation: first.generation,
			source: null,
			output: null,
		});
		const second = await claimProcessingAttempt({
			videoId,
			generation: first.generation,
		});
		if (!second) throw new Error("Missing repaired-source attempt");
		const replacement = await initializeSourceCommitCheckpoint(second);
		expect(replacement?.snapshotId).not.toBe(checkpoint.snapshotId);
		expect(
			await persistSourceCommitCheckpoint(first, {
				...checkpoint,
				revision: 1,
			}),
		).toBe(false);
	});

	it("discards an obsolete checkpoint when a proof changes during a resumed source commit", async () => {
		const attempt = await createAttempt(false);
		await initializeSourceCommitCheckpoint(attempt);
		await ensureSegmentProcessingJob({ videoId, userId, verification });
		expect(
			await persistCommittedSource(attempt, {
				...source,
				manifestSha256: "e".repeat(64),
			}),
		).toBe(false);
		expect(rows.jobs?.[0]).toMatchObject({
			source: null,
			output: null,
			state: "retry",
			errorCode: "source-intent-changed",
		});
	});

	it("attaches a matching proof arriving during a legacy snapshot to the same generation", async () => {
		const attempt = await createAttempt(false);
		const attached = await ensureSegmentProcessingJob({
			videoId,
			userId,
			verification,
		});
		expect(attached.created).toBe(false);
		expect(attached.job.generation).toBe(attempt.generation);
		expect(attached.job.attemptId).toBe(attempt.attemptId);
		expect(await persistCommittedSource(attempt, source)).toBe(true);
		expect(rows.jobs?.[0]).toMatchObject({
			generation: attempt.generation,
			state: "processing",
			source,
			verification,
		});
	});

	it("retries the snapshot instead of accepting a copy made before the completed intent changed", async () => {
		const attempt = await createAttempt(false);
		await ensureSegmentProcessingJob({ videoId, userId, verification });
		expect(
			await persistCommittedSource(attempt, {
				...source,
				manifestSha256: "c".repeat(64),
			}),
		).toBe(false);
		expect(rows.jobs?.[0]).toMatchObject({
			generation: attempt.generation,
			source: null,
			state: "retry",
			errorCode: "source-intent-changed",
		});
	});

	it("requires missing audio to be reconciled before committing a late strict segmented request", async () => {
		const attempt = await createAttempt(false);
		await ensureSegmentProcessingJob({ videoId, userId, verification });
		expect(
			await persistCommittedSource(attempt, {
				...source,
				requiredAudio: false,
			}),
		).toBe(false);
		expect(rows.jobs?.[0]?.source).toBeNull();
	});

	it("adds the late strict MP4 duration to an identical already-copied source", async () => {
		const video = rows.videos?.[0];
		if (video) video.source = { type: "desktopMP4" };
		const attempt = await createAttempt(false);
		const request: RecordingVerification = {
			version: 1,
			artifact: {
				kind: "mp4",
				fileSize: 1000,
				duration: 91.6,
				objectIdentity: '"original"',
			},
			requiredAudio: true,
		};
		await ensureSegmentProcessingJob({
			videoId,
			userId,
			verification: request,
		});
		expect(
			await persistCommittedSource(attempt, {
				...source,
				kind: "mp4",
				manifestSha256: undefined,
				requiredAudio: false,
				mp4: { fileSize: 1000, objectIdentity: '"original"' },
			}),
		).toBe(true);
		expect(rows.jobs?.[0]?.source).toMatchObject({
			requiredAudio: true,
			mp4: { fileSize: 1000, duration: 91.6, objectIdentity: '"original"' },
		});
	});

	it("keeps stronger audio verification when an older client repeats a weaker request", async () => {
		const attempt = await createAttempt();
		await persistCommittedSource(attempt, source);
		const weak = { ...verification, requiredAudio: false };
		const result = await ensureSegmentProcessingJob({
			videoId,
			userId,
			verification: weak,
		});
		expect(result.job.verification?.requiredAudio).toBe(true);
		expect(result.job.generation).toBe(attempt.generation);
	});

	it("fences an old attempt when an authenticated completion identifies a new artifact", async () => {
		const old = await createAttempt();
		await persistCommittedSource(old, source);
		const next = await ensureSegmentProcessingJob({
			videoId,
			userId,
			verification: {
				...verification,
				artifact: { kind: "segments", manifestSha256: "f".repeat(64) },
			},
		});
		expect(next.job.generation).not.toBe(old.generation);
		expect(await persistCommittedSource(old, source)).toBe(false);
		expect(next.job.source).toBeNull();
	});
});

describe("retained-source retry policy", () => {
	it.each([null, source])(
		"does not recreate a recording while deletion is pending",
		async (retainedSource) => {
			const attempt = await createAttempt();
			const deleting = {
				...attempt,
				generation: "deletion-generation",
				state: "source-blocked" as const,
				source: retainedSource,
				leaseExpiresAt: null,
				nextRetryAt: now,
				errorCode: "video-deleting",
			};
			rows.jobs = [deleting];
			expect(isDesktopRecordingJobRecoverable(deleting, now)).toBe(false);
			expect(await heartbeatAttempt(attempt)).toBe(false);
			await expect(
				ensureSegmentProcessingJob({ videoId, userId, verification }),
			).rejects.toThrow("being deleted");
			expect(rows.jobs?.[0]).toMatchObject({
				generation: "deletion-generation",
				source: retainedSource,
				errorCode: "video-deleting",
			});
		},
	);

	it("fences old workers and automatic retries after an intentional edit while retaining the source", async () => {
		const attempt = await createAttempt();
		await persistCommittedSource(attempt, source);
		await mocks
			.db()
			.transaction(
				(
					tx: Parameters<
						typeof retireDesktopRecordingJobForOutputReplacement
					>[0],
				) =>
					retireDesktopRecordingJobForOutputReplacement(tx, {
						videoId,
						userId,
					}),
			);
		expect(rows.jobs?.[0]).toMatchObject({
			source,
			state: "source-blocked",
			errorCode: "output-replaced",
			attemptId: null,
		});
		expect(rows.jobs?.[0]?.generation).not.toBe(attempt.generation);
		expect(await heartbeatAttempt(attempt)).toBe(false);
		await expect(
			ensureSegmentProcessingJob({ videoId, userId, verification }),
		).rejects.toThrow("intentionally edited or replaced");
	});

	it("keeps a replacement tombstone even when the original predated durable jobs", async () => {
		await mocks
			.db()
			.transaction(
				(
					tx: Parameters<
						typeof retireDesktopRecordingJobForOutputReplacement
					>[0],
				) =>
					retireDesktopRecordingJobForOutputReplacement(tx, {
						videoId,
						userId,
					}),
			);
		expect(rows.jobs?.[0]).toMatchObject({
			source: null,
			errorCode: "output-replaced",
		});
		await expect(
			ensureSegmentProcessingJob({ videoId, userId }),
		).rejects.toThrow("intentionally edited or replaced");
	});
	it("keeps worker failures processing without exposing reupload-required errors", async () => {
		const attempt = await createAttempt();
		await persistCommittedSource(attempt, source);
		expect(
			await scheduleRetry({
				...attempt,
				errorCode: "worker-lost",
				errorMessage: "worker restarted",
			}),
		).toBe(true);
		expect(rows.jobs?.[0]).toMatchObject({
			state: "retry",
			source,
			errorCode: "worker-lost",
		});
		expect(rows.uploads?.[0]).toMatchObject({
			phase: "processing",
			processingError: null,
		});
	});

	it("recovers old jobs regardless of recording age or previous attempt count", async () => {
		const attempt = await createAttempt();
		const job: DesktopRecordingJob = {
			...attempt,
			state: "retry",
			source,
			leaseExpiresAt: null,
			attemptCount: 500,
			createdAt: new Date("2020-01-01T00:00:00Z"),
			nextRetryAt: now,
		};
		expect(isDesktopRecordingJobRecoverable(job, now)).toBe(true);
		expect(
			isDesktopRecordingJobRecoverable({ ...job, state: "verified" }, now),
		).toBe(false);
		expect(
			isDesktopRecordingJobRecoverable(
				{ ...job, state: "source-blocked" },
				now,
			),
		).toBe(false);
		expect(
			isDesktopRecordingJobRecoverable(
				{ ...job, state: "source-blocked", source: null },
				now,
			),
		).toBe(true);
	});

	it("caps retry backoff without overflowing after many worker restarts", () => {
		expect(getDesktopRecordingRetryDelay(1)).toBe(15_000);
		expect(getDesktopRecordingRetryDelay(100_000)).toBe(3_600_000);
	});

	it("does not let a different generation attach a processing job", async () => {
		const attempt = await createAttempt();
		const fence: DesktopRecordingAttemptFence = {
			...attempt,
			generation: "other",
		};
		expect(await attachRemoteJob({ ...fence, remoteJobId: "remote" })).toBe(
			false,
		);
	});
});
