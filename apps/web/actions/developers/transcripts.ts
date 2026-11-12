"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
	createTranscriptUpload,
	deleteTranscript,
	getTranscript,
	listConsoleTranscripts,
	startTranscriptUpload,
	type TranscriptUploadTarget,
} from "@/lib/developer-transcript-store";
import {
	type TranscriptSummaryRow,
	transcriptHasNoSpeech,
} from "@/lib/developer-transcripts";
import { canUseInfra } from "@/lib/infra-access";

export type AudioTranscriptRow = {
	id: string;
	name: string;
	status: TranscriptSummaryRow["status"];
	durationSeconds: number | null;
	costMicroCredits: number;
	noSpeech: boolean;
	errorMessage: string | null;
	createdAt: string;
};

type ActionFailure = { ok: false; code: string; message: string };

const UNAUTHORIZED: ActionFailure = {
	ok: false,
	code: "unauthorized",
	message: "Sign in again to continue.",
};

async function ownsApp(appId: string) {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) return false;
	const [app] = await db()
		.select({ id: developerApps.id })
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);
	return Boolean(app);
}

type ConsoleTranscript = Pick<
	TranscriptSummaryRow,
	| "id"
	| "name"
	| "status"
	| "durationSeconds"
	| "billedMicroCredits"
	| "wordCount"
	| "hasText"
	| "errorMessage"
	| "createdAt"
>;

const toRow = (row: ConsoleTranscript): AudioTranscriptRow => ({
	id: row.id,
	name: row.name,
	status: row.status,
	durationSeconds: row.durationSeconds,
	costMicroCredits: row.billedMicroCredits,
	noSpeech: transcriptHasNoSpeech(row),
	errorMessage: row.status === "error" ? row.errorMessage : null,
	createdAt: row.createdAt.toISOString(),
});

const AUDIO_PAGE_SIZE = 50;
const AUDIO_MAX_ROWS = 1000;

export async function listAudioTranscripts(
	appId: string,
	limit = AUDIO_PAGE_SIZE,
): Promise<
	| { ok: true; transcripts: AudioTranscriptRow[]; hasMore: boolean }
	| ActionFailure
> {
	if (!(await ownsApp(appId))) return UNAUTHORIZED;
	const rows = Number.isFinite(limit)
		? Math.min(AUDIO_MAX_ROWS, Math.max(AUDIO_PAGE_SIZE, Math.floor(limit)))
		: AUDIO_PAGE_SIZE;
	try {
		const { transcripts, hasMore } = await listConsoleTranscripts(appId, rows);
		return { ok: true, transcripts: transcripts.map(toRow), hasMore };
	} catch (error) {
		console.error("[infra-audio] Transcripts unavailable", error);
		return {
			ok: false,
			code: "unavailable",
			message: "Transcripts could not be loaded.",
		};
	}
}

export async function createAudioTranscriptUpload(
	appId: string,
	input: { fileName: string; contentLength: number },
): Promise<
	| { ok: true; transcript: AudioTranscriptRow; upload: TranscriptUploadTarget }
	| ActionFailure
> {
	if (!(await ownsApp(appId))) return UNAUTHORIZED;
	const result = await createTranscriptUpload(appId, {
		fileName: String(input.fileName ?? "").slice(0, 255),
		contentLength: Number(input.contentLength),
	});
	if (!result.ok) {
		return { ok: false, code: result.code, message: result.message };
	}
	if (!result.upload) {
		return {
			ok: false,
			code: "upload_unavailable",
			message: "The upload could not be started.",
		};
	}
	return {
		ok: true,
		transcript: toRow(result.transcript),
		upload: result.upload,
	};
}

export async function startAudioTranscript(
	appId: string,
	transcriptId: string,
): Promise<{ ok: true; transcript: AudioTranscriptRow } | ActionFailure> {
	if (!(await ownsApp(appId))) return UNAUTHORIZED;
	const result = await startTranscriptUpload(appId, transcriptId);
	if (!result.ok) {
		return { ok: false, code: result.code, message: result.message };
	}
	return { ok: true, transcript: toRow(result.transcript) };
}

export async function readAudioTranscript(
	appId: string,
	transcriptId: string,
): Promise<{ ok: true; text: string } | ActionFailure> {
	if (!(await ownsApp(appId))) return UNAUTHORIZED;
	const transcript = await getTranscript(appId, transcriptId);
	if (!transcript || transcript.status !== "complete") {
		return {
			ok: false,
			code: "transcript_not_ready",
			message: "This transcript is not ready to read.",
		};
	}
	return { ok: true, text: transcript.text ?? "" };
}

export async function deleteAudioTranscript(
	appId: string,
	transcriptId: string,
): Promise<{ ok: true } | ActionFailure> {
	if (!(await ownsApp(appId))) return UNAUTHORIZED;
	const result = await deleteTranscript(appId, transcriptId);
	if (!result.ok) {
		return { ok: false, code: result.code, message: result.message };
	}
	return { ok: true };
}
