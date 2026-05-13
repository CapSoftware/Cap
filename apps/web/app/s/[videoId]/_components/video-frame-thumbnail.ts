export interface CaptureVideoFrameDeps {
	video: HTMLVideoElement | null;
	createCanvas?: () => HTMLCanvasElement;
	width?: number;
	height?: number;
}

export function captureVideoFrameDataUrl(
	deps: CaptureVideoFrameDeps,
): string | undefined {
	const { video, width = 224, height = 128 } = deps;
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
		ctx.drawImage(video, 0, 0, width, height);
		return canvas.toDataURL("image/jpeg", 0.8);
	} catch {
		return undefined;
	}
}
