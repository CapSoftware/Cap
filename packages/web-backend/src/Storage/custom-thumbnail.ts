export const CUSTOM_THUMBNAIL_DIRECTORY = "thumbnail";

const CUSTOM_THUMBNAIL_FILE_PATTERN = /^custom-[0-9a-z]{1,32}\.jpg$/;

export type CustomThumbnailMetadata = {
	file: string;
	source: "upload" | "frame";
	time?: number;
	updatedAt: string;
};

type CustomThumbnailVideo = {
	id: string;
	ownerId: string;
	metadata: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCustomThumbnailFileName(file: unknown): file is string {
	return typeof file === "string" && CUSTOM_THUMBNAIL_FILE_PATTERN.test(file);
}

export function getCustomThumbnailMetadata(
	metadata: unknown,
): CustomThumbnailMetadata | null {
	if (!isRecord(metadata)) return null;
	const value = metadata.customThumbnail;
	if (!isRecord(value) || !isCustomThumbnailFileName(value.file)) return null;
	return {
		file: value.file,
		source: value.source === "frame" ? "frame" : "upload",
		...(typeof value.time === "number" && Number.isFinite(value.time)
			? { time: value.time }
			: {}),
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
	};
}

/**
 * The thumbnail the owner picked, stored under the video's own prefix so
 * deleting or duplicating the video carries it along like every other object.
 * The metadata only holds the file name, never a full key.
 */
export function customThumbnailKey(video: {
	id: string;
	ownerId: string;
	file: string;
}) {
	return `${video.ownerId}/${video.id}/${CUSTOM_THUMBNAIL_DIRECTORY}/${video.file}`;
}

export function getCustomThumbnailKey(video: CustomThumbnailVideo) {
	const custom = getCustomThumbnailMetadata(video.metadata);
	if (!custom) return undefined;
	return customThumbnailKey({
		id: video.id,
		ownerId: video.ownerId,
		file: custom.file,
	});
}

export function getCustomThumbnailVersion(metadata: unknown) {
	const custom = getCustomThumbnailMetadata(metadata);
	return custom ? custom.file.slice("custom-".length, -".jpg".length) : null;
}
