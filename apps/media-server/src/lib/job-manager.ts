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

export interface JobProgress {
	jobId: string;
	videoId: string;
	phase: JobPhase;
	progress: number;
	message?: string;
	error?: string;
	metadata?: VideoMetadata;
	outputUrl?: string;
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
	jobId: string;
	videoId: string;
	userId: string;
	phase: JobPhase;
	progress: number;
	message?: string;
	error?: string;
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
const WEBHOOK_MAX_ATTEMPTS = 3;
const WEBHOOK_RETRY_BASE_MS = 500;
const WEBHOOK_TIMEOUT_MS = 5000;

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
			| "progress"
			| "message"
			| "error"
			| "metadata"
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

	Object.assign(job, updates, { updatedAt: Date.now() });
	return job;
}

export function touchJob(jobId: string): Job | undefined {
	const job = jobs.get(jobId);
	if (!job) return undefined;

	job.updatedAt = Date.now();
	return job;
}

export function deleteJob(jobId: string): boolean {
	const job = jobs.get(jobId);
	if (job) {
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
			job.phase = "cancelled";
			job.message = "Server shutting down";
			job.updatedAt = Date.now();
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

		if (staleness > JOB_TTL_MS) {
			if (isActivePhase(job.phase)) {
				console.warn(
					`[job-manager] Cleaning up expired job ${jobId} (phase=${job.phase}, age=${Math.round(age / 60000)}m)`,
				);
				job.abortController?.abort();
				job.phase = "error";
				job.error = `Job expired: no progress update for ${Math.round(staleness / 60000)} minutes`;
				job.message = "Processing failed (expired)";
				job.updatedAt = now;
				void sendWebhook(job);
			}
			deleteJob(jobId);
			cleaned++;
			continue;
		}

		if (isActivePhase(job.phase) && staleness > STALE_JOB_MS) {
			console.warn(
				`[job-manager] Marking stale job ${jobId} as error (phase=${job.phase}, no update for ${Math.round(staleness / 60000)}m)`,
			);
			job.abortController?.abort();
			job.phase = "error";
			job.error = `Job stale: no progress update for ${Math.round(staleness / 60000)} minutes`;
			job.message = "Processing failed (stale)";
			job.updatedAt = now;
			void sendWebhook(job);
			cleaned++;
			continue;
		}

		if (isActivePhase(job.phase) && age > MAX_JOB_LIFETIME_MS) {
			console.warn(
				`[job-manager] Marking long-running job ${jobId} as error (phase=${job.phase}, age=${Math.round(age / 60000)}m)`,
			);
			job.abortController?.abort();
			job.phase = "error";
			job.error = `Job exceeded maximum lifetime of ${Math.round(MAX_JOB_LIFETIME_MS / 60000)} minutes`;
			job.message = "Processing failed (timeout)";
			job.updatedAt = now;
			void sendWebhook(job);
			cleaned++;
		}
	}

	return cleaned;
}

export function getJobProgress(job: Job): JobProgress {
	return {
		jobId: job.jobId,
		videoId: job.videoId,
		phase: job.phase,
		progress: job.progress,
		message: job.message,
		error: job.error,
		metadata: job.metadata,
		outputUrl: job.outputUrl,
	};
}

export async function sendWebhook(job: Job): Promise<void> {
	if (!job.webhookUrl) return;

	const payload = getJobProgress(job);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (job.webhookSecret) {
		headers["x-media-server-secret"] = job.webhookSecret;
	}

	let lastError: unknown;

	for (let attempt = 0; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
		try {
			const resp = await fetch(job.webhookUrl, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
			});

			if (resp.ok) {
				return;
			}

			lastError = new Error(
				`Webhook returned ${resp.status} for job ${job.jobId}`,
			);
		} catch (err) {
			lastError = err;
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
			job.phase = "error";
			job.error = "Force-cleaned by admin";
			job.message = "Processing failed (force-cleaned)";
			job.updatedAt = now;
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
