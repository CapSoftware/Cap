/// Chrome colour-manages hardware-decoded video frames as it copies them into
/// a WebGPU texture: BT.709 video arrives re-encoded for an sRGB display
/// (about gamma 1.96), with lifted shadows, where the desktop renderer, the
/// WebGL path and software-decoded frames all keep the plain YUV to RGB
/// values. Copying one decoded frame of known greys measures that gamma.
/// Frames the decoder hands over in the calibration frame's pixel format and
/// colour space get the correction; frames the editor copies into memory (its
/// BT.601 retag) carry a different colour space and are left alone, as Chrome
/// doesn't colour-manage those.
export type FrameDisplayGamma = { kind: string; gamma: number };

export function videoFrameKind(frame: VideoFrame) {
	const space = frame.colorSpace;
	return [
		frame.format ?? "",
		space.primaries ?? "",
		space.transfer ?? "",
		space.matrix ?? "",
		space.fullRange ?? "",
	].join("|");
}

/// One 1920x1080 H.264 frame (BT.709, limited range) of ten grey bars, big
/// enough to take the hardware decoder.
const GREY_BARS_H264 =
	"AAAAAWdkECisuA8ARPyzUCAgFAAAAwAEAAADAMgQAAAAAWjuDyyLAAABBgX//1vcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MSBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MjQgbG9va2FoZWFkX3RocmVhZHM9NCBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MSBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAWWIhAS//vet34FNwys1a7pXOLTLq5Q0PVH2lKU0VgMYoxpuCgADHi/BDQAAIEplWIAitET6ioXeFvQwXIKqwNP1NerVkLZquPTR8o4N5BjWzRO8AAADAAADAAFLAAADADuAAAAYQAAAC7gAAAlAAAAHcAAACEAAAAsgAAARwAAAF8AAAC8AAAMARAAAAwCIAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAAADAt8=";
const GREYS = [0, 17, 34, 51, 68, 85, 128, 192, 235, 255];

function srgbEncode(linear: number) {
	return linear <= 0.0031308
		? linear * 12.92
		: 1.055 * linear ** (1 / 2.4) - 0.055;
}

/// The display gamma that maps each grey onto what the copy produced, or
/// null when the copy kept the plain values or did something else.
export function fitDisplayGamma(copied: number[]) {
	if (
		copied.every((value, index) => Math.abs(value - (GREYS[index] ?? 0)) <= 2)
	) {
		return null;
	}
	const error = (gamma: number) =>
		Math.max(
			...GREYS.map((grey, index) =>
				Math.abs(
					srgbEncode((grey / 255) ** gamma) * 255 - (copied[index] ?? 0),
				),
			),
		);
	let best = { gamma: 0, error: Number.POSITIVE_INFINITY };
	for (let gamma = 1.5; gamma <= 3; gamma += 0.001) {
		const candidate = error(gamma);
		if (candidate < best.error) best = { gamma, error: candidate };
	}
	return best.error <= 2 ? Math.round(best.gamma * 1000) / 1000 : null;
}

async function decodeGreyBars() {
	const data = Uint8Array.from(atob(GREY_BARS_H264), (char) =>
		char.charCodeAt(0),
	);
	const config: VideoDecoderConfig = { codec: "avc1.640028" };
	if (!(await VideoDecoder.isConfigSupported(config)).supported) return null;
	return new Promise<VideoFrame>((resolve, reject) => {
		const decoder = new VideoDecoder({
			output: (frame) => {
				resolve(frame);
				decoder.close();
			},
			error: reject,
		});
		decoder.configure(config);
		decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data }));
		decoder.flush().catch(reject);
	});
}

async function measure(): Promise<FrameDisplayGamma | null> {
	if (!navigator.gpu || typeof VideoDecoder !== "function") return null;
	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) return null;
	const device = await adapter.requestDevice();
	const frame = await decodeGreyBars();
	try {
		if (!frame?.format) return null;
		const width = frame.displayWidth;
		const height = frame.displayHeight;
		const texture = device.createTexture({
			size: [width, height],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});
		// The same copy the renderer makes into its frame textures.
		device.queue.copyExternalImageToTexture(
			{ source: frame },
			{ texture, colorSpace: "srgb", premultipliedAlpha: false },
			[width, height],
		);
		const buffer = device.createBuffer({
			size: GREYS.length * 256,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		const encoder = device.createCommandEncoder();
		const bar = width / GREYS.length;
		GREYS.forEach((_, index) => {
			encoder.copyTextureToBuffer(
				{
					texture,
					origin: [Math.floor((index + 0.5) * bar), Math.floor(height / 2)],
				},
				{ buffer, offset: index * 256 },
				[1, 1],
			);
		});
		device.queue.submit([encoder.finish()]);
		await buffer.mapAsync(GPUMapMode.READ);
		const pixels = new Uint8Array(buffer.getMappedRange());
		const copied = GREYS.map((_, index) => pixels[index * 256] ?? 0);
		const gamma = fitDisplayGamma(copied);
		return gamma === null ? null : { kind: videoFrameKind(frame), gamma };
	} finally {
		frame?.close();
		device.destroy();
	}
}

let pending: Promise<FrameDisplayGamma | null> | null = null;

export function frameDisplayGamma() {
	if (!pending) pending = measure().catch(() => null);
	return pending;
}
