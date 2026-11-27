import { db } from "@cap/database";
import { users, videoEdits, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	getRecordingObjectIdentity,
	type RecordingObjectHead,
} from "@cap/web-backend/src/Storage/recording-object-identity";
import type { AiGenerationLanguage } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import {
	createAssemblyAIClient,
	getAssemblyAITranscriptionOptions,
} from "@/lib/assemblyai";
import {
	createEditTranscript,
	type EditTranscript,
	getEditTranscriptObjectKey,
	parseEditTranscript,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import {
	decryptEditTranscriptObject,
	encryptEditTranscriptObject,
} from "@/lib/edit-transcript-storage";
import type {
	EditorCaptionSource,
	EditorCaptionSourcePlan,
} from "@/lib/editor-caption-sources";
import {
	combineEditorCaptionTranscripts,
	isEditorReplacementOutput,
} from "@/lib/editor-caption-transcripts";
import { normalizeWebEditorImportOrder } from "@/lib/editor-imports";
import { videoMetadataObject } from "@/lib/editor-metadata-sql";
import { getEditSourceKey } from "@/lib/video-edit-processing";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

type CaptionJobPayload = {
	plan: EditorCaptionSourcePlan;
	requestId: string;
};

const MAX_CAPTION_SOURCE_BYTES = 12 * 1024 * 1024 * 1024;

function noSpeechError(value: unknown) {
	const message = value instanceof Error ? value.message : String(value);
	return /no spoken audio|does not appear to contain audio|audio duration is too short/i.test(
		message,
	);
}

function captionSourceHeadMatches(
	head: RecordingObjectHead & { ContentLength?: number },
	source: EditorCaptionSource,
) {
	const identity = getRecordingObjectIdentity(
		head,
		source.expectedIdentity ?? undefined,
	);
	return (
		Number.isSafeInteger(head.ContentLength) &&
		!!head.ContentLength &&
		head.ContentLength <= MAX_CAPTION_SOURCE_BYTES &&
		(source.expectedSize === null ||
			head.ContentLength === source.expectedSize) &&
		!!identity &&
		(source.expectedIdentity === null || identity === source.expectedIdentity)
	);
}

async function loadCaptionJob(payload: CaptionJobPayload) {
	"use step";

	const [record] = await db()
		.select({ video: videos, owner: users })
		.from(videos)
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(sql`${videos.id} = ${payload.plan.videoId}`);
	const video = record?.video;
	const job = video?.metadata?.webEditorCaptionJob;
	if (
		!video ||
		video.ownerId !== payload.plan.ownerId ||
		!userIsPro(record.owner) ||
		job?.status !== "processing" ||
		job.requestId !== payload.requestId ||
		job.sourceHash !== payload.plan.hash
	) {
		throw new FatalError("Editor caption job is no longer authorized");
	}
	const clips = video.metadata?.webEditorClips?.items ?? [];
	const assets = video.metadata?.webEditorVideos?.items ?? [];
	const imports = normalizeWebEditorImportOrder(
		video.metadata?.webEditorImports,
		clips,
		assets,
		video.ownerId,
		video.id,
	);
	const firstSource = payload.plan.sources[0];
	const [legacyEdit] = await db()
		.select({ sourceKey: videoEdits.sourceKey })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, video.id));
	if (
		legacyEdit?.sourceKey !== undefined &&
		legacyEdit.sourceKey !== getEditSourceKey(video.ownerId, video.id)
	) {
		throw new FatalError("Editor caption sources changed");
	}
	if (legacyEdit && firstSource && firstSource.key === legacyEdit.sourceKey) {
		const [storage] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
			{ resolvePublishedOutput: false },
		).pipe(runWorkflowPromise);
		const head = await storage
			.headObject(legacyEdit.sourceKey)
			.pipe(runWorkflowPromise);
		if (!captionSourceHeadMatches(head, firstSource)) {
			throw new FatalError("Editor caption media changed");
		}
	}
	const base = legacyEdit ? undefined : video.metadata?.editorSources?.display;
	if (
		!imports ||
		!firstSource ||
		(legacyEdit
			? firstSource.key !== legacyEdit.sourceKey
			: firstSource.key === getEditSourceKey(video.ownerId, video.id)) ||
		(base !== undefined &&
			(base.key !== firstSource.key ||
				(base.size ?? null) !== firstSource.expectedSize ||
				(base.objectIdentity ?? null) !== firstSource.expectedIdentity)) ||
		imports.items.length + 1 !== payload.plan.sources.length ||
		imports.items.some((item, index) => {
			const asset = assets.find((candidate) => candidate.path === item.path);
			const source = payload.plan.sources[index + 1];
			const clip =
				item.kind === "clip"
					? clips.find((candidate) => candidate.displayPath === item.path)
					: null;
			return (
				!asset ||
				!source ||
				!clip ||
				asset.key !== source.key ||
				asset.size !== source.expectedSize ||
				asset.objectIdentity !== source.expectedIdentity ||
				clip.hasAudio !== source.hasAudio
			);
		})
	) {
		throw new FatalError("Editor caption sources changed");
	}
	return video;
}

async function readTranscript(video: typeof videos.$inferSelect, key: string) {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(runWorkflowPromise);
	const content = await bucket.getObject(key).pipe(runWorkflowPromise);
	if (Option.isNone(content)) return null;
	const decrypted = decryptEditTranscriptObject(
		content.value,
		video.ownerId,
		video.id,
	);
	return decrypted ? parseEditTranscript(decrypted) : null;
}

async function cacheOriginalCaptionTranscript(
	video: typeof videos.$inferSelect,
	source: EditorCaptionSource,
	transcript: EditTranscript,
) {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(runWorkflowPromise);
	const head = await bucket.headObject(source.key).pipe(runWorkflowPromise);
	if (!captionSourceHeadMatches(head, source)) {
		throw new FatalError("Editor caption media changed");
	}
	const saved = await bucket
		.getObject(source.transcriptKey)
		.pipe(runWorkflowPromise);
	if (Option.isSome(saved)) {
		const decrypted = decryptEditTranscriptObject(
			saved.value,
			video.ownerId,
			video.id,
		);
		const cached = decrypted ? parseEditTranscript(decrypted) : null;
		if (
			cached &&
			Math.abs(cached.durationMs - source.mediaDurationMs) <= 2000
		) {
			return;
		}
	}
	await bucket
		.putObject(
			source.transcriptKey,
			encryptEditTranscriptObject(
				serializeEditTranscript(transcript),
				video.ownerId,
				video.id,
			),
			{ contentType: "text/plain" },
		)
		.pipe(runWorkflowPromise);
}

async function transcribeCaptionSource(
	video: typeof videos.$inferSelect,
	source: EditorCaptionSource,
	language: AiGenerationLanguage,
): Promise<EditTranscript | null> {
	"use step";

	if (!source.hasAudio) return null;
	const [bucket] = await Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(runWorkflowPromise);
	const head = await bucket.headObject(source.key).pipe(runWorkflowPromise);
	if (!captionSourceHeadMatches(head, source)) {
		throw new FatalError("Editor caption media changed");
	}
	const url = await bucket
		.getInternalSignedObjectUrl(source.key, { expiresIn: 2 * 60 * 60 })
		.pipe(runWorkflowPromise);
	if (!serverEnv().ASSEMBLY_API_KEY)
		throw new FatalError("Missing ASSEMBLY_API_KEY");
	const client = createAssemblyAIClient();
	let result: Awaited<ReturnType<typeof client.transcripts.transcribe>> | null =
		null;
	try {
		result = await client.transcripts.transcribe({
			audio: url,
			...getAssemblyAITranscriptionOptions(language),
			disfluencies: true,
		});
	} catch (error) {
		if (!noSpeechError(error)) throw error;
	}
	if (result?.status === "error") {
		if (!noSpeechError(result.error)) {
			throw new Error(
				`AssemblyAI editor caption transcription failed: ${result.error ?? "Unknown error"}`,
			);
		}
		result = null;
	}
	const transcript = createEditTranscript(
		result ?? { words: [] },
		source.mediaDurationMs,
	);
	await bucket
		.putObject(
			source.transcriptKey,
			encryptEditTranscriptObject(
				serializeEditTranscript(transcript),
				video.ownerId,
				video.id,
			),
			{ contentType: "text/plain" },
		)
		.pipe(runWorkflowPromise);
	return transcript;
}

async function saveCaptionResult(
	video: typeof videos.$inferSelect,
	plan: EditorCaptionSourcePlan,
	transcript: EditTranscript,
) {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(runWorkflowPromise);
	await bucket
		.putObject(
			plan.combinedKey,
			encryptEditTranscriptObject(
				serializeEditTranscript(transcript),
				video.ownerId,
				video.id,
			),
			{ contentType: "text/plain" },
		)
		.pipe(runWorkflowPromise);
}

async function finishCaptionJob(payload: CaptionJobPayload, error: boolean) {
	"use step";

	await db()
		.update(videos)
		.set({
			metadata: error
				? sql`JSON_SET(${videoMetadataObject()}, '$.webEditorCaptionJob.status', 'error')`
				: sql`JSON_REMOVE(${videoMetadataObject()}, '$.webEditorCaptionJob')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				sql`${videos.id} = ${payload.plan.videoId}`,
				sql`${videos.ownerId} = ${payload.plan.ownerId}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorCaptionJob.requestId')) = ${payload.requestId}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorCaptionJob.sourceHash')) = ${payload.plan.hash}`,
			),
		);
}

export async function transcribeWebEditorCaptionsWorkflow(
	payload: CaptionJobPayload,
) {
	"use workflow";

	try {
		const transcripts: (EditTranscript | null)[] = [];
		for (let start = 0; start < payload.plan.sources.length; ) {
			const batchLength = start === 0 ? 1 : 2;
			const batch = payload.plan.sources.slice(start, start + batchLength);
			const results = await Promise.allSettled(
				batch.map(async (source, offset): Promise<EditTranscript | null> => {
					const index = start + offset;
					const video = await loadCaptionJob(payload);
					if (
						!source.hasAudio ||
						(index === 0 &&
							video.transcriptionStatus === "NO_AUDIO" &&
							!isEditorReplacementOutput(video))
					) {
						return null;
					}
					let transcript: EditTranscript | null = null;
					let reusedShareTranscript = false;
					if (
						payload.plan.language === "auto" &&
						index === 0 &&
						video.transcriptionStatus === "COMPLETE" &&
						!isEditorReplacementOutput(video)
					) {
						transcript = await readTranscript(
							video,
							getEditTranscriptObjectKey(video.ownerId, video.id),
						);
						reusedShareTranscript =
							!!transcript &&
							Math.abs(transcript.durationMs - source.mediaDurationMs) <= 2000;
					}
					if (
						!transcript ||
						Math.abs(transcript.durationMs - source.mediaDurationMs) > 2000
					) {
						transcript = await readTranscript(video, source.transcriptKey);
					}
					if (
						!transcript ||
						Math.abs(transcript.durationMs - source.mediaDurationMs) > 2000
					) {
						transcript = await transcribeCaptionSource(
							video,
							source,
							payload.plan.language,
						);
					} else if (reusedShareTranscript) {
						await cacheOriginalCaptionTranscript(video, source, transcript);
					}
					return transcript;
				}),
			);
			for (const result of results) {
				if (result.status === "rejected") throw result.reason;
				transcripts.push(result.value);
			}
			start += batchLength;
		}
		const combined = combineEditorCaptionTranscripts(payload.plan, transcripts);
		if (!combined) throw new FatalError("Editor caption source timing changed");
		const video = await loadCaptionJob(payload);
		await saveCaptionResult(video, payload.plan, combined);
		await finishCaptionJob(payload, false);
		return { success: true };
	} catch (error) {
		if (
			!(
				error instanceof FatalError &&
				(error.message === "Editor caption job is no longer authorized" ||
					error.message === "Editor caption sources changed")
			)
		) {
			console.error(
				`[editorCaptions] AssemblyAI transcription failed for ${payload.plan.videoId}`,
				error,
			);
		}
		await finishCaptionJob(payload, true);
		return { success: false };
	}
}
