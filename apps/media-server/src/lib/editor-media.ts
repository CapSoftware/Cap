import { execFile } from "node:child_process";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fetchMedia } from "./media-transfer";

const MAX_SOURCE_BYTES = 12 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const runFile = promisify(execFile);

export type EditorMediaSource = {
	url: string;
	contentType: "video/webm" | "video/mp4" | "audio/webm" | "audio/mp4";
	size: number;
	objectIdentity?: string | null;
};

function validateSource(source: EditorMediaSource) {
	const url = new URL(source.url);
	if (
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA === "1"
			)) ||
		url.username ||
		url.password ||
		!(["video/webm", "video/mp4", "audio/webm", "audio/mp4"] as const).some(
			(type) => type === source.contentType,
		) ||
		!Number.isSafeInteger(source.size) ||
		source.size < 1 ||
		source.size > MAX_SOURCE_BYTES
	) {
		throw new Error("Invalid editor media source");
	}
	if (
		source.objectIdentity != null &&
		(source.objectIdentity.length < 1 || source.objectIdentity.length > 256)
	) {
		throw new Error("Invalid editor object identity");
	}
}

export async function downloadEditorMedia(
	source: EditorMediaSource,
	abortSignal?: AbortSignal,
) {
	validateSource(source);
	const root = await mkdtemp(join(tmpdir(), "cap-editor-source-"));
	await chmod(root, 0o700);
	const extension = source.contentType.endsWith("/mp4") ? ".mp4" : ".webm";
	const path = join(root, `source${extension}`);
	const cleanup = () => rm(root, { recursive: true, force: true });
	const handle = await open(path, "wx", 0o600);
	let closed = false;
	try {
		const response = await fetchMedia(source.url, {
			headers: source.objectIdentity
				? { "If-Match": source.objectIdentity }
				: undefined,
			signal: abortSignal
				? AbortSignal.any([
						abortSignal,
						AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
					])
				: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!response.ok || !response.body) {
			throw new Error(`Editor source download failed: ${response.status}`);
		}
		const responseSize = response.headers.get("content-length");
		if (
			responseSize != null &&
			(!Number.isSafeInteger(Number(responseSize)) ||
				Number(responseSize) !== source.size)
		) {
			throw new Error("Editor source size changed before download");
		}
		const responseIdentity = response.headers.get("etag");
		if (
			source.objectIdentity &&
			responseIdentity &&
			responseIdentity !== source.objectIdentity
		) {
			throw new Error("Editor source identity changed before download");
		}
		let received = 0;
		const reader = response.body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > source.size) {
					throw new Error("Editor source exceeded expected size");
				}
				await handle.writeFile(value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		if (received !== source.size) {
			throw new Error("Editor source download was incomplete");
		}
		await handle.sync();
		await handle.close();
		closed = true;
		return { path, size: received, cleanup };
	} catch (error) {
		if (!closed) await handle.close();
		await cleanup();
		throw error;
	}
}

function parseFrameRate(value: unknown) {
	if (typeof value !== "string") return null;
	const parts = value.split("/");
	if (parts.length !== 2) return null;
	const numerator = Number(parts[0]);
	const denominator = Number(parts[1]);
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
		return null;
	}
	const rate = Math.round(numerator / denominator);
	return rate >= 1 && rate <= 120 ? rate : null;
}

export async function inspectEditorDisplayMedia(
	path: string,
	reportedFps?: number,
) {
	const { stdout } = await runFile(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"stream=codec_type,avg_frame_rate,r_frame_rate:format=duration",
			"-of",
			"json",
			path,
		],
		{ timeout: 30_000, maxBuffer: 64 * 1024 },
	);
	const data = JSON.parse(stdout) as {
		format?: { duration?: string };
		streams?: Array<{
			codec_type?: string;
			avg_frame_rate?: unknown;
			r_frame_rate?: unknown;
		}>;
	};
	const video = data.streams?.find((stream) => stream.codec_type === "video");
	if (!video) throw new Error("Editor source has no video stream");
	const fps =
		(Number.isInteger(reportedFps) &&
		reportedFps !== undefined &&
		reportedFps >= 1 &&
		reportedFps <= 120
			? reportedFps
			: null) ??
		parseFrameRate(video.avg_frame_rate) ??
		parseFrameRate(video.r_frame_rate);
	if (!fps) throw new Error("Editor source frame rate is unavailable");
	return {
		fps,
		duration: Number(data.format?.duration),
		hasAudio:
			data.streams?.some((stream) => stream.codec_type === "audio") ?? false,
	};
}

export async function resolveEditorFps(path: string, reported?: number) {
	if (
		Number.isInteger(reported) &&
		reported !== undefined &&
		reported > 0 &&
		reported <= 120
	) {
		return reported;
	}
	const { stdout } = await runFile(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=avg_frame_rate,r_frame_rate",
			"-of",
			"json",
			path,
		],
		{ timeout: 30_000, maxBuffer: 64 * 1024 },
	);
	const data = JSON.parse(stdout) as {
		streams?: Array<{ avg_frame_rate?: unknown; r_frame_rate?: unknown }>;
	};
	const stream = data.streams?.[0];
	const fps =
		parseFrameRate(stream?.avg_frame_rate) ??
		parseFrameRate(stream?.r_frame_rate);
	if (!fps) throw new Error("Editor source frame rate is unavailable");
	return fps;
}
