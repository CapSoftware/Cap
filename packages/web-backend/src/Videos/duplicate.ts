import {
	getPublishedRecordingCopyKeys,
	isInternalRecordingKey,
} from "../Storage/recording-output.ts";

type DuplicatedVideo = Parameters<typeof getPublishedRecordingCopyKeys>[0];

export function planVideoDuplicate<V extends DuplicatedVideo>(video: V) {
	const prefix = `${video.ownerId}/${video.id}/`;
	const publishedKeys = getPublishedRecordingCopyKeys(video);
	const published = publishedKeys.length > 0;
	const source: V["source"] | { type: "webMP4" | "desktopMP4" } = published
		? { type: video.source.type === "webMP4" ? "webMP4" : "desktopMP4" }
		: video.source;
	return {
		publishedKeys,
		copiesListedKey: (key: string) =>
			!key.includes("/comments/") &&
			!isInternalRecordingKey(key) &&
			!publishedKeys.includes(key) &&
			!(published && key.startsWith(`${prefix}segments/`)),
		source,
	};
}

export function getDuplicateVideoMetadata<M extends Record<string, unknown>>(
	metadata: M,
): M {
	const copied = { ...metadata };
	delete copied.desktopRecordingUpload;
	delete copied.customCreatedAt;
	return copied;
}
