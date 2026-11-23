import type { EditTranscript } from "./edit-transcript";
import type { EditorCaptionSourcePlan } from "./editor-caption-sources";

export function isEditorReplacementOutput(video: {
	id: string;
	ownerId: string;
	source: { type: string; outputKey?: string };
}) {
	if (video.source.type !== "desktopMP4" && video.source.type !== "webMP4") {
		return false;
	}
	const key = video.source.outputKey;
	const prefix = `${video.ownerId}/${video.id}/.recording/outputs/reupload-`;
	return (
		typeof key === "string" &&
		key.startsWith(prefix) &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/result\.mp4$/.test(
			key.slice(prefix.length),
		)
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
