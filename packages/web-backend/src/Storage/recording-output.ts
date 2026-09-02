import { Video } from "@cap/web-domain";

type RecordingVideo = {
	id: string;
	ownerId: string;
	source: {
		type: string;
		outputKey?: string;
		thumbnailKey?: string;
		previewKey?: string;
	};
};

export function isInternalRecordingKey(key: string) {
	return key.split("/")[2] === ".recording";
}

export function getPublishedRecordingOutputKey(video: RecordingVideo) {
	return video.source.type === "desktopMP4"
		? Video.getRetainedRecordingOutputKey(
				video.ownerId,
				video.id,
				video.source.outputKey,
			)
		: undefined;
}

export function resolveRecordingObjectKey(video: RecordingVideo, key: string) {
	const prefix = `${video.ownerId}/${video.id}/`;
	const asset =
		key === `${prefix}screenshot/screen-capture.jpg`
			? video.source.thumbnailKey
			: key === `${prefix}preview/animated-preview.gif`
				? video.source.previewKey
				: undefined;
	if (
		video.source.type === "desktopMP4" &&
		asset?.startsWith(`${prefix}.recording/outputs/`) &&
		!asset.includes("..") &&
		/^[a-zA-Z0-9_./-]+$/.test(asset)
	) {
		return asset;
	}
	return key === `${video.ownerId}/${video.id}/result.mp4`
		? (getPublishedRecordingOutputKey(video) ?? key)
		: key;
}

export function getPublishedRecordingCopyKeys(video: RecordingVideo) {
	if (!getPublishedRecordingOutputKey(video)) return [];
	const prefix = `${video.ownerId}/${video.id}/`;
	return [
		`${prefix}result.mp4`,
		...["screenshot/screen-capture.jpg", "preview/animated-preview.gif"]
			.map((suffix) => `${prefix}${suffix}`)
			.filter((key) => resolveRecordingObjectKey(video, key) !== key),
	];
}
