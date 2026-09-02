import { z } from "zod";

const terminalJobSchema = z
	.object({
		jobId: z.string(),
		videoId: z.string(),
		phase: z.enum(["complete", "error", "cancelled"]),
	})
	.passthrough();

export async function reconcileDesktopRecordingJob({
	videoId,
	jobId,
	mediaServerUrl,
	webhookUrl,
	secret,
}: {
	videoId: string;
	jobId: string;
	mediaServerUrl: string;
	webhookUrl: string;
	secret?: string;
}): Promise<boolean> {
	if (!secret) return false;
	try {
		const headers = { "x-media-server-secret": secret };
		const response = await fetch(
			`${mediaServerUrl.replace(/\/$/, "")}/video/process/${encodeURIComponent(jobId)}/status`,
			{
				headers,
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (!response.ok) return false;
		const job = terminalJobSchema.safeParse(await response.json());
		if (
			!job.success ||
			job.data.jobId !== jobId ||
			job.data.videoId !== videoId
		)
			return false;
		const delivered = await fetch(webhookUrl, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(job.data),
			signal: AbortSignal.timeout(30_000),
		});
		return delivered.ok;
	} catch {
		return false;
	}
}
