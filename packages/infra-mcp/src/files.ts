import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { LocalError } from "./errors";

export type LocalFile = {
	path: string;
	size: number;
	fileName: string;
	title: string;
	contentType: string;
};

export const CONTENT_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".avi": "video/avi",
};

const GIGABYTE = 1e9;

export async function inspectFile(
	rawPath: string,
	limit: { maxBytes: number; what: string },
): Promise<LocalFile> {
	const path =
		rawPath === "~" || rawPath.startsWith("~/")
			? join(homedir(), rawPath.slice(1))
			: rawPath;
	if (!isAbsolute(path)) {
		throw new LocalError(
			"path_not_absolute",
			"The path must be absolute",
			"Send the full path of the file, such as /Users/me/video.mp4.",
		);
	}
	const info = await stat(path).catch(() => null);
	if (!info) {
		throw new LocalError(
			"file_not_found",
			"No file exists at that path, or it cannot be read",
			"Check the path and that this server runs on the machine that holds the file.",
		);
	}
	if (!info.isFile()) {
		throw new LocalError("not_a_file", "The path is not a file", null);
	}
	if (info.size === 0) {
		throw new LocalError("file_empty", "The file is empty", null);
	}
	if (info.size > limit.maxBytes) {
		throw new LocalError(
			"file_too_large",
			`The file is larger than the ${Math.round(limit.maxBytes / GIGABYTE)} GB limit for ${limit.what}`,
			"Export it at a lower bitrate or split it, then try again.",
		);
	}
	const fileName = basename(path);
	const extension = extname(fileName);
	const stem = fileName.slice(0, fileName.length - extension.length);
	return {
		path,
		size: info.size,
		fileName,
		title: (stem || fileName).slice(0, 255),
		contentType:
			CONTENT_TYPES[extension.toLowerCase()] ?? "application/octet-stream",
	};
}

const MIN_BYTES_PER_SECOND = 32_000;
const MAX_STORAGE_TIMEOUT_MS = 60 * 60 * 1000;

export const storageTimeoutMs = (bytes: number) =>
	Math.min(
		MAX_STORAGE_TIMEOUT_MS,
		60_000 + Math.ceil((bytes / MIN_BYTES_PER_SECOND) * 1000),
	);
