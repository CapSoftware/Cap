import {
	InstantRecordingUploader,
	MultipartCompletionUncertainError,
} from "@cap/recorder-core";
import type { Video } from "@cap/web-domain";

const MAX_VIDEO_BYTES = 12 * 1024 * 1024 * 1024;
const MAX_VIDEO_PIXELS = 33_554_432;
const VIDEO_PATH =
	/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm)$/;
const VIDEO_TYPES: Record<string, string> = {
	mp4: "video/mp4",
	webm: "video/webm",
};

export const CAP_BUNDLE_UNSUPPORTED =
	"Cap recording imports aren't available on the web yet. Import an MP4 instead.";

export type WebEditorImportedVideo = {
	path: string;
	name: string;
	duration: number;
	fps: number;
	width: number;
	height: number;
	hasAudio: boolean;
};

export type WebEditorVideoImportProgress = {
	stage: "uploading" | "staging" | "ready";
	fraction: number;
};

export type WebEditorVideoProbe = Omit<WebEditorImportedVideo, "path" | "name">;

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCapBundleFile(file: Pick<File, "name">) {
	return /\.capbundle$/i.test(file.name);
}

function videoExtension(file: Pick<File, "name" | "type">) {
	const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
	if (extension && VIDEO_TYPES[extension]) return extension;
	if (file.type === "video/mp4") return "mp4";
	if (file.type === "video/webm") return "webm";
	return null;
}

export function uploadFileName(name: string, extension: string) {
	const stemSource = name.replace(/\.[^.]*$/, "");
	const limit = 99 - extension.length;
	let stem = "";
	for (const character of stemSource) {
		if (stem.length + character.length > limit) break;
		const code = character.charCodeAt(0);
		stem +=
			code < 32 || code === 127 || character === "/" || character === "\\"
				? " "
				: character;
	}
	return `${stem.trim() || "Video"}.${extension}`;
}

export function validVideoProbe(
	probe: WebEditorVideoProbe,
): WebEditorVideoProbe | null {
	const fps = Math.min(120, Math.max(1, Math.round(probe.fps)));
	return Number.isFinite(probe.duration) &&
		probe.duration > 0 &&
		probe.duration <= 86_400 &&
		Number.isFinite(probe.fps) &&
		Number.isSafeInteger(probe.width) &&
		Number.isSafeInteger(probe.height) &&
		probe.width > 0 &&
		probe.height > 0 &&
		probe.width <= 16_384 &&
		probe.height <= 16_384 &&
		probe.width * probe.height <= MAX_VIDEO_PIXELS
		? { ...probe, fps }
		: null;
}

export async function probeWebEditorVideo(
	file: Blob,
): Promise<WebEditorVideoProbe> {
	const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
	const input = new Input({
		formats: ALL_FORMATS,
		source: new BlobSource(file),
	});
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track || !(await track.canDecode()))
			throw new Error("This video can't be played in your browser");
		const [duration, stats, audioTracks] = await Promise.all([
			input.computeDuration(),
			track.computePacketStats(120),
			input.getAudioTracks(),
		]);
		const probe = validVideoProbe({
			duration,
			fps: stats.averagePacketRate || 30,
			width: track.displayWidth,
			height: track.displayHeight,
			hasAudio: audioTracks.length > 0,
		});
		if (!probe) throw new Error("This video is too large or too long");
		return probe;
	} catch (error) {
		throw error instanceof Error && error.message.startsWith("This video")
			? error
			: new Error("This video can't be read");
	} finally {
		input.dispose();
	}
}

function preparedVideo(value: unknown) {
	if (!asRecord(value)) return null;
	const { key, path, uploadId, provider } = value;
	if (
		typeof key !== "string" ||
		typeof path !== "string" ||
		!VIDEO_PATH.test(path) ||
		!key.endsWith(
			`/editor-assets/videos/${path.slice("content/videos/".length)}`,
		) ||
		typeof uploadId !== "string" ||
		uploadId.length < 1 ||
		uploadId.length > 8192 ||
		(provider !== "s3" && provider !== "googleDrive")
	) {
		return null;
	}
	return {
		key,
		path,
		uploadId,
		provider: provider === "s3" ? ("s3" as const) : ("googleDrive" as const),
	};
}

export async function importWebEditorVideo(
	file: File,
	videoId: string,
	signal: AbortSignal,
	onProgress?: (progress: WebEditorVideoImportProgress) => void,
): Promise<WebEditorImportedVideo> {
	if (isCapBundleFile(file)) throw new Error(CAP_BUNDLE_UNSUPPORTED);
	const extension = videoExtension(file);
	const contentType = extension ? VIDEO_TYPES[extension] : undefined;
	if (!extension || !contentType)
		throw new Error("Import an MP4 or WebM video");
	if (file.size < 1) throw new Error("This video file is empty");
	if (file.size > MAX_VIDEO_BYTES) throw new Error("Videos can be up to 12 GB");
	if (signal.aborted) throw new Error("Video import was canceled");
	onProgress?.({ stage: "staging", fraction: 0 });
	const probe = await probeWebEditorVideo(file);
	if (signal.aborted) throw new Error("Video import was canceled");
	const fileName = uploadFileName(file.name, extension);
	onProgress?.({ stage: "uploading", fraction: 0 });
	const basePath = `/api/editor/videos/${encodeURIComponent(videoId)}/video-assets`;
	const preparation = await fetch(basePath, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ fileName, size: file.size, contentType }),
		signal,
	});
	if (!preparation.ok)
		throw new Error(
			preparation.status === 409
				? "Another video is still uploading. Try again in a moment."
				: "Video upload could not start in the editor",
		);
	const target = preparedVideo(await preparation.json());
	if (!target) throw new Error("Video upload target was invalid");
	let uploadedFraction = 0;
	let reportedPercent = -1;
	const uploader = new InstantRecordingUploader({
		videoId: videoId as Video.VideoId,
		uploadId: target.uploadId,
		provider: target.provider,
		mimeType: contentType,
		subpath: target.key,
		setUploadStatus: () => {},
		sendProgressUpdate: async (uploaded, total) => {
			if (total <= 0) return;
			uploadedFraction = Math.min(1, uploaded / total);
			const percent = Math.floor(uploadedFraction * 100);
			if (percent !== reportedPercent) {
				reportedPercent = percent;
				onProgress?.({ stage: "uploading", fraction: uploadedFraction });
			}
		},
		api: {
			multipartBasePath: basePath,
			extraBody: { key: target.key, path: target.path },
		},
	});
	let uncertain = false;
	const canceled = () => {
		if (uploadedFraction < 1) void uploader.cancel();
	};
	signal.addEventListener("abort", canceled, { once: true });
	try {
		try {
			await uploader.finalize({
				durationSeconds: probe.duration,
				subpath: target.key,
				finalBlob: file,
			});
		} catch (error) {
			if (!(error instanceof MultipartCompletionUncertainError)) throw error;
			uncertain = true;
		}
		if (signal.aborted) throw new Error("Video import was canceled");
		onProgress?.({ stage: "ready", fraction: 1 });
		return {
			...probe,
			path: target.path,
			name: fileName.replace(/\.[^.]+$/, ""),
		};
	} catch (error) {
		if (!uncertain && !signal.aborted) await uploader.cancel();
		throw error;
	} finally {
		signal.removeEventListener("abort", canceled);
	}
}

export async function registerWebEditorClip(
	videoId: string,
	display: WebEditorImportedVideo,
	camera: { video: WebEditorImportedVideo; offsetMs: number } | null,
	signal: AbortSignal,
	projectConfig?: Record<string, unknown> | null,
): Promise<void> {
	const response = await fetch(
		`/api/editor/videos/${encodeURIComponent(videoId)}/clips`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: display.path,
				duration: display.duration,
				fps: display.fps,
				hasAudio: display.hasAudio,
				...(camera
					? {
							camera: {
								path: camera.video.path,
								fps: camera.video.fps,
								offsetMs: Math.round(camera.offsetMs),
							},
						}
					: {}),
				...(projectConfig ? { projectConfig } : {}),
			}),
			signal,
		},
	);
	if (!response.ok)
		throw new Error(
			response.status === 409
				? "Editor changed while importing the clip. Try again."
				: "Imported clip could not be added to the timeline",
		);
	const value: unknown = await response.json();
	if (!asRecord(value) || value.count !== 1)
		throw new Error("Imported clip registration was invalid");
}
