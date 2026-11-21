export interface CaptureVideoFrameDeps {
	video: HTMLVideoElement | null;
	createCanvas?: () => HTMLCanvasElement;
	width?: number;
	height?: number;
	quality?: number;
}

export const MAX_LIVE_THUMBNAIL_DRIFT_SECONDS = 1.5;

export interface ShouldCaptureLiveThumbnailParams {
	hoverTime: number;
	currentTime: number;
	maxDriftSeconds?: number;
}

/**
 * Determines whether a live video element snapshot accurately reflects the hovered timeline time.
 * Because HTMLVideoElement only holds decoded frame data for its active currentTime,
 * snapshotting the element is only valid when hovering within close proximity of playback.
 * Returning false for distant timestamps prevents displaying misleading frame snapshots.
 */
export function shouldCaptureLiveThumbnail({
	hoverTime,
	currentTime,
	maxDriftSeconds = MAX_LIVE_THUMBNAIL_DRIFT_SECONDS,
}: ShouldCaptureLiveThumbnailParams): boolean {
	if (!Number.isFinite(hoverTime) || !Number.isFinite(currentTime)) {
		return false;
	}
	return Math.abs(hoverTime - currentTime) <= maxDriftSeconds;
}

export function captureVideoFrameDataUrl(
	deps: CaptureVideoFrameDeps,
): string | undefined {
	const { video, width = 224, height = 128, quality = 0.8 } = deps;
	if (!video) return undefined;
	if (video.readyState < 2) return undefined;
	const createCanvas =
		deps.createCanvas ?? (() => document.createElement("canvas"));
	const canvas = createCanvas();
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return undefined;
	try {
		const sourceWidth = video.videoWidth || width;
		const sourceHeight = video.videoHeight || height;
		const sourceAspectRatio = sourceWidth / sourceHeight;
		const outputAspectRatio = width / height;
		let sourceX = 0;
		let sourceY = 0;
		let croppedWidth = sourceWidth;
		let croppedHeight = sourceHeight;

		if (sourceAspectRatio > outputAspectRatio) {
			croppedWidth = sourceHeight * outputAspectRatio;
			sourceX = (sourceWidth - croppedWidth) / 2;
		} else if (sourceAspectRatio < outputAspectRatio) {
			croppedHeight = sourceWidth / outputAspectRatio;
			sourceY = (sourceHeight - croppedHeight) / 2;
		}

		ctx.drawImage(
			video,
			sourceX,
			sourceY,
			croppedWidth,
			croppedHeight,
			0,
			0,
			width,
			height,
		);
		return canvas.toDataURL("image/jpeg", quality);
	} catch {
		return undefined;
	}
}
