import { isInternalRecordingKey } from "@cap/web-backend/src/Storage/recording-output";
import { parseVideoIdOrFileKey } from "../utils";

function assertWritableFileKey(key: string) {
	if (isInternalRecordingKey(key)) {
		throw new Error("Recording snapshots are immutable");
	}
	return key;
}

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
		return assertWritableFileKey(
			parseVideoIdOrFileKey(userId, { fileKey: input.fileKey }),
		);
	}

	if (!("videoId" in input) || !input.videoId) {
		throw new Error("Video id not found");
	}

	return assertWritableFileKey(
		parseVideoIdOrFileKey(userId, {
			videoId: input.videoId,
			subpath: input.subpath ?? "result.mp4",
		}),
	);
};

export const isRawRecorderUpload = (subpath: string) =>
	subpath.startsWith("raw-upload.");

export const isDisplayRecorderUpload = (subpath: string) =>
	/^raw-upload\.(webm|mp4)$/.test(subpath);

export const isCameraRecorderUpload = (subpath: string) =>
	/^camera-upload\.(webm|mp4)$/.test(subpath);

export const getAudioRecorderUploadKind = (
	subpath: string,
): "mic" | "systemAudio" | null => {
	const match = /^(mic|system-audio)-upload\.(webm|mp4)$/.exec(subpath);
	if (match?.[1] === "mic") return "mic";
	if (match?.[1] === "system-audio") return "systemAudio";
	return null;
};
