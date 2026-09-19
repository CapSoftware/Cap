import { runEditorFile as runFile } from "./editor-process";
import {
	type SignedEditorAsset,
	stageSignedEditorAsset,
} from "./editor-signed-assets";

const MAX_VIDEO_BYTES = 12 * 1024 * 1024 * 1024;
const MAX_VIDEO_PIXELS = 33_554_432;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const assetPath =
	/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|avi|mkv|webm|wmv|m4v|flv)$/;
const contentTypes: Record<string, string> = {
	mp4: "video/mp4",
	mov: "video/quicktime",
	avi: "video/x-msvideo",
	mkv: "video/x-matroska",
	webm: "video/webm",
	wmv: "video/x-ms-wmv",
	m4v: "video/mp4",
	flv: "video/x-flv",
};

export type EditorVideoAsset = SignedEditorAsset;

export function validateEditorVideoAsset(asset: EditorVideoAsset) {
	const match = assetPath.exec(asset.path);
	const url = new URL(asset.url);
	if (
		!match ||
		contentTypes[match[1] ?? ""] !== asset.contentType ||
		asset.name.length < 1 ||
		asset.name.length > 100 ||
		asset.name.split("").some((character) => {
			const code = character.charCodeAt(0);
			return (
				code < 32 || code === 127 || character === "/" || character === "\\"
			);
		}) ||
		!Number.isSafeInteger(asset.size) ||
		asset.size < 1 ||
		asset.size > MAX_VIDEO_BYTES ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA === "1"
			)) ||
		url.username ||
		url.password ||
		(asset.objectIdentity != null &&
			(asset.objectIdentity.length < 1 || asset.objectIdentity.length > 256))
	) {
		throw new Error("Invalid editor video asset");
	}
}

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function videoFrameRate(value: unknown) {
	if (typeof value !== "string") return 30;
	const [numerator, denominator] = value.split("/").map(Number);
	const rate = numerator / denominator;
	return Number.isFinite(rate) && rate >= 1 && rate <= 240
		? Math.round(rate)
		: 30;
}

export async function probeVideo(path: string) {
	const { stdout } = await runFile(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"stream=codec_type,width,height,avg_frame_rate,duration:format=duration",
			"-of",
			"json",
			path,
		],
		{ timeout: 30_000, maxBuffer: 64 * 1024 },
	).catch(() => {
		throw new Error("Imported file has no decodable video");
	});
	const data: unknown = JSON.parse(stdout);
	if (!asRecord(data) || !Array.isArray(data.streams)) {
		throw new Error("Imported file has no video track");
	}
	const video = data.streams.find(
		(stream: unknown) => asRecord(stream) && stream.codec_type === "video",
	);
	if (!asRecord(video)) throw new Error("Imported file has no video track");
	const width = Number(video.width);
	const height = Number(video.height);
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 1 ||
		height < 1 ||
		width > 16_384 ||
		height > 16_384 ||
		width * height > MAX_VIDEO_PIXELS
	) {
		throw new Error("Imported video dimensions are too large");
	}
	const duration = Number(
		asRecord(data.format) && data.format.duration
			? data.format.duration
			: video.duration,
	);
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error("Cannot determine imported video duration");
	}
	return {
		duration,
		fps: videoFrameRate(video.avg_frame_rate),
		width,
		height,
		hasAudio: data.streams.some(
			(stream: unknown) => asRecord(stream) && stream.codec_type === "audio",
		),
	};
}

export async function stageSignedEditorVideoAsset(
	projectPath: string,
	asset: EditorVideoAsset,
	abortSignal?: AbortSignal,
) {
	validateEditorVideoAsset(asset);
	return stageSignedEditorAsset(
		projectPath,
		asset,
		probeVideo,
		abortSignal,
		VIDEO_DOWNLOAD_TIMEOUT_MS,
	);
}
