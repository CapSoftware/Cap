import { db } from "@cap/database";
import { developerTranscripts } from "@cap/database/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { TranscriptErrorCode } from "@/lib/developer-transcripts";

async function loadRun(transcriptId: string) {
	const [row] = await db()
		.select({
			appId: developerTranscripts.appId,
			status: developerTranscripts.status,
			runId: developerTranscripts.runId,
			deletedAt: developerTranscripts.deletedAt,
		})
		.from(developerTranscripts)
		.where(eq(developerTranscripts.id, transcriptId))
		.limit(1);
	return row ?? null;
}

export async function claimTranscriptRun(transcriptId: string, runId: string) {
	await db()
		.update(developerTranscripts)
		.set({ status: "processing" })
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				eq(developerTranscripts.runId, runId),
				eq(developerTranscripts.status, "queued"),
				isNull(developerTranscripts.deletedAt),
			),
		);
	const row = await loadRun(transcriptId);
	return (
		row !== null &&
		!row.deletedAt &&
		row.status === "processing" &&
		row.runId === runId
	);
}

export async function failTranscriptRun(
	transcriptId: string,
	runId: string,
	code: TranscriptErrorCode,
	message: string,
): Promise<{ failed: boolean; appId: string | null }> {
	await db()
		.update(developerTranscripts)
		.set({
			status: "error",
			errorCode: code,
			errorMessage: message.slice(0, 512),
			reservedMicroCredits: 0,
			completedAt: new Date(),
		})
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				eq(developerTranscripts.runId, runId),
				inArray(developerTranscripts.status, ["queued", "processing"]),
			),
		);
	const row = await loadRun(transcriptId);
	return {
		failed: row !== null && row.runId === runId && row.status === "error",
		appId: row?.appId ?? null,
	};
}
