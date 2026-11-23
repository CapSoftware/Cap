import { createHash } from "node:crypto";
import type { VideoMetadata } from "@cap/database/types";
import type { AiGenerationLanguage } from "@cap/web-domain";
import { MAX_WEB_EDITOR_CLIPS, validWebEditorClip } from "./editor-clips";
import {
	nextEditorRecordingSegmentIndex,
	normalizeWebEditorImportOrder,
} from "./editor-imports";

export {
	combineEditorCaptionTranscripts,
	isEditorReplacementOutput,
} from "./editor-caption-transcripts";

export type EditorCaptionSource = {
	key: string;
	mediaDurationMs: number;
	segmentDurationMs: number;
	hasAudio: boolean;
	expectedSize: number | null;
	expectedIdentity: string | null;
	transcriptKey: string;
};

export type EditorCaptionSourcePlan = {
	ownerId: string;
	videoId: string;
	language: AiGenerationLanguage;
	hash: string;
	combinedKey: string;
	sources: EditorCaptionSource[];
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDuration(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value > 0 &&
		value <= 86_400
	);
}

function segmentDurations(value: unknown) {
	if (!record(value) || !record(value.display)) return null;
	const display = value.display.duration;
	if (!validDuration(display)) return null;
	const durations = [display];
	for (const track of [value.camera, value.mic, value.system_audio]) {
		if (track === null || track === undefined) continue;
		if (!record(track) || !validDuration(track.duration)) return null;
		durations.push(track.duration);
	}
	return {
		mediaDurationMs: Math.round(display * 1000),
		segmentDurationMs: Math.round(Math.max(...durations) * 1000),
		hasAudio:
			(value.mic !== null && value.mic !== undefined) ||
			(value.system_audio !== null && value.system_audio !== undefined),
	};
}

export function buildEditorCaptionSourcePlan(
	ownerId: string,
	videoId: string,
	metadata: VideoMetadata | null,
	instance: unknown,
	language: AiGenerationLanguage = "auto",
	baseOverride?: {
		key: string;
		size: number;
		objectIdentity: string;
	},
): EditorCaptionSourcePlan | null {
	if (!record(instance) || !record(instance.recordings)) return null;
	const nativeSegments = instance.recordings.segments;
	const savedClips = metadata?.webEditorClips?.items ?? [];
	const savedAssets = metadata?.webEditorVideos?.items ?? [];
	const imports = normalizeWebEditorImportOrder(
		metadata?.webEditorImports,
		savedClips,
		savedAssets,
		ownerId,
		videoId,
	);
	if (
		(metadata?.webEditorClips && metadata.webEditorClips.version !== 1) ||
		!imports ||
		!Array.isArray(nativeSegments) ||
		!Array.isArray(savedClips) ||
		!Array.isArray(savedAssets) ||
		savedClips.length > MAX_WEB_EDITOR_CLIPS ||
		nativeSegments.length !== nextEditorRecordingSegmentIndex(imports)
	) {
		return null;
	}
	const base = baseOverride ?? metadata?.editorSources?.display;
	if (
		!baseOverride &&
		metadata?.editorSources &&
		(metadata.editorSources.version !== 1 || !base)
	) {
		return null;
	}
	const sourceInputs: Array<{
		key: string;
		hasAudio: boolean;
		expectedSize: number | null;
		expectedIdentity: string | null;
		nativeStart: number;
	}> = [
		{
			key: base?.key ?? `${ownerId}/${videoId}/result.mp4`,
			hasAudio: true,
			expectedSize: base?.size ?? null,
			expectedIdentity: base?.objectIdentity ?? null,
			nativeStart: 0,
		},
	];
	let nativeStart = 1;
	for (const item of imports.items) {
		const asset = savedAssets.find((candidate) => candidate.path === item.path);
		if (!asset) return null;
		if (item.kind === "clip") {
			const clip = savedClips.find(
				(candidate) => candidate.displayPath === item.path,
			);
			if (!clip || !validWebEditorClip(clip, savedAssets, ownerId, videoId))
				return null;
			sourceInputs.push({
				key: asset.key,
				hasAudio: clip.hasAudio,
				expectedSize: asset.size,
				expectedIdentity: asset.objectIdentity,
				nativeStart,
			});
			nativeStart++;
		} else {
			return null;
		}
	}
	const sources: EditorCaptionSource[] = [];
	for (const input of sourceInputs) {
		const measured = segmentDurations(nativeSegments[input.nativeStart]);
		if (!measured) return null;
		const { mediaDurationMs, segmentDurationMs } = measured;
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify([
					input.key,
					input.expectedSize,
					input.expectedIdentity,
					input.hasAudio,
					mediaDurationMs,
					segmentDurationMs,
					null,
					...(language === "auto" ? [] : [language]),
				]),
			)
			.digest("hex");
		sources.push({
			key: input.key,
			hasAudio: input.hasAudio,
			expectedSize: input.expectedSize,
			expectedIdentity: input.expectedIdentity,
			mediaDurationMs,
			segmentDurationMs,
			transcriptKey: `${ownerId}/${videoId}/editor-captions/source-${fingerprint}.edit.v3.json`,
		});
	}
	const hash = createHash("sha256")
		.update(JSON.stringify(sources.map((source) => source.transcriptKey)))
		.digest("hex");
	return {
		ownerId,
		videoId,
		language,
		hash,
		combinedKey: `${ownerId}/${videoId}/editor-captions/combined-${hash}.edit.v3.json`,
		sources,
	};
}
