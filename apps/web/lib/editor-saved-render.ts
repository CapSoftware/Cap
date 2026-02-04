import type { VideoMetadata } from "@cap/database/types";

export type EditorSavedRenderStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR";

export type EditorSavedRenderState = {
	status: EditorSavedRenderStatus;
	sourceKey: string;
	outputKey: string | null;
	progress: number;
	message: string | null;
	error: string | null;
	requestedAt: string;
	updatedAt: string;
};

export function getEditorSavedRenderState(
	metadata: VideoMetadata | null | undefined,
): EditorSavedRenderState | null {
	if (!metadata?.editorSavedRender) {
		return null;
	}

	return metadata.editorSavedRender;
}

export function createEditorSavedRenderState(input: {
	status: EditorSavedRenderStatus;
	sourceKey: string;
	outputKey?: string | null;
	progress?: number;
	message?: string | null;
	error?: string | null;
	requestedAt?: string;
	updatedAt?: string;
}): EditorSavedRenderState {
	const nowIso = new Date().toISOString();
	return {
		status: input.status,
		sourceKey: input.sourceKey,
		outputKey: input.outputKey ?? null,
		progress: input.progress ?? 0,
		message: input.message ?? null,
		error: input.error ?? null,
		requestedAt: input.requestedAt ?? nowIso,
		updatedAt: input.updatedAt ?? nowIso,
	};
}

export function getOriginalVideoKey(videoId: string, ownerId: string): string {
	return `${ownerId}/${videoId}/result.mp4`;
}

export function getSavedRenderOutputKey(
	videoId: string,
	ownerId: string,
): string {
	return `${ownerId}/${videoId}/editor/saved.mp4`;
}
