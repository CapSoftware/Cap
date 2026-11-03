import {
	getActiveVideoProcessCount,
	getAllJobs,
	getJobTotals,
	getMaxConcurrentVideoProcesses,
	getSystemResources,
} from "./job-manager";
import { getDrainBlockers, getShutdownGraceMs, isDraining } from "./lifecycle";
import {
	getMaxConcurrentAudioOperations,
	getMaxConcurrentProbeOperations,
} from "./media-operations";
import { getMediaTransferCacheUsage } from "./media-transfer";
import { getTempDirUsage } from "./temp-files";
import {
	getActiveDirectVideoProcessCount,
	getMaxConcurrentDirectVideoProcesses,
} from "./video-capacity";

export async function getRuntimeReport() {
	const blockers = getDrainBlockers();
	const jobs = getAllJobs();
	return {
		draining: isDraining(),
		shutdownGraceMs: getShutdownGraceMs(),
		processUptimeSeconds: Math.round(process.uptime()),
		activeJobs: jobs.filter(
			(job) =>
				job.phase !== "complete" &&
				job.phase !== "error" &&
				job.phase !== "cancelled",
		).length,
		jobsInMemory: jobs.length,
		jobTotals: getJobTotals(),
		activeSubprocesses: blockers.subprocesses,
		backgroundTasks: blockers.backgroundTasks,
		inFlightRequests: blockers.inFlightRequests,
		slots: {
			video: {
				active: getActiveVideoProcessCount(),
				max: getMaxConcurrentVideoProcesses(),
				effectiveMax: getSystemResources().effectiveMax,
			},
			directVideo: {
				active: getActiveDirectVideoProcessCount(),
				max: getMaxConcurrentDirectVideoProcesses(),
			},
			audio: {
				active: blockers.audioOperations,
				max: getMaxConcurrentAudioOperations(),
			},
			probe: {
				active: blockers.probeOperations,
				max: getMaxConcurrentProbeOperations(),
			},
		},
		tempDir: await getTempDirUsage(),
		mediaTransferCache: getMediaTransferCacheUsage(),
	};
}
