import type { VideoMetadata } from "@cap/database/types";
import { isEditorReplacementOutput } from "./editor-caption-transcripts";

type DurationVideo = {
	id: string;
	ownerId: string;
	source: { type: string; outputKey?: string };
	duration: number | null;
	metadata: VideoMetadata | null;
};

export function validEditorSourceDuration(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value > 0 &&
		value <= 86_400
	);
}

// The published duration is the recording's own only until a Save replaces
// the output with an edited render.
export function knownEditorSourceDuration(video: DurationVideo) {
	const stored = video.metadata?.editorSourceDuration;
	if (validEditorSourceDuration(stored)) return stored;
	return !isEditorReplacementOutput(video) &&
		validEditorSourceDuration(video.duration)
		? video.duration
		: null;
}
