import { randomUUID } from "node:crypto";
import type { VideoMetadata } from "@cap/database/types";
import {
	CAP_BUNDLE_CONTENT_TYPE,
	MAX_CAP_BUNDLE_BYTES,
} from "@cap/editor-cap-bundle";

export const MAX_EDITOR_VIDEO_BYTES = MAX_CAP_BUNDLE_BYTES;
export const MAX_EDITOR_VIDEO_COUNT = 100;
export const EDITOR_VIDEO_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const PART_MIN_BYTES = 5 * 1024 * 1024;
const VIDEO_PATH =
	/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|avi|mkv|webm|wmv|m4v|flv)$/;
const CAP_BUNDLE_PATH =
	/^content\/imports\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.capbundle$/;
const VIDEO_TYPES: Record<string, string> = {
	capbundle: CAP_BUNDLE_CONTENT_TYPE,
	mp4: "video/mp4",
	mov: "video/quicktime",
	avi: "video/x-msvideo",
	mkv: "video/x-matroska",
	webm: "video/webm",
	wmv: "video/x-ms-wmv",
	m4v: "video/mp4",
	flv: "video/x-flv",
};

function assetExtension(path: string) {
	const video = VIDEO_PATH.exec(path);
	if (video) return video[1] ?? null;
	return CAP_BUNDLE_PATH.test(path) ? "capbundle" : null;
}

function assetKey(ownerId: string, videoId: string, path: string) {
	if (CAP_BUNDLE_PATH.test(path)) {
		return `${ownerId}/${videoId}/editor-assets/recordings/${path.slice("content/imports/".length)}`;
	}
	return `${ownerId}/${videoId}/editor-assets/videos/${path.slice("content/videos/".length)}`;
}

type EditorVideoUpload = NonNullable<VideoMetadata["webEditorVideoUpload"]>;
export type EditorVideoPart = {
	partNumber: number;
	etag: string;
	size: number;
};

export function editorVideoExtension(
	fileName: string,
	size: number,
	contentType: string,
) {
	if (
		fileName.length < 1 ||
		fileName.length > 100 ||
		fileName.split("").some((character) => {
			const code = character.charCodeAt(0);
			return (
				code < 32 || code === 127 || character === "/" || character === "\\"
			);
		}) ||
		!Number.isSafeInteger(size) ||
		size < 1 ||
		size > MAX_EDITOR_VIDEO_BYTES
	) {
		return null;
	}
	const match = /^(.+)\.([a-z0-9]+)$/i.exec(fileName);
	const extension = match?.[2]?.toLowerCase() ?? "";
	return match?.[1]?.trim() && VIDEO_TYPES[extension] === contentType
		? extension
		: null;
}

export function createEditorVideoLocation(
	ownerId: string,
	videoId: string,
	extension: string,
) {
	if (!VIDEO_TYPES[extension])
		throw new Error("Invalid editor video extension");
	const path =
		extension === "capbundle"
			? `content/imports/${randomUUID()}.capbundle`
			: `content/videos/${randomUUID()}.${extension}`;
	return {
		path,
		key: assetKey(ownerId, videoId, path),
	};
}

export function validEditorVideoAsset(
	asset: unknown,
	ownerId: string,
	videoId: string,
) {
	if (typeof asset !== "object" || asset === null) return false;
	if (!("path" in asset) || typeof asset.path !== "string") return false;
	const extension = assetExtension(asset.path);
	if (!extension) return false;
	const expectedKey = assetKey(ownerId, videoId, asset.path);
	return (
		"key" in asset &&
		asset.key === expectedKey &&
		"contentType" in asset &&
		asset.contentType === VIDEO_TYPES[extension] &&
		"size" in asset &&
		typeof asset.size === "number" &&
		Number.isSafeInteger(asset.size) &&
		asset.size >= 1 &&
		asset.size <= MAX_EDITOR_VIDEO_BYTES &&
		"name" in asset &&
		typeof asset.name === "string" &&
		asset.name.length >= 1 &&
		asset.name.length <= 100 &&
		!asset.name.split("").some((character) => {
			const code = character.charCodeAt(0);
			return (
				code < 32 || code === 127 || character === "/" || character === "\\"
			);
		}) &&
		"objectIdentity" in asset &&
		(asset.objectIdentity === null ||
			(typeof asset.objectIdentity === "string" &&
				asset.objectIdentity.length >= 1 &&
				asset.objectIdentity.length <= 256))
	);
}

export function editorVideoUploadMatches(
	pending: EditorVideoUpload | undefined,
	input: {
		videoId: string;
		ownerId: string;
		sessionId: string;
		uploadId: string;
		path: string;
		key: string;
		bucketId: string | null;
		storageIntegrationId: string | null;
	},
	allowExpired = false,
) {
	if (!pending || pending.version !== 1) return false;
	const extension = assetExtension(pending.path);
	if (!extension) return false;
	return (
		pending.sessionId === input.sessionId &&
		pending.uploadId === input.uploadId &&
		pending.path === input.path &&
		pending.key === input.key &&
		pending.key === assetKey(input.ownerId, input.videoId, pending.path) &&
		pending.contentType === VIDEO_TYPES[extension] &&
		editorVideoExtension(
			pending.fileName,
			pending.size,
			pending.contentType,
		) === extension &&
		pending.bucketId === input.bucketId &&
		pending.storageIntegrationId === input.storageIntegrationId &&
		(pending.provider === "s3" || pending.provider === "googleDrive") &&
		Number.isFinite(Date.parse(pending.expiresAt)) &&
		(allowExpired || Date.parse(pending.expiresAt) > Date.now())
	);
}

export function validateEditorVideoParts(
	parts: readonly EditorVideoPart[],
	expectedBytes: number,
) {
	if (
		!Number.isSafeInteger(expectedBytes) ||
		expectedBytes < 1 ||
		expectedBytes > MAX_EDITOR_VIDEO_BYTES ||
		parts.length < 1 ||
		parts.length > 10_000
	) {
		return false;
	}
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (
			!part ||
			part.partNumber !== index + 1 ||
			!Number.isSafeInteger(part.size) ||
			part.size < 1 ||
			(index < parts.length - 1 && part.size < PART_MIN_BYTES) ||
			part.size > 5 * 1024 * 1024 * 1024 ||
			!/^[A-Za-z0-9"_-]{1,256}$/.test(part.etag)
		) {
			return false;
		}
		total += part.size;
		if (!Number.isSafeInteger(total) || total > expectedBytes) return false;
	}
	return total === expectedBytes;
}
