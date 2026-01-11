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

let activeVideoProcesses = 0;
const MAX_CONCURRENT_VIDEO_PROCESSES = 3;

export function getActiveVideoProcessCount(): number {
	return activeVideoProcesses;
}

export function canAcceptNewVideoProcess(): boolean {
	return activeVideoProcesses < MAX_CONCURRENT_VIDEO_PROCESSES;
}

export function incrementActiveVideoProcesses(): void {
	activeVideoProcesses++;
}

export function decrementActiveVideoProcesses(): void {
	if (activeVideoProcesses > 0) {
		activeVideoProcesses--;
	}
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

export function getAllJobs(): Job[] {
	return Array.from(jobs.values());
}

export function cleanupExpiredJobs(): number {
	const now = Date.now();
	let cleaned = 0;

	for (const [jobId, job] of jobs) {
		if (now - job.updatedAt > JOB_TTL_MS) {
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

setInterval(
	() => {
		const cleaned = cleanupExpiredJobs();
		if (cleaned > 0) {
			console.log(`[job-manager] Cleaned up ${cleaned} expired jobs`);
		}
	},
	5 * 60 * 1000,
);
