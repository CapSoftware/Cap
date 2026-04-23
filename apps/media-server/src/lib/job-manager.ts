import os from "node:os";
import type { Subprocess } from "bun";
import type { TempFileHandle } from "./temp-files";

export type JobPhase =
	| "queued"
	| "downloading"
	| "probing"
	| "processing"
	| "uploading"
	| "generating_thumbnail"
	| "generating_sprites"
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
	process?: Subprocess;
	webhookUrl?: string;
	webhookSecret?: string;
	abortController?: AbortController;
}

const jobs = new Map<string, Job>();
const JOB_TTL_MS = 60 * 60 * 1000;
const STALE_JOB_MS = 15 * 60 * 1000;
const MAX_JOB_LIFETIME_MS = 45 * 60 * 1000;

// Dynamic concurrency control for video processing.
//
// Instead of a manual counter (which drifted and caused permanent "server busy"
// errors), active process count is derived from actual job state in the map.
//
// Concurrency limit is determined by:
//   1. MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES env var (if set, used as ceiling)
//   2. Otherwise: floor(cpuCount / 2), minimum 1
//   3. Dynamically reduced when CPU load or process memory is high
//
// CPU throttling: when 1-minute load average per core exceeds 0.8,
// effective max is scaled down proportionally.
//
// Memory throttling (opt-in): set MEDIA_SERVER_MEMORY_LIMIT_MB to the container's
// memory limit. When process RSS exceeds 85% of that limit, effective max is reduced.
// Uses process-level RSS (not system-wide free memory) so it works correctly on
// shared hosts where os.freemem() reflects other tenants.

const configuredMaxProcesses =
	Number.parseInt(
		process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES ?? "0",
		10,
	) || 0;

const cpuCount = os.cpus().length;

const CPU_LOAD_THRESHOLD = 0.8;
const PROCESS_RSS_LIMIT_MB =
	Number.parseInt(process.env.MEDIA_SERVER_MEMORY_LIMIT_MB ?? "0", 10) || 0;

function isActivePhase(phase: JobPhase): boolean {
	return phase !== "complete" && phase !== "error" && phase !== "cancelled";
}

// Derived from actual job state — no manual increment/decrement that can drift
export function getActiveVideoProcessCount(): number {
	let count = 0;
	for (const job of jobs.values()) {
		if (isActivePhase(job.phase)) {
			count++;
		}
	}
	return count;
}

export function getMaxConcurrentVideoProcesses(): number {
	if (configuredMaxProcesses > 0) {
		return configuredMaxProcesses;
	}
	return Math.max(1, Math.floor(cpuCount / 2));
}

export interface SystemResources {
	cpuCount: number;
	loadAvg1m: number;
	cpuPressure: number;
	processRssMB: number;
	processHeapMB: number;
	processRssLimitMB: number;
	configuredMax: number;
	effectiveMax: number;
	throttleReason: string | null;
}

export function getSystemResources(): SystemResources {
	const loadAvg1m = os.loadavg()[0];
	const cpuPressure = loadAvg1m / cpuCount;
	const mem = process.memoryUsage();
	const processRssMB = Math.round(mem.rss / (1024 * 1024));
	const processHeapMB = Math.round(mem.heapUsed / (1024 * 1024));
	const max = getMaxConcurrentVideoProcesses();

	let effectiveMax = max;
	let throttleReason: string | null = null;

	if (cpuPressure > CPU_LOAD_THRESHOLD) {
		effectiveMax = Math.max(
			1,
			Math.floor(max * (1 - (cpuPressure - CPU_LOAD_THRESHOLD))),
		);
		throttleReason = `CPU load ${cpuPressure.toFixed(2)} exceeds ${CPU_LOAD_THRESHOLD} threshold`;
	}

	if (PROCESS_RSS_LIMIT_MB > 0 && processRssMB > PROCESS_RSS_LIMIT_MB * 0.85) {
		const memPressure = processRssMB / PROCESS_RSS_LIMIT_MB;
		const memMax = Math.max(1, Math.floor(max * (1 - memPressure)));
		if (memMax < effectiveMax) {
			effectiveMax = memMax;
			throttleReason = `Process RSS ${processRssMB}MB exceeds 85% of ${PROCESS_RSS_LIMIT_MB}MB limit`;
		}
	}

	return {
		cpuCount,
		loadAvg1m,
		cpuPressure,
		processRssMB,
		processHeapMB,
		processRssLimitMB: PROCESS_RSS_LIMIT_MB,
		configuredMax: configuredMaxProcesses,
		effectiveMax,
		throttleReason,
	};
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
			| "process"
			| "abortController"
		>
	>,
): Job | undefined {
	const job = jobs.get(jobId);
	if (!job) return undefined;

	Object.assign(job, updates, { updatedAt: Date.now() });
	return job;
}

export function deleteJob(jobId: string): boolean {
	const job = jobs.get(jobId);
	if (job) {
		job.abortController?.abort();
		job.inputTempFile?.cleanup().catch(() => {});
		job.outputTempFile?.cleanup().catch(() => {});
		if (job.process) {
			try {
				job.process.kill();
			} catch {}
		}
	}
	return jobs.delete(jobId);
}

export function abortAllJobs(): number {
	let aborted = 0;

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
			aborted++;
		}
	}

	return aborted;
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

	try {
		const resp = await fetch(job.webhookUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(15_000),
		});
		if (!resp.ok) {
			console.error(
				`[job-manager] Webhook returned ${resp.status} for job ${job.jobId}`,
			);
		}
	} catch (err) {
		console.error(
			`[job-manager] Failed to send webhook for job ${job.jobId}:`,
			err,
		);
	}
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
