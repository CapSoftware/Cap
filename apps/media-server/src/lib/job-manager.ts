import os from "node:os";
import {
	getContainerCpuLimit,
	getContainerCpuUsageMicros,
} from "./container-cpu";
import { getContainerMemoryMetrics } from "./container-memory";
import type { MediaOperationHandle } from "./media-operations";
import type { TempFileHandle } from "./temp-files";
import { getActiveDirectVideoProcessCount } from "./video-capacity";

export type JobPhase =
	| "queued"
	| "downloading"
	| "probing"
	| "processing"
	| "uploading"
	| "generating_thumbnail"
	| "complete"
	| "error"
	| "cancelled";

export type RecordingErrorCode =
	| "source-invalid"
	| "source-missing"
	| "source-changed"
	| "output-invalid"
	| "processing-unavailable";

export interface RecordingVerificationRequest {
	version: 1;
	artifact:
		| { kind: "segments"; manifestSha256: string }
		| {
				kind: "mp4";
				fileSize: number;
				duration: number;
				objectIdentity: string;
		  };
	requiredAudio: boolean;
}

export interface RecordingVerificationProof {
	request: RecordingVerificationRequest;
	fullDecode: true;
	objectIdentity: string;
	outputKey?: string;
	outputSha256?: string;
	sourceProof?: {
		version: 1;
		manifestSha256: string;
		inventorySha256: string;
		sourcePreserved: true;
		videoDuration: number;
		hasAudio: boolean;
		audioVerified: boolean;
	};
}

export interface JobProgress {
	recordingWorker?: {
		version: 1;
		action: "claim" | "progress";
		sequence: number;
	};
	generation?: string;
	attemptId?: string;
	inventorySha256?: string;
	recordingVerification?: RecordingVerificationProof;
	manifestSha256?: string;
	jobId: string;
	videoId: string;
	phase: JobPhase;
	progress: number;
	message?: string;
	error?: string;
	errorCode?: RecordingErrorCode;
	metadata?: VideoMetadata;
	outputUrl?: string;
}

export interface RecordingWorkerAcknowledgement {
	version: 1;
	status: "accepted" | "owned" | "superseded" | "stale";
	generation: string;
	attemptId: string;
	jobId: string;
	sequence: number;
	ownerJobId?: string;
	leaseDurationMs?: number;
}

export interface VideoMetadata {
	duration: number;
	width: number;
	height: number;
	fps: number;
	videoCodec: string;
	audioCodec: string | null;
	audioChannels: number | null;
	sampleRate: number | null;
	bitrate: number;
	fileSize: number;
}

export interface Job {
	recordingWorkerVersion?: 1;
	recordingWorkerSequence?: number;
	recordingWorkerClaimed?: boolean;
	recordingWorkerRevoked?: boolean;
	recordingWorkerLeaseExpiresAt?: number;
	recordingWorkerLeaseTimer?: ReturnType<typeof setTimeout>;
	recordingWorkerClaim?: Promise<RecordingWorkerAcknowledgement | undefined>;
	generation?: string;
	attemptId?: string;
	inventorySha256?: string;
	recordingRequestKey?: string;
	terminalAt?: number;
	terminalWebhookAcknowledgedAt?: number;
	webhookInFlight?: boolean;
	webhookPending?: boolean;
	webhookPromise?: Promise<RecordingWorkerAcknowledgement | undefined>;
	webhookAcknowledgedAt?: number;
	webhookLastAttemptAt?: number;
	recordingVerificationDeadlineAt?: number;
	recordingProcessingDeadlineAt?: number;
	recordingVerification?: RecordingVerificationProof;
	manifestSha256?: string;
	jobId: string;
	videoId: string;
	userId: string;
	phase: JobPhase;
	progress: number;
	message?: string;
	error?: string;
	errorCode?: RecordingErrorCode;
	metadata?: VideoMetadata;
	outputUrl?: string;
	createdAt: number;
	updatedAt: number;
	inputTempFile?: TempFileHandle;
	outputTempFile?: TempFileHandle;
	mediaOperation?: MediaOperationHandle;
	webhookUrl?: string;
	webhookSecret?: string;
	abortController?: AbortController;
}

const jobs = new Map<string, Job>();
const JOB_TTL_MS = 60 * 60 * 1000;
const STALE_JOB_MS = 15 * 60 * 1000;
const MAX_JOB_LIFETIME_MS = 60 * 60 * 1000;
const MAX_RECORDING_PROCESSING_BUDGET_MS = 3 * 60 * 60 * 1000;
const WEBHOOK_MAX_ATTEMPTS = 3;
const WEBHOOK_RETRY_BASE_MS = 500;
const WEBHOOK_TIMEOUT_MS = 5000;
const RECORDING_HEARTBEAT_MS = 60_000;
const MAX_RECORDING_WORKER_LEASE_MS = 5 * 60_000;
const UNACKNOWLEDGED_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

const configuredMaxProcesses =
	Number.parseInt(
		process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES ?? "0",
		10,
	) || 0;

const hostCpuCount = os.cpus().length;

const CPU_LOAD_THRESHOLD = 0.8;
const CPU_REJECT_THRESHOLD = 0.95;
const DEFAULT_MAX_CONCURRENT_VIDEO_PROCESSES = 4;
const MEMORY_THROTTLE_THRESHOLD = 0.85;
const MEMORY_REJECT_THRESHOLD = 0.9;
const VIDEO_PROCESS_MEMORY_BUDGET_MB = 768;
const CPU_SAMPLE_MIN_INTERVAL_MS = 250;

let previousContainerCpuUsageMicros = 0;
let previousContainerCpuSampleAt = 0;
let containerCpuPressure = 0;

function getCpuCapacity(): number {
	return getContainerCpuLimit() || hostCpuCount;
}

function getCpuPressure(cpuCapacity: number, loadAvg1m: number): number {
	const usageMicros = getContainerCpuUsageMicros();
	const now = performance.now();

	if (usageMicros > 0) {
		if (
			previousContainerCpuUsageMicros > 0 &&
			now - previousContainerCpuSampleAt >= CPU_SAMPLE_MIN_INTERVAL_MS
		) {
			const elapsedSeconds = (now - previousContainerCpuSampleAt) / 1000;
			const usedCpuSeconds =
				(usageMicros - previousContainerCpuUsageMicros) / 1_000_000;
			containerCpuPressure =
				usedCpuSeconds >= 0
					? Math.max(0, usedCpuSeconds / elapsedSeconds / cpuCapacity)
					: 0;
			previousContainerCpuUsageMicros = usageMicros;
			previousContainerCpuSampleAt = now;
		} else if (previousContainerCpuUsageMicros === 0) {
			previousContainerCpuUsageMicros = usageMicros;
			previousContainerCpuSampleAt = now;
		}

		return containerCpuPressure;
	}

	return loadAvg1m / cpuCapacity;
}

function isActivePhase(phase: JobPhase): boolean {
	return phase !== "complete" && phase !== "error" && phase !== "cancelled";
}

export function getActiveVideoProcessCount(): number {
	let count = 0;
	for (const job of jobs.values()) {
		if (isActivePhase(job.phase)) {
			count++;
		}
	}
	return count + getActiveDirectVideoProcessCount();
}

export function getMaxConcurrentVideoProcesses(): number {
	if (configuredMaxProcesses > 0) {
		return configuredMaxProcesses;
	}
	const containerMemoryLimitMB = getContainerMemoryMetrics().limitMB;
	const memoryBoundMax =
		containerMemoryLimitMB > 0
			? Math.max(
					1,
					Math.floor(
						(containerMemoryLimitMB * MEMORY_THROTTLE_THRESHOLD) /
							VIDEO_PROCESS_MEMORY_BUDGET_MB,
					),
				)
			: DEFAULT_MAX_CONCURRENT_VIDEO_PROCESSES;
	return Math.max(
		1,
		Math.min(
			DEFAULT_MAX_CONCURRENT_VIDEO_PROCESSES,
			Math.floor(getCpuCapacity() / 2),
			memoryBoundMax,
		),
	);
}

export interface SystemResources {
	cpuCount: number;
	hostCpuCount: number;
	loadAvg1m: number;
	cpuPressure: number;
	processRssMB: number;
	processHeapMB: number;
	processRssLimitMB: number;
	containerMemoryUsageMB: number;
	containerMemoryLimitMB: number;
	memoryPressure: number;
	configuredMax: number;
	effectiveMax: number;
	throttleReason: string | null;
}

export function getSystemResources(): SystemResources {
	const loadAvg1m = os.loadavg()[0];
	const cpuCount = getCpuCapacity();
	const cpuPressure = getCpuPressure(cpuCount, loadAvg1m);
	const mem = process.memoryUsage();
	const processRssMB = Math.round(mem.rss / (1024 * 1024));
	const processHeapMB = Math.round(mem.heapUsed / (1024 * 1024));
	const containerMemory = getContainerMemoryMetrics();
	const memoryUsageMB = containerMemory.usageMB || processRssMB;
	const memoryLimitMB = containerMemory.limitMB;
	const memoryPressure = memoryLimitMB > 0 ? memoryUsageMB / memoryLimitMB : 0;
	const max = getMaxConcurrentVideoProcesses();

	let effectiveMax = max;
	let throttleReason: string | null = null;

	if (cpuPressure > CPU_LOAD_THRESHOLD) {
		effectiveMax =
			cpuPressure >= CPU_REJECT_THRESHOLD
				? 0
				: Math.max(
						1,
						Math.floor(max * (1 - (cpuPressure - CPU_LOAD_THRESHOLD))),
					);
		throttleReason = `CPU utilization ${cpuPressure.toFixed(2)} exceeds ${CPU_LOAD_THRESHOLD} threshold`;
	}

	if (memoryPressure > MEMORY_THROTTLE_THRESHOLD) {
		const memMax =
			memoryPressure >= MEMORY_REJECT_THRESHOLD
				? 0
				: Math.max(1, Math.floor(max * (1 - memoryPressure)));
		if (memMax < effectiveMax) {
			effectiveMax = memMax;
			throttleReason = `Container memory ${memoryUsageMB}MB exceeds ${Math.round(MEMORY_THROTTLE_THRESHOLD * 100)}% of ${memoryLimitMB}MB limit`;
		}
	}

	return {
		cpuCount,
		hostCpuCount,
		loadAvg1m,
		cpuPressure,
		processRssMB,
		processHeapMB,
		processRssLimitMB: memoryLimitMB,
		containerMemoryUsageMB: containerMemory.usageMB,
		containerMemoryLimitMB: containerMemory.limitMB,
		memoryPressure,
		configuredMax: configuredMaxProcesses,
		effectiveMax,
		throttleReason,
	};
}

export function hasCriticalMemoryPressure(): boolean {
	return getSystemResources().memoryPressure >= MEMORY_REJECT_THRESHOLD;
}

export function canAcceptNewVideoProcess(): boolean {
	const active = getActiveVideoProcessCount();
	const resources = getSystemResources();
	return active < resources.effectiveMax;
}

export function generateJobId(): string {
	return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createJob(
	jobId: string,
	videoId: string,
	userId: string,
	webhookUrl?: string,
	webhookSecret?: string,
): Job {
	const now = Date.now();
	const job: Job = {
		jobId,
		videoId,
		userId,
		phase: "queued",
		progress: 0,
		createdAt: now,
		updatedAt: now,
		webhookUrl,
		webhookSecret,
	};
	jobs.set(jobId, job);
	return job;
}

export function getJob(jobId: string): Job | undefined {
	return jobs.get(jobId);
}

export function updateJob(
	jobId: string,
	updates: Partial<
		Pick<
			Job,
			| "phase"
			| "generation"
			| "attemptId"
			| "inventorySha256"
			| "recordingRequestKey"
			| "progress"
			| "message"
			| "error"
			| "errorCode"
			| "metadata"
			| "manifestSha256"
			| "recordingVerification"
			| "outputUrl"
			| "inputTempFile"
			| "outputTempFile"
			| "mediaOperation"
			| "abortController"
		>
	>,
): Job | undefined {
	const job = jobs.get(jobId);
	if (!job) return undefined;
	if (!isActivePhase(job.phase)) return undefined;

	Object.assign(job, updates, { updatedAt: Date.now() });
	if (job.recordingWorkerVersion) {
		job.recordingWorkerSequence = (job.recordingWorkerSequence ?? 0) + 1;
	}
	if (!isActivePhase(job.phase)) {
		job.terminalAt ??= job.updatedAt;
		if (job.recordingWorkerLeaseTimer)
			clearTimeout(job.recordingWorkerLeaseTimer);
	}
	if (!isActivePhase(job.phase) && job.webhookInFlight)
		job.webhookPending = true;
	return job;
}

export function touchJob(jobId: string): Job | undefined {
	const job = jobs.get(jobId);
	if (!job) return undefined;

	job.updatedAt = Date.now();
	return job;
}

export function beginRecordingVerification(
	jobId: string,
	budgetMs: number,
): boolean {
	const job = jobs.get(jobId);
	const now = Date.now();
	if (
		!job ||
		!isActivePhase(job.phase) ||
		job.abortController?.signal.aborted ||
		job.recordingVerificationDeadlineAt !== undefined ||
		now >
			(job.recordingProcessingDeadlineAt ??
				job.createdAt + MAX_JOB_LIFETIME_MS) ||
		!Number.isSafeInteger(budgetMs) ||
		budgetMs <= 0 ||
		budgetMs > MAX_JOB_LIFETIME_MS
	)
		return false;
	job.recordingVerificationDeadlineAt = Math.min(
		now + budgetMs,
		job.recordingProcessingDeadlineAt ?? Number.POSITIVE_INFINITY,
	);
	job.updatedAt = now;
	return true;
}

export function beginRecordingProcessing(
	jobId: string,
	budgetMs: number,
): boolean {
	const job = jobs.get(jobId);
	const now = Date.now();
	if (
		!job ||
		!isActivePhase(job.phase) ||
		job.abortController?.signal.aborted ||
		job.recordingProcessingDeadlineAt !== undefined ||
		job.recordingVerificationDeadlineAt !== undefined ||
		now - job.updatedAt > STALE_JOB_MS ||
		now - job.createdAt > MAX_JOB_LIFETIME_MS ||
		!Number.isSafeInteger(budgetMs) ||
		budgetMs <= 0 ||
		budgetMs > MAX_RECORDING_PROCESSING_BUDGET_MS
	)
		return false;
	job.recordingProcessingDeadlineAt = now + budgetMs;
	job.updatedAt = now;
	return true;
}

export function deleteJob(jobId: string): boolean {
	const job = jobs.get(jobId);
	if (job) {
		if (job.recordingWorkerLeaseTimer)
			clearTimeout(job.recordingWorkerLeaseTimer);
		job.abortController?.abort();
		job.inputTempFile?.cleanup().catch(() => {});
		job.outputTempFile?.cleanup().catch(() => {});
		void job.mediaOperation?.cancel();
	}
	return jobs.delete(jobId);
}

export async function abortAllJobs(): Promise<number> {
	const abortedJobs: Job[] = [];

	for (const job of jobs.values()) {
		if (
			job.phase !== "complete" &&
			job.phase !== "error" &&
			job.phase !== "cancelled"
		) {
			job.abortController?.abort();
			updateJob(job.jobId, {
				phase: "cancelled",
				message: "Server shutting down",
			});
			abortedJobs.push(job);
		}
	}

	await Promise.allSettled(abortedJobs.map((job) => sendWebhook(job)));

	return abortedJobs.length;
}

export function getAllJobs(): Job[] {
	return Array.from(jobs.values());
}

export function cleanupExpiredJobs(): number {
	const now = Date.now();
	let cleaned = 0;

	for (const [jobId, job] of jobs) {
		const age = now - job.createdAt;
		const staleness = now - job.updatedAt;
		if (!isActivePhase(job.phase)) {
			const terminalAge = now - (job.terminalAt ?? job.updatedAt);
			const awaitingWebhook =
				Boolean(job.webhookUrl) && !job.terminalWebhookAcknowledgedAt;
			if (
				terminalAge >
				(awaitingWebhook ? UNACKNOWLEDGED_TERMINAL_TTL_MS : JOB_TTL_MS)
			) {
				deleteJob(jobId);
				cleaned++;
			} else if (
				awaitingWebhook &&
				now - (job.webhookLastAttemptAt ?? 0) >= 60_000
			) {
				void sendWebhook(job);
			}
			continue;
		}
		if (
			job.recordingWorkerClaimed &&
			job.recordingWorkerLeaseExpiresAt !== undefined &&
			now >= job.recordingWorkerLeaseExpiresAt
		) {
			revokeRecordingWorker(job, "Recording worker lease expired");
			cleaned++;
			continue;
		}

		if (staleness > JOB_TTL_MS) {
			if (isActivePhase(job.phase)) {
				console.warn(
					`[job-manager] Cleaning up expired job ${jobId} (phase=${job.phase}, age=${Math.round(age / 60000)}m)`,
				);
				job.abortController?.abort();
				updateJob(jobId, {
					phase: "error",
					error: `Job expired: no progress update for ${Math.round(staleness / 60000)} minutes`,
					message: "Processing failed (expired)",
				});
				void sendWebhook(job);
			}
			cleaned++;
			continue;
		}

		if (isActivePhase(job.phase) && staleness > STALE_JOB_MS) {
			console.warn(
				`[job-manager] Marking stale job ${jobId} as error (phase=${job.phase}, no update for ${Math.round(staleness / 60000)}m)`,
			);
			job.abortController?.abort();
			updateJob(jobId, {
				phase: "error",
				error: `Job stale: no progress update for ${Math.round(staleness / 60000)} minutes`,
				message: "Processing failed (stale)",
			});
			void sendWebhook(job);
			cleaned++;
			continue;
		}

		const deadline =
			job.recordingVerificationDeadlineAt ??
			job.recordingProcessingDeadlineAt ??
			job.createdAt + MAX_JOB_LIFETIME_MS;
		if (isActivePhase(job.phase) && now > deadline) {
			console.warn(
				`[job-manager] Marking long-running job ${jobId} as error (phase=${job.phase}, age=${Math.round(age / 60000)}m)`,
			);
			job.abortController?.abort();
			updateJob(jobId, {
				phase: "error",
				error:
					job.recordingVerificationDeadlineAt === undefined &&
					job.recordingProcessingDeadlineAt === undefined
						? `Job exceeded maximum lifetime of ${Math.round(MAX_JOB_LIFETIME_MS / 60000)} minutes`
						: "Recording verification timed out",
				message: "Processing failed (timeout)",
			});
			void sendWebhook(job);
			cleaned++;
			continue;
		}
		if (
			job.generation &&
			job.attemptId &&
			(!job.recordingWorkerVersion || job.recordingWorkerClaimed) &&
			now - (job.webhookLastAttemptAt ?? 0) >= RECORDING_HEARTBEAT_MS
		)
			void sendWebhook(job);
	}

	return cleaned;
}

export function getJobProgress(job: Job): JobProgress {
	return {
		...(job.recordingWorkerVersion && {
			recordingWorker: {
				version: 1 as const,
				action: job.recordingWorkerClaimed
					? ("progress" as const)
					: ("claim" as const),
				sequence: job.recordingWorkerSequence ?? 0,
			},
		}),
		generation: job.generation,
		attemptId: job.attemptId,
		inventorySha256: job.inventorySha256,
		manifestSha256: job.manifestSha256,
		recordingVerification: job.recordingVerification,
		jobId: job.jobId,
		videoId: job.videoId,
		phase: job.phase,
		progress: job.progress,
		message: job.message,
		error: job.error,
		errorCode: job.errorCode,
		metadata: job.metadata,
		outputUrl: job.outputUrl,
	};
}

function revokeRecordingWorker(job: Job, reason: string): void {
	job.recordingWorkerRevoked = true;
	job.webhookPending = false;
	job.abortController?.abort(new Error(reason));
	if (isActivePhase(job.phase)) {
		updateJob(job.jobId, {
			phase: "cancelled",
			errorCode: "processing-unavailable",
			error: reason,
			message: reason,
		});
	}
	job.webhookPending = false;
	job.terminalWebhookAcknowledgedAt = Date.now();
	console.warn("[job-manager] Recording worker stopped", {
		jobId: job.jobId,
		videoId: job.videoId,
		generation: job.generation,
		attemptId: job.attemptId,
		reason,
	});
}

function parseWorkerAcknowledgement(
	value: unknown,
	payload: JobProgress,
): RecordingWorkerAcknowledgement | undefined {
	if (!value || typeof value !== "object" || !("recordingWorker" in value))
		return undefined;
	const ack = value.recordingWorker;
	if (!ack || typeof ack !== "object") return undefined;
	if (
		!("version" in ack) ||
		ack.version !== 1 ||
		!("status" in ack) ||
		typeof ack.status !== "string" ||
		!["accepted", "owned", "superseded", "stale"].includes(ack.status) ||
		!("generation" in ack) ||
		ack.generation !== payload.generation ||
		!("attemptId" in ack) ||
		ack.attemptId !== payload.attemptId ||
		!("jobId" in ack) ||
		ack.jobId !== payload.jobId ||
		!("sequence" in ack) ||
		ack.sequence !== payload.recordingWorker?.sequence ||
		("ownerJobId" in ack && typeof ack.ownerJobId !== "string") ||
		(ack.status === "owned" &&
			(!("ownerJobId" in ack) ||
				!ack.ownerJobId ||
				ack.ownerJobId === payload.jobId)) ||
		("leaseDurationMs" in ack &&
			(typeof ack.leaseDurationMs !== "number" ||
				!Number.isSafeInteger(ack.leaseDurationMs) ||
				ack.leaseDurationMs <= 0 ||
				ack.leaseDurationMs > MAX_RECORDING_WORKER_LEASE_MS))
	)
		return undefined;
	return ack as RecordingWorkerAcknowledgement;
}

async function deliverWebhook(
	job: Job,
	payload: JobProgress,
): Promise<RecordingWorkerAcknowledgement | undefined> {
	if (!job.webhookUrl) return undefined;
	const body = JSON.stringify(payload);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (job.webhookSecret) {
		headers["x-media-server-secret"] = job.webhookSecret;
	}

	let lastError: unknown;

	for (let attempt = 0; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
		if (body !== JSON.stringify(getJobProgress(job))) {
			job.webhookPending = true;
			return undefined;
		}
		const startedAt = Date.now();
		job.webhookLastAttemptAt = startedAt;
		try {
			const resp = await fetch(job.webhookUrl, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
			});
			if (job.recordingWorkerRevoked || jobs.get(job.jobId) !== job) {
				await resp.body?.cancel();
				return undefined;
			}

			if (resp.ok) {
				let ack: RecordingWorkerAcknowledgement | undefined;
				if (payload.recordingWorker) {
					ack = parseWorkerAcknowledgement(await resp.json(), payload);
					if (!ack)
						throw new Error(
							"Recording worker acknowledgement is unsupported or invalid",
						);
					if (ack.status === "owned" || ack.status === "superseded") {
						revokeRecordingWorker(
							job,
							"Recording worker ownership was superseded",
						);
						return ack;
					}
					if (ack.status === "stale") return ack;
					if (isActivePhase(payload.phase)) {
						if (
							!ack.leaseDurationMs ||
							startedAt + ack.leaseDurationMs <= Date.now()
						)
							throw new Error(
								"Recording worker acknowledgement has no live lease",
							);
						job.recordingWorkerLeaseExpiresAt = startedAt + ack.leaseDurationMs;
						job.recordingWorkerClaimed = true;
						if (job.recordingWorkerLeaseTimer)
							clearTimeout(job.recordingWorkerLeaseTimer);
						if (isActivePhase(job.phase)) {
							job.recordingWorkerLeaseTimer = setTimeout(
								() => {
									if (isActivePhase(job.phase))
										revokeRecordingWorker(
											job,
											"Recording worker lease expired",
										);
								},
								Math.max(0, job.recordingWorkerLeaseExpiresAt - Date.now()),
							);
							job.recordingWorkerLeaseTimer.unref?.();
						}
					}
				} else {
					await resp.body?.cancel();
				}
				job.webhookAcknowledgedAt = Date.now();
				if (
					!isActivePhase(payload.phase) &&
					body === JSON.stringify(getJobProgress(job))
				) {
					job.terminalWebhookAcknowledgedAt = Date.now();
				}
				return ack;
			}
			await resp.body?.cancel();

			lastError = new Error(
				`Webhook returned ${resp.status} for job ${job.jobId}`,
			);
		} catch (err) {
			lastError = err;
		}
		if (body !== JSON.stringify(getJobProgress(job))) {
			job.webhookPending = true;
			return undefined;
		}

		if (attempt < WEBHOOK_MAX_ATTEMPTS - 1) {
			await new Promise((resolve) =>
				setTimeout(resolve, WEBHOOK_RETRY_BASE_MS * 2 ** attempt),
			);
		}
	}
	console.error(
		`[job-manager] Failed to send webhook for job ${job.jobId}:`,
		lastError,
	);
	return undefined;
}

export function sendWebhook(
	job: Job,
): Promise<RecordingWorkerAcknowledgement | undefined> {
	if (!job.webhookUrl || job.recordingWorkerRevoked)
		return Promise.resolve(undefined);
	job.webhookPending = true;
	if (job.webhookPromise) return job.webhookPromise;
	job.webhookInFlight = true;
	job.webhookPromise = (async () => {
		let acknowledgement: RecordingWorkerAcknowledgement | undefined;
		while (
			job.webhookPending &&
			!job.recordingWorkerRevoked &&
			jobs.get(job.jobId) === job
		) {
			job.webhookPending = false;
			acknowledgement = await deliverWebhook(job, getJobProgress(job));
		}
		return acknowledgement;
	})().finally(() => {
		job.webhookInFlight = false;
		job.webhookPromise = undefined;
	});
	return job.webhookPromise;
}

export function claimRecordingWorker(
	job: Job,
): Promise<RecordingWorkerAcknowledgement | undefined> {
	job.recordingWorkerVersion = 1;
	job.recordingWorkerSequence ??= 0;
	job.recordingWorkerClaim ??= sendWebhook(job);
	return job.recordingWorkerClaim;
}

export function forceCleanupActiveJobs(): number {
	let cleaned = 0;
	const now = Date.now();

	for (const [jobId, job] of jobs) {
		if (isActivePhase(job.phase)) {
			console.warn(
				`[job-manager] Force-cleaning job ${jobId} (phase=${job.phase}, age=${Math.round((now - job.createdAt) / 60000)}m)`,
			);
			job.abortController?.abort();
			updateJob(jobId, {
				phase: "error",
				error: "Force-cleaned by admin",
				message: "Processing failed (force-cleaned)",
			});
			void sendWebhook(job);
			cleaned++;
		}
	}

	return cleaned;
}

const cleanupInterval = setInterval(() => {
	const cleaned = cleanupExpiredJobs();
	if (cleaned > 0) {
		console.log(`[job-manager] Cleaned up ${cleaned} expired/stale jobs`);
	}
}, 60 * 1000);

cleanupInterval.unref?.();
