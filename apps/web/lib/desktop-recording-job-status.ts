import { z } from "zod";

const jobSchema = z
	.object({
		jobId: z.string(),
		videoId: z.string(),
		generation: z.string().optional(),
		attemptId: z.string().optional(),
		inventorySha256: z.string().optional(),
		recordingWorker: z
			.object({
				version: z.literal(1),
				action: z.literal("progress"),
				sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
			})
			.optional(),
		phase: z.enum([
			"queued",
			"downloading",
			"probing",
			"processing",
			"uploading",
			"generating_thumbnail",
			"complete",
			"error",
			"cancelled",
		]),
	})
	.passthrough();

type RecordingJobLookup = {
	videoId: string;
	jobId: string;
	generation?: string;
	attemptId?: string;
	inventorySha256?: string;
	mediaServerUrl: string;
	webhookUrl: string;
	secret?: string;
};

export type DesktopRecordingRemoteObservation =
	| { status: "unavailable"; delivered: false }
	| { status: "active"; delivered: false; workerProtocol?: 1 }
	| { status: "terminal"; delivered: boolean };

export async function observeDesktopRecordingJob({
	videoId,
	jobId,
	generation,
	attemptId,
	inventorySha256,
	mediaServerUrl,
	webhookUrl,
	secret,
}: RecordingJobLookup): Promise<DesktopRecordingRemoteObservation> {
	const unavailable = { status: "unavailable", delivered: false } as const;
	if (!secret) return unavailable;
	try {
		const headers = { "x-media-server-secret": secret };
		const response = await fetch(
			`${mediaServerUrl.replace(/\/$/, "")}/video/process/${encodeURIComponent(jobId)}/status`,
			{
				headers,
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok) return unavailable;
		const job = jobSchema.safeParse(await response.json());
		if (
			!job.success ||
			job.data.jobId !== jobId ||
			job.data.videoId !== videoId ||
			(generation !== undefined && job.data.generation !== generation) ||
			(attemptId !== undefined && job.data.attemptId !== attemptId) ||
			(inventorySha256 !== undefined &&
				job.data.inventorySha256 !== inventorySha256)
		)
			return unavailable;
		if (
			job.data.phase !== "complete" &&
			job.data.phase !== "error" &&
			job.data.phase !== "cancelled"
		) {
			return {
				status: "active",
				delivered: false,
				...(job.data.recordingWorker ? { workerProtocol: 1 as const } : {}),
			};
		}
		const delivered = await fetch(webhookUrl, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(job.data),
			signal: AbortSignal.timeout(30_000),
		});
		if (!delivered.ok || !job.data.recordingWorker) {
			return { status: "terminal", delivered: delivered.ok };
		}
		const acknowledgement = z
			.object({
				recordingWorker: z.object({
					version: z.literal(1),
					status: z.literal("accepted"),
					generation: z.literal(job.data.generation ?? ""),
					attemptId: z.literal(job.data.attemptId ?? ""),
					jobId: z.literal(jobId),
					sequence: z.literal(job.data.recordingWorker.sequence),
				}),
			})
			.safeParse(await delivered.json().catch(() => null));
		return { status: "terminal", delivered: acknowledgement.success };
	} catch {
		return unavailable;
	}
}

export async function reconcileDesktopRecordingJob(
	input: RecordingJobLookup,
): Promise<boolean> {
	return (await observeDesktopRecordingJob(input)).delivered;
}
