import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRecordingJob } from "@/lib/desktop-recording-jobs";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getState: vi.fn(),
	retry: vi.fn(),
	blocked: vi.fn(),
	head: vi.fn(),
	storage: vi.fn(),
	invalidateQuota: vi.fn(),
	tables: {
		videos: {
			id: "videos.id",
			ownerId: "videos.ownerId",
			metadata: "videos.metadata",
		},
		jobs: { videoId: "jobs.videoId" },
		uploads: { videoId: "uploads.videoId", rawFileKey: "uploads.rawFileKey" },
	},
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => ({
	videos: mocks.tables.videos,
	videoProcessingJobs: mocks.tables.jobs,
	videoUploads: mocks.tables.uploads,
}));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.storage },
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.storage },
}));
vi.mock("@/lib/desktop-recording-jobs", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/desktop-recording-jobs")>();
	return {
		...actual,
		getProcessingState: mocks.getState,
		scheduleRetry: mocks.retry,
		markSourceBlocked: mocks.blocked,
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});
vi.mock("@/lib/workflow-runtime", async () => {
	const { Effect } = await import("effect");
	return { runWorkflowPromise: Effect.runPromise };
});
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/google-drive-storage-quota-cache", () => ({
	invalidateGoogleDriveStorageQuotaCache: mocks.invalidateQuota,
}));

import { parseDesktopRecordingJob } from "@/lib/desktop-recording-jobs";
import {
	applyDesktopRecordingProgress,
	isCurrentDesktopRecordingAttempt,
	validateDesktopRecordingCompletion,
} from "@/lib/desktop-recording-publication";
import { getDesktopRecordingOutputKey } from "@/lib/desktop-recording-source";

type StoredJob = Parameters<typeof parseDesktopRecordingJob>[0];
type Mutation = {
	operation: "update" | "delete";
	table: unknown;
	values?: Record<string, unknown>;
};

const generation = "c9699f1a-fe24-44f9-ac89-63d5744a058c";
const attemptId = "cf9f55f8-4d6d-44b4-a670-30c2f7e51d9b";
const snapshotId = "5ec501d7-7a24-4efb-95ea-b3537350d870";
const manifestSha256 = "a".repeat(64);
const inventorySha256 = "b".repeat(64);
const outputSha256 = "c".repeat(64);
const ownerId = "owned-user" as DesktopRecordingJob["ownerId"];
const videoId = "owned-video" as DesktopRecordingJob["videoId"];
const outputKey = getDesktopRecordingOutputKey(
	ownerId,
	videoId,
	generation,
	attemptId,
);
const metadata = {
	fileSize: 4096,
	duration: 5,
	width: 320,
	height: 180,
	fps: 30,
	videoCodec: "h264",
	audioCodec: "aac",
};

function segmentedFixture() {
	const source = {
		version: 1 as const,
		kind: "segments" as const,
		manifestSha256,
		inventorySha256,
		inventoryKey: `${ownerId}/${videoId}/.recording/sources/${generation}/${snapshotId}/inventory.json`,
		requiredAudio: true,
	};
	const verification = {
		version: 1 as const,
		artifact: { kind: "segments" as const, manifestSha256 },
		requiredAudio: true,
	};
	const now = new Date();
	const job: DesktopRecordingJob = {
		videoId,
		ownerId,
		generation,
		manifestSha256,
		state: "processing",
		attemptId,
		attemptCount: 1,
		leaseExpiresAt: new Date(now.getTime() + 60_000),
		nextRetryAt: now,
		workflowRunId: "workflow-1",
		remoteJobId: "remote-1",
		source,
		verification,
		output: null,
		errorCode: null,
		errorMessage: null,
		createdAt: now,
		updatedAt: now,
	};
	const payload = {
		jobId: "remote-1",
		videoId,
		generation,
		attemptId,
		phase: "complete" as const,
		progress: 100,
		metadata: { ...metadata },
		recordingVerification: {
			request: verification,
			fullDecode: true as const,
			objectIdentity: '"verified-output"',
			outputKey,
			outputSha256,
			sourceProof: {
				version: 1 as const,
				manifestSha256,
				inventorySha256,
				sourcePreserved: true as const,
				videoDuration: metadata.duration,
				hasAudio: true,
				audioVerified: true,
			},
		},
	};
	return { job, payload, source, verification };
}

function mp4Fixture(requiredAudio = false) {
	const base = segmentedFixture();
	const source = {
		version: 1 as const,
		kind: "mp4" as const,
		inventorySha256,
		inventoryKey: base.source.inventoryKey,
		requiredAudio,
		mp4: {
			fileSize: metadata.fileSize,
			duration: metadata.duration,
			objectIdentity: '"original-upload"',
		},
	};
	const verification = {
		version: 1 as const,
		artifact: { kind: "mp4" as const, ...source.mp4 },
		requiredAudio,
	};
	const job: DesktopRecordingJob = {
		...base.job,
		manifestSha256: null,
		source,
		verification,
	};
	const payload = {
		...base.payload,
		recordingVerification: {
			request: verification,
			fullDecode: true as const,
			objectIdentity: '"copied-mp4"',
			outputKey: source.inventoryKey.replace("inventory.json", "mp4/0.mp4"),
			outputSha256,
		},
	};
	return { job, payload, source, verification };
}

function databaseFixture(initial: DesktopRecordingJob) {
	let current: StoredJob | null = structuredClone(initial);
	let video: Record<string, unknown> | null = {
		id: videoId,
		ownerId,
		source: {
			type: initial.source?.kind === "mp4" ? "desktopMP4" : "desktopSegments",
		},
		metadata: {},
		storageIntegrationId: null,
	};
	let beforeTransaction: (() => void) | undefined;
	let transactionTail = Promise.resolve();
	const mutations: Mutation[] = [];
	const rows = (table: unknown) => {
		if (table === mocks.tables.jobs)
			return current ? [structuredClone(current)] : [];
		if (table === mocks.tables.videos)
			return video ? [structuredClone(video)] : [];
		if (table === mocks.tables.uploads) return [{ rawFileKey: null }];
		throw new Error("Unexpected table");
	};
	const transaction = vi.fn(
		async (
			operation: (tx: ReturnType<typeof transactionHandle>) => Promise<unknown>,
		) => {
			const previous = transactionTail;
			let release = () => {};
			transactionTail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				beforeTransaction?.();
				const pending: Mutation[] = [];
				const result = await operation(transactionHandle(pending));
				for (const mutation of pending) {
					mutations.push(mutation);
					if (mutation.operation !== "update") continue;
					if (mutation.table === mocks.tables.jobs && current) {
						Object.assign(current, mutation.values);
					} else if (mutation.table === mocks.tables.videos && video) {
						Object.assign(video, mutation.values);
					}
				}
				return result;
			} finally {
				release();
			}
		},
	);
	function transactionHandle(pending: Mutation[]) {
		return {
			select: () => ({
				from: (table: unknown) => ({
					where: () => ({ for: async () => rows(table) }),
				}),
			}),
			update: (table: unknown) => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						pending.push({ operation: "update", table, values });
						return [{ affectedRows: 1 }];
					},
				}),
			}),
			delete: (table: unknown) => ({
				where: async () => {
					pending.push({ operation: "delete", table });
					return [{ affectedRows: 1 }];
				},
			}),
		};
	}
	mocks.db.mockReturnValue({
		select: () => ({
			from: (table: unknown) => ({ where: async () => rows(table) }),
		}),
		transaction,
	});
	mocks.getState.mockImplementation(
		async () => current && parseDesktopRecordingJob(structuredClone(current)),
	);
	return {
		mutations,
		transaction,
		getCurrent: () => current && structuredClone(current),
		setCurrent: (next: StoredJob | null) => {
			current = next;
		},
		getVideo: () => video,
		setVideo: (next: Record<string, unknown> | null) => {
			video = next;
		},
		beforeTransaction: (callback: () => void) => {
			beforeTransaction = callback;
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.storage.mockReturnValue(Effect.succeed([{ headObject: mocks.head }]));
	mocks.head.mockImplementation((key: string) =>
		key.endsWith(".mp4")
			? Effect.succeed({
					ContentLength: metadata.fileSize,
					ETag: '"verified-output"',
				})
			: Effect.fail(new Error("Asset absent")),
	);
	mocks.invalidateQuota.mockResolvedValue(undefined);
	mocks.retry.mockResolvedValue(true);
	mocks.blocked.mockResolvedValue(true);
});

describe("recording publication attempt fence", () => {
	it("accepts only the current live processing attempt", () => {
		const { job, payload } = segmentedFixture();
		const now = new Date();
		expect(isCurrentDesktopRecordingAttempt(job, payload, now)).toBe(true);
		for (const change of [
			{ generation: "old-generation" },
			{ attemptId: "old-attempt" },
			{ remoteJobId: "different-worker" },
			{ state: "verified" as const },
			{ state: "retry" as const },
			{ leaseExpiresAt: null },
			{ leaseExpiresAt: now },
			{ leaseExpiresAt: new Date(now.getTime() - 1) },
		]) {
			expect(
				isCurrentDesktopRecordingAttempt({ ...job, ...change }, payload, now),
			).toBe(false);
		}
	});

	it("allows a matching attempt callback before the remote job id is persisted", () => {
		const { job, payload } = segmentedFixture();
		expect(
			isCurrentDesktopRecordingAttempt({ ...job, remoteJobId: null }, payload),
		).toBe(true);
	});

	it.each(["generation", "attempt", "remote", "expired", "verified"])(
		"does not inspect or mutate output for a %s stale completion",
		async (reason) => {
			const { job, payload } = segmentedFixture();
			if (reason === "generation") job.generation = "new-generation";
			else if (reason === "attempt") job.attemptId = "new-attempt";
			else if (reason === "remote") job.remoteJobId = "new-worker";
			else if (reason === "expired")
				job.leaseExpiresAt = new Date(Date.now() - 1);
			else job.state = "verified";
			const database = databaseFixture(job);
			expect(await applyDesktopRecordingProgress(payload)).toEqual({
				handled: true,
				status: 200,
			});
			expect(mocks.head).not.toHaveBeenCalled();
			expect(database.mutations).toEqual([]);
			expect(database.transaction).not.toHaveBeenCalled();
		},
	);
});

describe("recording worker ownership", () => {
	function fixture() {
		const { job, payload } = segmentedFixture();
		job.remoteJobId = null;
		const database = databaseFixture(job);
		const claim = {
			jobId: payload.jobId,
			videoId,
			generation,
			attemptId,
			inventorySha256,
			manifestSha256,
			phase: "queued" as const,
			progress: 0,
			recordingWorker: {
				version: 1 as const,
				action: "claim" as const,
				sequence: 0,
			},
		};
		const progress = {
			...claim,
			phase: "processing" as const,
			progress: 60,
			recordingWorker: {
				version: 1 as const,
				action: "progress" as const,
				sequence: 2,
			},
		};
		return { job, payload, database, claim, progress };
	}

	it("grants one physical replica ownership when claims race", async () => {
		const { database, claim } = fixture();
		const results = await Promise.all([
			applyDesktopRecordingProgress(claim),
			applyDesktopRecordingProgress({ ...claim, jobId: "other-replica" }),
		]);
		expect(results[0]?.recordingWorker).toMatchObject({
			status: "accepted",
			leaseDurationMs: 300_000,
			jobId: claim.jobId,
		});
		expect(results[1]?.recordingWorker).toMatchObject({
			status: "owned",
			ownerJobId: claim.jobId,
		});
		expect(database.getCurrent()).toMatchObject({
			remoteJobId: claim.jobId,
			output: { kind: "recording-worker", sequence: 0 },
		});
	});

	it("replays a lost claim acknowledgement without a second owner", async () => {
		const { database, claim } = fixture();
		await applyDesktopRecordingProgress(claim);
		const before = database.mutations.length;
		expect(
			(await applyDesktopRecordingProgress(claim)).recordingWorker,
		).toMatchObject({ status: "accepted", leaseDurationMs: 300_000 });
		expect(database.mutations.slice(before)).toHaveLength(1);
		expect(database.mutations[before]?.table).toBe(mocks.tables.jobs);
		expect(database.getCurrent()?.remoteJobId).toBe(claim.jobId);
	});

	it("rejects stale and conflicting revisions without regression or lease renewal", async () => {
		const { database, claim, progress } = fixture();
		await applyDesktopRecordingProgress(claim);
		await applyDesktopRecordingProgress(progress);
		const before = database.mutations.length;
		for (const stale of [
			claim,
			{ ...progress, progress: 1 },
			{
				...progress,
				recordingWorker: { ...progress.recordingWorker, sequence: 1 },
			},
		]) {
			expect(
				(await applyDesktopRecordingProgress(stale)).recordingWorker?.status,
			).toBe("stale");
		}
		expect(database.mutations).toHaveLength(before);
		expect(database.getCurrent()?.output).toMatchObject({
			sequence: 2,
			progress: 60,
		});
		expect(
			(await applyDesktopRecordingProgress(progress)).recordingWorker,
		).toMatchObject({ status: "accepted", leaseDurationMs: 300_000 });
		expect(database.mutations).toHaveLength(before + 1);
		expect(database.mutations[before]?.values).not.toHaveProperty("output");
	});

	it.each(["generation", "attempt", "expired", "inventory", "manifest"])(
		"rejects a claim with invalid %s ownership",
		async (reason) => {
			const { job, database, claim } = fixture();
			if (reason === "generation") claim.generation = "old-generation";
			else if (reason === "attempt") claim.attemptId = "old-attempt";
			else if (reason === "inventory") claim.inventorySha256 = "d".repeat(64);
			else if (reason === "manifest") claim.manifestSha256 = "d".repeat(64);
			else
				database.setCurrent({
					...job,
					leaseExpiresAt: new Date(Date.now() - 1),
				});
			expect(
				(await applyDesktopRecordingProgress(claim)).recordingWorker?.status,
			).toBe("superseded");
			expect(database.mutations).toEqual([]);
		},
	);

	it("rejects legacy callbacks after a versioned owner has claimed the attempt", async () => {
		const { database, claim, progress, payload } = fixture();
		await applyDesktopRecordingProgress(claim);
		const before = database.mutations.length;
		for (const legacy of [
			{ ...progress, recordingWorker: undefined },
			payload,
			{ ...payload, phase: "error" },
		]) {
			expect(await applyDesktopRecordingProgress(legacy)).toEqual({
				handled: true,
				status: 200,
			});
		}
		expect(database.mutations).toHaveLength(before);
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it("does not allow a legacy error that races an ownership claim to retry the owner", async () => {
		const { database, claim } = fixture();
		await applyDesktopRecordingProgress(claim);
		const owned = database.getCurrent();
		if (!owned) throw new Error("Missing owner");
		database.setCurrent({ ...owned, output: null, remoteJobId: null });
		database.beforeTransaction(() => database.setCurrent(owned));
		const before = database.mutations.length;
		await applyDesktopRecordingProgress({
			...claim,
			recordingWorker: undefined,
			phase: "error",
		});
		expect(database.mutations).toHaveLength(before);
		expect(database.getCurrent()?.state).toBe("processing");
	});

	it("commits an owner completion once and acknowledges its exact retry", async () => {
		const { database, claim, payload } = fixture();
		await applyDesktopRecordingProgress(claim);
		const complete = {
			...payload,
			inventorySha256,
			manifestSha256,
			recordingWorker: { version: 1, action: "progress", sequence: 1 },
		};
		expect(await applyDesktopRecordingProgress(complete)).toMatchObject({
			published: true,
			recordingWorker: { status: "accepted", sequence: 1 },
		});
		const before = database.mutations.length;
		expect(await applyDesktopRecordingProgress(complete)).toMatchObject({
			recordingWorker: { status: "accepted" },
		});
		expect(database.mutations).toHaveLength(before);
		expect(database.getCurrent()).toMatchObject({
			state: "verified",
			output: { recordingWorker: { sequence: 1, phase: "complete" } },
		});
	});

	it("cannot publish if the owner or sequence changes during output verification", async () => {
		const { database, claim, payload, progress } = fixture();
		await applyDesktopRecordingProgress(claim);
		await applyDesktopRecordingProgress(progress);
		const complete = {
			...payload,
			inventorySha256,
			manifestSha256,
			recordingWorker: { version: 1, action: "progress", sequence: 3 },
		};
		const owned = database.getCurrent();
		if (!owned || !owned.output || typeof owned.output !== "object")
			throw new Error("Missing owner");
		const checkpoint = owned.output;
		database.beforeTransaction(() =>
			database.setCurrent({
				...owned,
				output: { ...checkpoint, sequence: 4 },
			}),
		);
		const before = database.mutations.length;
		expect(await applyDesktopRecordingProgress(complete)).toEqual({
			handled: true,
			status: 503,
		});
		expect(database.mutations).toHaveLength(before);
	});

	it("ignores old callbacks after an edit retires a retained worker receipt", async () => {
		const { database, claim, payload } = fixture();
		await applyDesktopRecordingProgress(claim);
		const complete = {
			...payload,
			inventorySha256,
			manifestSha256,
			recordingWorker: { version: 1, action: "progress", sequence: 1 },
		};
		await applyDesktopRecordingProgress(complete);
		const published = database.getCurrent();
		if (!published) throw new Error("Missing published recording");
		database.setCurrent({
			...published,
			generation: "edited-generation",
			attemptId: null,
			remoteJobId: null,
			state: "source-blocked",
			errorCode: "output-replaced",
		});
		const before = database.mutations.length;
		expect(await applyDesktopRecordingProgress(payload)).toEqual({
			handled: true,
			status: 200,
		});
		expect(
			(await applyDesktopRecordingProgress(complete)).recordingWorker?.status,
		).toBe("superseded");
		expect(database.mutations).toHaveLength(before);
		expect(database.getCurrent()?.output).toEqual(published.output);
	});
});

describe("recording completion source binding", () => {
	it("binds the exact committed manifest, inventory and attempt output", () => {
		const { job, payload } = segmentedFixture();
		const result = validateDesktopRecordingCompletion(job, payload);
		expect(result.request).toEqual(job.verification);
		expect(result.options).toEqual({
			outputKey,
			outputSha256,
			sourceProof: payload.recordingVerification.sourceProof,
		});
	});

	it.each(["manifest", "inventory", "output-key", "audio"])(
		"refuses mismatched segmented %s evidence",
		(reason) => {
			const { job, payload } = segmentedFixture();
			if (reason === "manifest")
				payload.recordingVerification.sourceProof.manifestSha256 = "d".repeat(
					64,
				);
			else if (reason === "inventory")
				payload.recordingVerification.sourceProof.inventorySha256 = "d".repeat(
					64,
				);
			else if (reason === "output-key")
				payload.recordingVerification.outputKey = `${ownerId}/${videoId}/result.mp4`;
			else payload.recordingVerification.sourceProof.audioVerified = false;
			expect(() => validateDesktopRecordingCompletion(job, payload)).toThrow();
		},
	);

	it("refuses a different requested artifact even if the output proof is internally consistent", () => {
		const { job, payload } = segmentedFixture();
		job.verification = {
			version: 1,
			artifact: { kind: "segments", manifestSha256: "d".repeat(64) },
			requiredAudio: true,
		};
		expect(() => validateDesktopRecordingCompletion(job, payload)).toThrow();
	});

	it("binds an MP4 snapshot to the original identity despite a different copied ETag", () => {
		const { job, payload, source } = mp4Fixture();
		const result = validateDesktopRecordingCompletion(job, payload);
		expect(result.options.sourceObjectIdentity).toBe(source.mp4.objectIdentity);
		expect(result.options.outputKey).toBe(
			payload.recordingVerification.outputKey,
		);
		expect(result.proof.objectIdentity).not.toBe(source.mp4.objectIdentity);
	});

	it("does not upgrade an optional-audio MP4 worker proof after a stronger request arrives", () => {
		const { job, payload, verification } = mp4Fixture(false);
		job.verification = { ...verification, requiredAudio: true };
		expect(payload.metadata.audioCodec).toBe("aac");
		expect(() => validateDesktopRecordingCompletion(job, payload)).toThrow();
	});

	it.each(["identity", "size", "duration", "key"])(
		"rejects MP4 %s substitutions",
		(reason) => {
			const { job, payload, source } = mp4Fixture();
			if (reason === "identity") source.mp4.objectIdentity = '"other-original"';
			else if (reason === "size") source.mp4.fileSize += 1;
			else if (reason === "duration") source.mp4.duration += 1;
			else payload.recordingVerification.outputKey = outputKey;
			expect(() => validateDesktopRecordingCompletion(job, payload)).toThrow();
		},
	);

	it.each([
		"byte-hash",
		"full-decode",
		"source-preservation",
		"object-identity",
	])(
		"refuses malformed %s evidence before any publication writes",
		async (reason) => {
			const { job, payload } = segmentedFixture();
			const database = databaseFixture(job);
			const proof = {
				...payload.recordingVerification,
				...(reason === "byte-hash" ? { outputSha256: "not-a-sha256" } : {}),
				...(reason === "full-decode" ? { fullDecode: false } : {}),
				...(reason === "source-preservation"
					? {
							sourceProof: {
								...payload.recordingVerification.sourceProof,
								sourcePreserved: false,
							},
						}
					: {}),
				...(reason === "object-identity" ? { objectIdentity: 'W/"weak"' } : {}),
			};
			expect(
				await applyDesktopRecordingProgress({
					...payload,
					recordingVerification: proof,
				}),
			).toEqual({ handled: true, status: 400 });
			expect(database.mutations).toEqual([]);
			expect(mocks.head).not.toHaveBeenCalled();
		},
	);
});

describe("atomic publication revalidation", () => {
	it("publishes verified metadata, saves the matching receipt, and ignores duplicate completion", async () => {
		const { job, payload } = segmentedFixture();
		const database = databaseFixture(job);
		expect(await applyDesktopRecordingProgress(payload)).toEqual({
			handled: true,
			status: 200,
			published: true,
		});
		expect(
			database.mutations.find(
				(mutation) => mutation.table === mocks.tables.videos,
			)?.values,
		).toMatchObject({
			source: { type: "desktopMP4", outputKey },
			duration: metadata.duration,
		});
		expect(
			database.mutations.find(
				(mutation) => mutation.table === mocks.tables.jobs,
			)?.values,
		).toMatchObject({
			state: "verified",
			leaseExpiresAt: null,
			output: {
				outputKey,
				outputSha256,
				sourceProof: payload.recordingVerification.sourceProof,
			},
		});
		expect(
			database.mutations.filter((mutation) => mutation.operation === "delete"),
		).toEqual([{ operation: "delete", table: mocks.tables.uploads }]);
		const count = database.mutations.length;
		expect(await applyDesktopRecordingProgress(payload)).toEqual({
			handled: true,
			status: 200,
		});
		expect(database.mutations).toHaveLength(count);
	});

	it("publishes a verified MP4 copy without substituting its original upload identity", async () => {
		const { job, payload, source } = mp4Fixture(true);
		const database = databaseFixture(job);
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: metadata.fileSize,
				ETag: '"copied-mp4"',
			}),
		);
		expect(await applyDesktopRecordingProgress(payload)).toEqual({
			handled: true,
			status: 200,
			published: true,
		});
		expect(
			database.mutations.find(
				(mutation) => mutation.table === mocks.tables.jobs,
			)?.values,
		).toMatchObject({
			state: "verified",
			output: {
				artifact: payload.recordingVerification.request.artifact,
				objectIdentity: '"copied-mp4"',
				sourceObjectIdentity: source.mp4.objectIdentity,
				requiredAudioVerified: true,
			},
		});
	});

	it("accepts semantically unchanged persisted JSON regardless of key order", async () => {
		const { job, payload, source, verification } = segmentedFixture();
		const database = databaseFixture(job);
		database.beforeTransaction(() =>
			database.setCurrent({
				...job,
				source: Object.fromEntries(Object.entries(source).reverse()),
				verification: {
					requiredAudio: verification.requiredAudio,
					artifact: { manifestSha256, kind: "segments" },
					version: 1,
				},
			}),
		);
		expect(await applyDesktopRecordingProgress(payload)).toEqual({
			handled: true,
			status: 200,
			published: true,
		});
	});

	it.each([
		"generation",
		"attempt",
		"lease",
		"source",
		"verification",
		"worker",
	])(
		"does not publish after %s changes during output verification",
		async (reason) => {
			const { job, payload, source, verification } = segmentedFixture();
			const database = databaseFixture(job);
			database.beforeTransaction(() => {
				const current = { ...job };
				if (reason === "generation") current.generation = "new-generation";
				else if (reason === "attempt") current.attemptId = "new-attempt";
				else if (reason === "lease")
					current.leaseExpiresAt = new Date(Date.now() - 1);
				else if (reason === "source")
					current.source = { ...source, inventorySha256: "d".repeat(64) };
				else if (reason === "verification")
					current.verification = { ...verification, requiredAudio: false };
				else current.remoteJobId = "new-worker";
				database.setCurrent(current);
			});
			expect(await applyDesktopRecordingProgress(payload)).toEqual({
				handled: true,
				status: 503,
			});
			expect(database.mutations).toEqual([]);
		},
	);

	it("does not publish a weak MP4 receipt after audio requirements strengthen during its HEAD check", async () => {
		const { job, payload, verification } = mp4Fixture(false);
		const database = databaseFixture(job);
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: metadata.fileSize,
				ETag: '"copied-mp4"',
			}),
		);
		database.beforeTransaction(() =>
			database.setCurrent({
				...job,
				verification: { ...verification, requiredAudio: true },
			}),
		);
		expect(await applyDesktopRecordingProgress(payload)).toEqual({
			handled: true,
			status: 503,
		});
		expect(database.mutations).toEqual([]);
	});

	it.each(["deleted", "owner", "source", "bucket", "storage-integration"])(
		"does not publish when the video is concurrently changed: %s",
		async (reason) => {
			const { job, payload } = segmentedFixture();
			const database = databaseFixture(job);
			database.beforeTransaction(() => {
				if (reason === "deleted") {
					database.setVideo(null);
					return;
				}
				const current = { ...database.getVideo() };
				if (reason === "owner") current.ownerId = "different-owner";
				else if (reason === "source")
					current.source = { type: "desktopMP4", outputKey: "new-upload" };
				else if (reason === "bucket") current.bucket = "different-bucket";
				else current.storageIntegrationId = "different-integration";
				database.setVideo(current);
			});
			expect(await applyDesktopRecordingProgress(payload)).toEqual({
				handled: true,
				status: 503,
			});
			expect(database.mutations).toEqual([]);
		},
	);

	it("does not let an unfenced legacy completion overwrite a managed recording", async () => {
		const { job, payload } = segmentedFixture();
		const database = databaseFixture(job);
		expect(
			await applyDesktopRecordingProgress({
				videoId,
				jobId: "old-worker",
				phase: "complete",
				progress: 100,
				metadata,
				recordingVerification: payload.recordingVerification,
			}),
		).toEqual({ handled: true, status: 200 });
		expect(database.mutations).toEqual([]);
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it("does not publish after the verified output object was replaced", async () => {
		const { job, payload } = segmentedFixture();
		const database = databaseFixture(job);
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: metadata.fileSize,
				ETag: '"replaced-output"',
			}),
		);
		await expect(applyDesktopRecordingProgress(payload)).rejects.toThrow(
			"changed",
		);
		expect(database.mutations).toEqual([]);
	});
});
