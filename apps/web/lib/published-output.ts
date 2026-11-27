export type PublishedVideo = {
	id: string;
	ownerId: string;
	source: {
		type: string;
		outputKey?: string;
		thumbnailKey?: string;
		previewKey?: string;
	};
};

const REPLACEMENT_OUTPUT =
	/^\.recording\/outputs\/(reupload|render)-[0-9a-f-]+\/result\.mp4$/;

export function getOutputPreviewAssetKeys(outputKey: string) {
	const prefix = outputKey.replace(/\.mp4$/, "");
	return {
		thumbnailKey: `${prefix}/screenshot.jpg`,
		previewKey: `${prefix}/preview.gif`,
	};
}

export function getReplacementOutputKey(video: PublishedVideo) {
	const prefix = `${video.ownerId}/${video.id}/`;
	const { type, outputKey } = video.source;
	return (type === "desktopMP4" || type === "webMP4") &&
		outputKey?.startsWith(prefix) &&
		REPLACEMENT_OUTPUT.test(outputKey.slice(prefix.length))
		? outputKey
		: null;
}

export function getReplacementAwaitingPreviewAssets(video: PublishedVideo) {
	return video.source.thumbnailKey && video.source.previewKey
		? null
		: getReplacementOutputKey(video);
}

export function awaitsReplacementPreviewGif(video: PublishedVideo) {
	return !video.source.previewKey && getReplacementOutputKey(video) !== null;
}
