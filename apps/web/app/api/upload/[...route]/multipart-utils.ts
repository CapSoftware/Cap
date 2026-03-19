import { parseVideoIdOrFileKey } from "../utils";

export const getSubpath = (input: { subpath?: string; fileKey?: string }) => {
	if ("fileKey" in input) {
		return undefined;
	}

	return input.subpath ?? "result.mp4";
};

export const getMultipartFileKey = (
	userId: string,
	input:
		| { videoId?: string; subpath?: string }
		| {
				fileKey?: string;
		  },
) => {
	if ("fileKey" in input && input.fileKey) {
		return parseVideoIdOrFileKey(userId, { fileKey: input.fileKey });
	}

	if (!("videoId" in input) || !input.videoId) {
		throw new Error("Video id not found");
	}

	return parseVideoIdOrFileKey(userId, {
		videoId: input.videoId,
		subpath: input.subpath ?? "result.mp4",
	});
};

export const isRawRecorderUpload = (subpath: string) =>
	subpath.startsWith("raw-upload.");
