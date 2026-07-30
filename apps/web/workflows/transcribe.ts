import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import {
	organizations,
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoEditSpec, VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type AiGenerationLanguage,
	parseAiGenerationLanguage,
	type Video,
} from "@cap/web-domain";
import { AssemblyAI } from "assemblyai";
import { and, eq, sql } from "drizzle-orm";
import { FatalError } from "workflow";
import { getAssemblyAITranscriptionOptions } from "@/lib/assemblyai";
import {
	ENHANCED_AUDIO_CONTENT_TYPE,
	ENHANCED_AUDIO_EXTENSION,
	enhanceAudioFromUrl,
} from "@/lib/audio-enhance";
import { checkHasAudioTrack, extractAudioFromUrl } from "@/lib/audio-extract";
import {
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
	getEditTranscriptBackfillStatus,
	getEditTranscriptObjectKey,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { encryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import { startAiGeneration } from "@/lib/generate-ai";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface TranscribeWorkflowPayload {
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	transcriptionDisabled: boolean;
	aiGenerationLanguage: AiGenerationLanguage;
}

interface BackfillEditTranscriptPayload {
	videoId: string;
	userId: string;
	requestId: string;
}

const EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME = "audio-edit-transcript-v3-temp.mp3";

interface TranscriptionArtifacts {
	vtt: string;
	editTranscript: string;
}

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, aiGenerationEnabled } = payload;

	let videoData: VideoData;
	try {
		videoData = await validateVideo(videoId);
	} catch (error) {
		await markError(videoId);
		throw error;
	}

	if (videoData.transcriptionDisabled) {
		await markSkipped(videoId);
		return { success: true, message: "Transcription disabled - skipped" };
	}

	try {
		const audioUrl = await extractAudio(videoId, userId, videoData.video);

		if (!audioUrl) {
			await markNoAudio(videoId);
			return {
				success: true,
				message: "Video has no audio track - skipped transcription",
			};
		}

		const transcription = await transcribeWithAssemblyAI(
			audioUrl,
			videoData.aiGenerationLanguage,
			Math.max(0, (videoData.video.duration ?? 0) * 1000),
		);

		await saveTranscription(videoId, userId, videoData.video, transcription);
	} catch (error) {
		await markError(videoId);
		await cleanupTempAudio(videoId, userId, videoData.video);
		throw error;
	}

	await cleanupTempAudio(videoId, userId, videoData.video);

	if (aiGenerationEnabled) {
		await queueAiGeneration(videoId, userId);
	}

	return { success: true, message: "Transcription completed successfully" };
}

export async function backfillEditTranscriptWorkflow(
	payload: BackfillEditTranscriptPayload,
) {
	"use workflow";

	const { videoId, userId, requestId } = payload;
	let video: typeof videos.$inferSelect;

	try {
		video = await validateEditTranscriptBackfill(videoId, userId, requestId);
		// Legacy videos only: the transcript must describe the ORIGINAL media, so
		// edited videos are transcribed from their preserved source mp4.
		const videoEdit = await loadVideoEditForBackfill(videoId);
		const audioUrl = await extractAudio(
			videoId,
			userId,
			video,
			EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME,
			videoEdit?.sourceKey,
		);
		if (!audioUrl) {
			await saveEditTranscriptBackfillError(videoId, requestId, video);
			return { success: false };
		}

		const editTranscript = await transcribeEditTranscriptWithAssemblyAI(
			audioUrl,
			videoEdit ? videoEdit.editSpec.sourceDuration : (video.duration ?? 0),
		);
		await saveEditTranscriptBackfill(
			videoId,
			userId,
			requestId,
			video,
			editTranscript,
		);
		await cleanupTempAudio(
			videoId,
			userId,
			video,
			EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME,
		);
		return { success: true };
	} catch (error) {
		console.error(
			`[transcribe] Editable transcript backfill failed for ${videoId}`,
			error,
		);
		const loadedVideo = await loadVideoForEditTranscriptBackfill(videoId);
		if (loadedVideo?.ownerId === userId) {
			await saveEditTranscriptBackfillError(videoId, requestId, loadedVideo);
			await cleanupTempAudio(
				videoId,
				userId,
				loadedVideo,
				EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME,
			);
		}
		return { success: false };
	}
}

async function validateVideo(videoId: string): Promise<VideoData> {
	"use step";

	if (!serverEnv().ASSEMBLY_API_KEY) {
		throw new FatalError("Missing ASSEMBLY_API_KEY");
	}

	const query = await db()
		.select({
			video: videos,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0) {
		throw new FatalError("Video does not exist");
	}

	const result = query[0];
	if (!result?.video) {
		throw new FatalError("Video information is missing");
	}

	const transcriptionDisabled =
		result.video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript ??
		false;

	await db()
		.update(videos)
		.set({ transcriptionStatus: "PROCESSING" })
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video: result.video,
		transcriptionDisabled,
		aiGenerationLanguage: parseAiGenerationLanguage(
			result.orgSettings?.aiGenerationLanguage,
		),
	};
}

async function loadVideoForEditTranscriptBackfill(videoId: string) {
	"use step";

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	return video ?? null;
}

async function loadVideoEditForBackfill(
	videoId: string,
): Promise<{ sourceKey: string; editSpec: VideoEditSpec } | null> {
	"use step";

	const [edit] = await db()
		.select({
			sourceKey: videoEdits.sourceKey,
			editSpec: videoEdits.editSpec,
		})
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId as Video.VideoId));

	return edit ?? null;
}

async function validateEditTranscriptBackfill(
	videoId: string,
	userId: string,
	requestId: string,
) {
	"use step";

	if (!serverEnv().ASSEMBLY_API_KEY) {
		throw new FatalError("Missing ASSEMBLY_API_KEY");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	if (!video || video.ownerId !== userId) {
		throw new FatalError("Video does not exist");
	}
	if (
		video.transcriptionStatus !== "COMPLETE" ||
		video.isScreenshot ||
		(video.source.type !== "desktopMP4" && video.source.type !== "webMP4") ||
		!video.duration ||
		video.duration <= 0
	) {
		throw new FatalError("Transcript editing is not available");
	}
	const status = getEditTranscriptBackfillStatus(video.metadata);
	if (status?.status !== "processing" || status.requestId !== requestId) {
		throw new FatalError("Transcript request expired");
	}

	return video;
}

async function markSkipped(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "SKIPPED" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markNoAudio(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "NO_AUDIO" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markError(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "ERROR" })
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.transcriptionStatus, "PROCESSING"),
			),
		);
}

async function extractAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	tempAudioFilename = "audio-temp.mp3",
	sourceKeyOverride?: string,
): Promise<string | null> {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const videoUrl = await resolveVideoSourceUrl(
		videoId,
		userId,
		video,
		sourceKeyOverride,
	);

	const useMediaServer = isMediaServerConfigured();
	console.log(
		`[transcribe] Audio detection: useMediaServer=${useMediaServer}, videoId=${videoId}`,
	);

	let hasAudio: boolean;
	let audioBuffer: Buffer;

	if (useMediaServer) {
		try {
			const probe = await probeVideoViaMediaServer(videoUrl);
			console.log(
				`[transcribe] Probe result for ${videoId}: audioCodec=${probe.audioCodec}, videoCodec=${probe.videoCodec}, duration=${probe.duration}, audioChannels=${probe.audioChannels}, sampleRate=${probe.sampleRate}`,
			);
			hasAudio = probe.audioCodec !== null;
		} catch (probeError) {
			console.error(
				`[transcribe] Probe failed for ${videoId}, falling back to audio check:`,
				probeError,
			);
			hasAudio = await checkHasAudioTrackViaMediaServer(videoUrl);
			console.log(
				`[transcribe] Fallback audio check result for ${videoId}: hasAudio=${hasAudio}`,
			);
		}

		if (!hasAudio) {
			console.log(
				`[transcribe] No audio track detected for ${videoId} via media server`,
			);
			return null;
		}

		audioBuffer = await extractAudioViaMediaServer(videoUrl);
	} else {
		hasAudio = await checkHasAudioTrack(videoUrl);
		console.log(
			`[transcribe] Local ffmpeg audio check for ${videoId}: hasAudio=${hasAudio}`,
		);
		if (!hasAudio) {
			return null;
		}

		const result = await extractAudioFromUrl(videoUrl);

		try {
			audioBuffer = await fs.readFile(result.filePath);
		} finally {
			await result.cleanup();
		}
	}

	console.log(
		`[transcribe] Extracted audio for ${videoId}: ${audioBuffer.length} bytes`,
	);

	const audioKey = `${userId}/${videoId}/${tempAudioFilename}`;

	await bucket
		.putObject(audioKey, audioBuffer, {
			contentType: "audio/mpeg",
		})
		.pipe(runWorkflowPromise);

	const audioSignedUrl = await bucket
		.getInternalSignedObjectUrl(audioKey)
		.pipe(runWorkflowPromise);

	return audioSignedUrl;
}

async function resolveVideoSourceUrl(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	sourceKeyOverride?: string,
): Promise<string> {
	const [resolvedBucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	const candidateKeys = [
		sourceKeyOverride,
		`${userId}/${videoId}/result.mp4`,
		upload[0]?.rawFileKey,
	].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);

	for (const key of candidateKeys) {
		const url = await resolvedBucket
			.getInternalSignedObjectUrl(key)
			.pipe(runWorkflowPromise);
		const response = await fetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
		});

		if (response.ok) {
			console.log(`[transcribe] Using video source ${key}`);
			return url;
		}
	}

	throw new Error("Video file not accessible");
}

async function transcribeWithAssemblyAI(
	audioUrl: string,
	language: AiGenerationLanguage,
	videoDurationMs: number,
): Promise<TranscriptionArtifacts> {
	"use step";

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const client = new AssemblyAI({
		apiKey: serverEnv().ASSEMBLY_API_KEY as string,
	});

	const transcript = await client.transcripts.transcribe({
		audio: audioBuffer,
		...getAssemblyAITranscriptionOptions(language),
		disfluencies: true,
	});

	console.log(
		`[transcribe] AssemblyAI transcript ${transcript.id} finished with status=${transcript.status}, model=${transcript.speech_model_used ?? "unknown"}`,
	);

	if (transcript.status === "error") {
		throw new Error(
			`AssemblyAI transcription failed (id=${transcript.id}, language=${language}): ${transcript.error ?? "Unknown error"}`,
		);
	}

	// One paid pass produces both artifacts: the immutable word transcript (in
	// the original media timeline) and the caption VTT derived from those words.
	const durationMs =
		videoDurationMs > 0
			? videoDurationMs
			: (transcript.audio_duration ?? 0) * 1000;
	const editTranscript = createEditTranscript(transcript, durationMs);

	return {
		vtt: editTranscriptWordsToCaptionVtt(editTranscript.words),
		editTranscript: serializeEditTranscript(editTranscript),
	};
}

async function transcribeEditTranscriptWithAssemblyAI(
	audioUrl: string,
	videoDurationSeconds: number,
): Promise<string> {
	"use step";

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const client = new AssemblyAI({
		apiKey: serverEnv().ASSEMBLY_API_KEY as string,
	});
	const transcript = await client.transcripts.transcribe({
		audio: audioBuffer,
		...getAssemblyAITranscriptionOptions("auto"),
		disfluencies: true,
	});

	console.log(
		`[transcribe] AssemblyAI editable transcript ${transcript.id} finished with status=${transcript.status}, model=${transcript.speech_model_used ?? "unknown"}`,
	);

	if (transcript.status === "error") {
		throw new Error(
			`AssemblyAI editable transcription failed (id=${transcript.id}): ${transcript.error ?? "Unknown error"}`,
		);
	}

	const durationMs =
		videoDurationSeconds > 0
			? videoDurationSeconds * 1000
			: (transcript.audio_duration ?? 0) * 1000;
	return serializeEditTranscript(createEditTranscript(transcript, durationMs));
}

async function saveTranscription(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	transcription: TranscriptionArtifacts,
): Promise<void> {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	await bucket
		.putObject(`${userId}/${videoId}/transcription.vtt`, transcription.vtt, {
			contentType: "text/vtt",
		})
		.pipe(runWorkflowPromise);

	// The word transcript must always describe the ORIGINAL media. This pass ran
	// against whatever media is current, so it may only be persisted while the
	// video is un-edited; edited videos keep (or backfill) their own transcript.
	const [edit] = await db()
		.select({ videoId: videoEdits.videoId })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId as Video.VideoId));

	if (edit) {
		console.log(
			`[transcribe] Skipping edit transcript write for edited video ${videoId}`,
		);
	} else {
		await bucket
			.putObject(
				getEditTranscriptObjectKey(userId, videoId),
				encryptEditTranscriptObject(
					transcription.editTranscript,
					userId,
					videoId,
				),
				{ contentType: "application/octet-stream" },
			)
			.pipe(runWorkflowPromise);
	}

	await db()
		.update(videos)
		.set({ transcriptionStatus: "COMPLETE" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function saveEditTranscriptBackfill(
	videoId: string,
	userId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
	editTranscript: string,
) {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	if (!(await canPersistEditTranscriptBackfill(videoId, requestId, video)))
		return;

	await bucket
		.putObject(
			getEditTranscriptObjectKey(userId, videoId),
			encryptEditTranscriptObject(editTranscript, userId, videoId),
			{
				contentType: "application/octet-stream",
			},
		)
		.pipe(runWorkflowPromise);
	await clearEditTranscriptBackfill(videoId, requestId);
}

async function saveEditTranscriptBackfillError(
	videoId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
) {
	"use step";

	if (!(await canPersistEditTranscriptBackfill(videoId, requestId, video)))
		return;

	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill.status', 'error')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.editTranscriptBackfill.requestId')) = ${requestId}`,
			),
		);
}

async function canPersistEditTranscriptBackfill(
	videoId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
) {
	const [[currentVideo], [activeUpload]] = await Promise.all([
		db()
			.select({
				duration: videos.duration,
				metadata: videos.metadata,
				transcriptionStatus: videos.transcriptionStatus,
				updatedAt: videos.updatedAt,
			})
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId)),
		db()
			.select({ phase: videoUploads.phase })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId))
			.limit(1),
	]);

	return (
		currentVideo?.transcriptionStatus === "COMPLETE" &&
		currentVideo.duration === video.duration &&
		currentVideo.updatedAt.getTime() === video.updatedAt.getTime() &&
		getEditTranscriptBackfillStatus(currentVideo.metadata)?.requestId ===
			requestId &&
		!activeUpload
	);
}

async function clearEditTranscriptBackfill(videoId: string, requestId: string) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.editTranscriptBackfill.requestId')) = ${requestId}`,
			),
		);
}

async function cleanupTempAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	tempAudioFilename = "audio-temp.mp3",
): Promise<void> {
	"use step";

	const audioKey = `${userId}/${videoId}/${tempAudioFilename}`;

	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);

		await bucket.deleteObject(audioKey).pipe(runWorkflowPromise);
	} catch (error) {
		console.error(
			`[transcribe] Failed to cleanup temp audio file: ${audioKey}`,
			error,
		);
	}
}

async function queueAiGeneration(
	videoId: string,
	userId: string,
): Promise<void> {
	"use step";

	await startAiGeneration(videoId as Video.VideoId, userId);
}

async function _markEnhancedAudioProcessing(videoId: string): Promise<void> {
	"use step";

	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const currentMetadata = (video?.metadata as VideoMetadata) || {};

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				enhancedAudioStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function _enhanceAndSaveAudio(
	videoId: string,
	userId: string,
	audioUrl: string,
	video: typeof videos.$inferSelect,
): Promise<void> {
	"use step";

	console.log(`[transcribe] Starting audio enhancement for video ${videoId}`);

	try {
		const enhancedBuffer = await enhanceAudioFromUrl(audioUrl);
		console.log(
			`[transcribe] Audio enhanced, saving to S3 (${enhancedBuffer.length} bytes)`,
		);

		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);

		const enhancedAudioKey = `${userId}/${videoId}/enhanced-audio.${ENHANCED_AUDIO_EXTENSION}`;

		await bucket
			.putObject(enhancedAudioKey, enhancedBuffer, {
				contentType: ENHANCED_AUDIO_CONTENT_TYPE,
			})
			.pipe(runWorkflowPromise);

		const [videoRecord] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (videoRecord?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "COMPLETE",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[transcribe] Audio enhancement failed for video ${videoId}:`,
			error,
		);

		const [video] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}
