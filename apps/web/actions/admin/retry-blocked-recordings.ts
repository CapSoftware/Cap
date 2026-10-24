"use server";

import { serverEnv } from "@cap/env";
import { parseAdminVideoId, requireAdmin } from "@/lib/admin-access";
import {
	getProcessingState,
	retryBlockedDesktopRecording,
} from "@/lib/desktop-recording-jobs";
import { queueDesktopSegmentsFinalization } from "@/lib/desktop-segments-finalization";

const MAX_RECORDINGS_PER_REQUEST = 25;

export type RetryBlockedRecordingResult = {
	input: string;
	videoId?: string;
	status:
		| "queued"
		| "dispatch-failed"
		| "already-processing"
		| "not-found"
		| "not-retryable"
		| "failed";
	detail?: string;
	shareUrl?: string;
};

export async function adminRetryBlockedRecordings(
	input: string,
): Promise<RetryBlockedRecordingResult[]> {
	await requireAdmin();
	const entries = [
		...new Set(
			input
				.split(/[\s,]+/)
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
	if (entries.length === 0) throw new Error("Enter at least one video ID");
	if (entries.length > MAX_RECORDINGS_PER_REQUEST)
		throw new Error(
			`Retry at most ${MAX_RECORDINGS_PER_REQUEST} recordings at a time`,
		);

	const results: RetryBlockedRecordingResult[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		try {
			const videoId = parseAdminVideoId(entry);
			if (seen.has(videoId)) continue;
			seen.add(videoId);
			const retried = await retryBlockedDesktopRecording({ videoId });
			if (retried.status === "not-found") {
				results.push({ input: entry, videoId, status: "not-found" });
				continue;
			}
			if (retried.status === "not-retryable") {
				results.push({
					input: entry,
					videoId,
					status: "not-retryable",
					detail: `${retried.state}${retried.errorCode ? ` (${retried.errorCode})` : ""}`,
				});
				continue;
			}
			const queued = await queueDesktopSegmentsFinalization({
				videoId,
				userId: retried.ownerId,
			});
			const shareUrl = `${serverEnv().WEB_URL}/s/${videoId}`;
			if (queued === "queued") {
				results.push({
					input: entry,
					videoId,
					status: "queued",
					detail: `was ${retried.previousErrorCode}`,
					shareUrl,
				});
				continue;
			}
			// The job was just reset with no workflow, so "already-processing" means the start failed
			// unless another run claimed it first.
			const current = await getProcessingState({ videoId });
			const dispatchFailed = current?.errorCode === "workflow-dispatch-failed";
			results.push({
				input: entry,
				videoId,
				status: dispatchFailed ? "dispatch-failed" : "already-processing",
				detail: dispatchFailed
					? "the workflow did not start; automatic recovery will retry it"
					: `was ${retried.previousErrorCode}; another workflow already owns it`,
				shareUrl,
			});
		} catch (error) {
			results.push({
				input: entry,
				status: "failed",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}
