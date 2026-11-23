import type { VideoMetadata } from "@cap/database/types";
import type { EditTranscript } from "./edit-transcript";
import type { EditorCaptionSourcePlan } from "./editor-caption-sources";
import { getReplacementOutputKey } from "./published-output";

// Saves publish an edited render whose timing no longer matches the source.
// A farm render of the untouched recording keeps it.
export function isEditorReplacementOutput(video: {
	id: string;
	ownerId: string;
	source: { type: string; outputKey?: string };
	metadata?: Pick<VideoMetadata, "renderFarmSave"> | null;
}) {
	const key = getReplacementOutputKey(video);
	if (!key) return false;
	const render = video.metadata?.renderFarmSave;
	return !(
		render?.trigger === "recording" &&
		render.status === "published" &&
		render.outputKey === key
	);
}

export function combineEditorCaptionTranscripts(
	plan: EditorCaptionSourcePlan,
	transcripts: readonly (EditTranscript | null)[],
): EditTranscript | null {
	if (transcripts.length !== plan.sources.length) return null;
	const words: EditTranscript["words"] = [];
	let offsetMs = 0;
	let languageCode: string | null = null;
	let speechModelUsed = "unknown";
	for (const [index, source] of plan.sources.entries()) {
		const transcript = transcripts[index];
		if (transcript) {
			if (Math.abs(transcript.durationMs - source.mediaDurationMs) > 2000) {
				return null;
			}
			languageCode ??= transcript.languageCode;
			if (speechModelUsed === "unknown") {
				speechModelUsed = transcript.speechModelUsed;
			}
			for (const word of transcript.words) {
				words.push({
					...word,
					id: `segment-${index}-${word.id}`,
					startMs: word.startMs + offsetMs,
					endMs: word.endMs + offsetMs,
				});
			}
		}
		offsetMs += source.segmentDurationMs;
	}
	words.sort(
		(left, right) => left.startMs - right.startMs || left.endMs - right.endMs,
	);
	return {
		version: 3,
		speechModelUsed,
		durationMs: offsetMs,
		languageCode,
		words,
	};
}
