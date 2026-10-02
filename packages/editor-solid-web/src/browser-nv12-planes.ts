/// A decoded frame as NV12 planes for the renderer's own YUV to RGB
/// conversion; see `nv12_frame` in the renderer.
export type Nv12Planes = {
	nv12: Uint8Array;
	width: number;
	height: number;
	yStride: number;
	uvStride: number;
	fullRange: boolean;
	/// Interpolate chroma, which exports want: the browser encoder takes the
	/// rendered frame's chroma back without filtering. The preview repeats
	/// each chroma sample, as native playback does.
	smoothChroma: boolean;
	close(): void;
};

// Safari copies a decoded frame into a texture several times slower than it
// copies its planes out. The renderer's conversion needs compute, so only its
// WebGPU backend takes planes.
export const UPLOADS_NV12_PLANES =
	typeof navigator !== "undefined" &&
	/AppleWebKit/.test(navigator.userAgent) &&
	!/Chrome|Chromium|Edg/.test(navigator.userAgent);

// The renderer converts with BT.709 only; frames tagged with another matrix
// (e.g. BT.601 standard definition H.264) keep the browser's conversion.
export function takesNv12Planes(frame: VideoFrame) {
	const matrix = frame.colorSpace.matrix;
	return frame.format === "NV12" && (matrix == null || matrix === "bt709");
}

export async function nv12Planes(
	frame: VideoFrame,
	smoothChroma = false,
): Promise<Nv12Planes> {
	const { width, height } = frame.visibleRect ?? {
		width: frame.displayWidth,
		height: frame.displayHeight,
	};
	const uvStride = width + (width % 2);
	const nv12 = new Uint8Array(
		width * height + uvStride * Math.ceil(height / 2),
	);
	await frame.copyTo(nv12, {
		layout: [
			{ offset: 0, stride: width },
			{ offset: width * height, stride: uvStride },
		],
	});
	return {
		nv12,
		width,
		height,
		yStride: width,
		uvStride,
		// Safari's decoder expands video range to full range and says so.
		fullRange: frame.colorSpace.fullRange === true,
		smoothChroma,
		close() {},
	};
}
