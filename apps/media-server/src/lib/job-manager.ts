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
	abortController?: AbortController;
}

const jobs = new Map<string, Job>();
const JOB_TTL_MS = 60 * 60 * 1000;

const configuredMaxProcesses =
	Number.parseInt(
		process.env.MEDIA_SERVER_MAX_CONCURRENT_VIDEO_PROCESSES ?? "0",
		10,
	) || 0;

const cpuCount = os.cpus().length;
const totalMemoryMB = os.totalmem() / (1024 * 1024);

const CPU_LOAD_THRESHOLD = 0.8;
const MEMORY_FREE_THRESHOLD = 0.15;

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
	totalMemoryMB: number;
	freeMemoryMB: number;
	memoryUsagePercent: number;
	configuredMax: number;
	effectiveMax: number;
	throttleReason: string | null;
}

export function getSystemResources(): SystemResources {
	const loadAvg1m = os.loadavg()[0];
	const freeMemoryMB = os.freemem() / (1024 * 1024);
	const cpuPressure = loadAvg1m / cpuCount;
	const memoryUsagePercent = 1 - freeMemoryMB / totalMemoryMB;
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

	if (memoryUsagePercent > 1 - MEMORY_FREE_THRESHOLD) {
		const memMax = Math.max(1, Math.floor(max * (1 - memoryUsagePercent)));
		if (memMax < effectiveMax) {
			effectiveMax = memMax;
			throttleReason = `Memory usage ${(memoryUsagePercent * 100).toFixed(0)}% exceeds ${((1 - MEMORY_FREE_THRESHOLD) * 100).toFixed(0)}% threshold`;
		}
	}

	return {
		cpuCount,
		loadAvg1m,
		cpuPressure,
		totalMemoryMB: Math.round(totalMemoryMB),
		freeMemoryMB: Math.round(freeMemoryMB),
		memoryUsagePercent,
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
		if (now - job.updatedAt > JOB_TTL_MS) {
			if (isActivePhase(job.phase)) {
				console.warn(
					`[job-manager] Cleaning up stuck job ${jobId} (phase=${job.phase}, age=${Math.round((now - job.createdAt) / 60000)}m)`,
				);
				job.abortController?.abort();
			}
			deleteJob(jobId);
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

	try {
		await fetch(job.webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (err) {
		console.error(
			`[job-manager] Failed to send webhook for job ${job.jobId}:`,
			err,
		);
	}
}

const cleanupInterval = setInterval(
	() => {
		const cleaned = cleanupExpiredJobs();
		if (cleaned > 0) {
			console.log(`[job-manager] Cleaned up ${cleaned} expired jobs`);
		}
	},
	5 * 60 * 1000,
);

cleanupInterval.unref?.();
