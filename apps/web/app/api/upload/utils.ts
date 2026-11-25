import { getStorageKeyExtension } from "@/lib/media-processing-policy";

const SIGNED_UPLOAD_EXTENSIONS = new Set([
	"aac",
	"jpeg",
	"jpg",
	"json",
	"m3u8",
	"m4s",
	"mp3",
	"mp4",
	"png",
	"ts",
	"webm",
]);

export function hasDotSegment(key: string) {
	return key.split("/").some((part) => part === "." || part === "..");
}

export function isSignedUploadKey(key: string) {
	if (hasDotSegment(key)) return false;
	const extension = getStorageKeyExtension(key);
	return extension !== null && SIGNED_UPLOAD_EXTENSIONS.has(extension);
}

export function parseVideoIdOrFileKey(
	userId: string,
	input:
		| { videoId: string; subpath: string }
		| {
				// deprecated
				fileKey: string;
		  },
) {
	let videoId: string;
	let subpath: string;

	if ("fileKey" in input) {
		const [_, _videoId, ...subpathParts] = input.fileKey.split("/");
		if (!_videoId) throw new Error("Invalid fileKey");
		videoId = _videoId;
		subpath = subpathParts.join("/");
	} else {
		videoId = input.videoId;
		subpath = input.subpath;
	}

	return `${userId}/${videoId}/${subpath}`;
}
