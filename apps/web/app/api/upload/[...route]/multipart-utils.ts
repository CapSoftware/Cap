import { isInternalRecordingKey } from "@cap/web-backend/src/Storage/recording-output";
import { parseVideoIdOrFileKey } from "../utils";

export class MultipartFileKeyError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403,
	) {
		super(message);
	}
}

function assertWritableFileKey(key: string) {
	if (key.split("/").some((part) => part === ".." || part === ".")) {
		throw new MultipartFileKeyError("Invalid file path", 400);
	}
	if (isInternalRecordingKey(key)) {
		throw new MultipartFileKeyError("Recording snapshots are immutable", 403);
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
		const [, videoId] = input.fileKey.split("/");
		if (!videoId) throw new MultipartFileKeyError("Invalid fileKey", 400);
		return assertWritableFileKey(
			parseVideoIdOrFileKey(userId, { fileKey: input.fileKey }),
		);
	}

	if (!("videoId" in input) || !input.videoId) {
		throw new MultipartFileKeyError("Video id not found", 400);
	}

	return assertWritableFileKey(
		parseVideoIdOrFileKey(userId, {
			videoId: input.videoId,
			subpath: input.subpath ?? "result.mp4",
		}),
	);
};

export const resolveMultipartFileKey = (
	userId: string,
	input: Parameters<typeof getMultipartFileKey>[1],
):
	| { fileKey: string }
	| { error: string; status: MultipartFileKeyError["status"] } => {
	try {
		return { fileKey: getMultipartFileKey(userId, input) };
	} catch (error) {
		if (error instanceof MultipartFileKeyError) {
			return { error: error.message, status: error.status };
		}
		throw error;
	}
};

export const isRawRecorderUpload = (subpath: string) =>
	subpath.startsWith("raw-upload.");
