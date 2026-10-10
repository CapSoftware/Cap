type MediaFileLike = Pick<File, "name" | "type">;

export const isSupportedVideoFile = (file: MediaFileLike) =>
	file.type.startsWith("video/") ||
	/\.(mov|mp4|avi|mkv|webm|m4v)$/i.test(file.name);

export const getSupportedImageContentType = (file: MediaFileLike) => {
	if (file.type === "image/png") return "image/png";
	if (file.type === "image/jpeg") return "image/jpeg";
	if (/\.png$/i.test(file.name)) return "image/png";
	if (/\.jpe?g$/i.test(file.name)) return "image/jpeg";
	return null;
};

export const isSupportedMediaFile = (file: MediaFileLike) =>
	getSupportedImageContentType(file) !== null || isSupportedVideoFile(file);

export const isSupportedAudioFile = (file: MediaFileLike) =>
	file.type.startsWith("audio/") ||
	/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i.test(file.name);

/** What the Editor can start a new project from: a video or an audio file. */
export const isSupportedEditorFile = (file: MediaFileLike) =>
	isSupportedVideoFile(file) || isSupportedAudioFile(file);
