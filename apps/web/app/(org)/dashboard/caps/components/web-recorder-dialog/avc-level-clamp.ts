const MAX_LEVEL_4_2_WIDTH = 2048;
const MAX_LEVEL_4_2_HEIGHT = 1088;
const MAX_LEVEL_5_1_WIDTH = 4096;
const MAX_LEVEL_5_1_HEIGHT = 2304;

const LEVEL_4_2_CODEC = "avc1.64002A";
const LEVEL_5_1_CODEC = "avc1.640033";
const LEVEL_5_2_CODEC = "avc1.640034";

export function pickMobileSafeAvcCodec(
	width: number | undefined,
	height: number | undefined,
): string {
	const w = typeof width === "number" && width > 0 ? width : 0;
	const h = typeof height === "number" && height > 0 ? height : 0;

	if (w === 0 || h === 0) {
		return LEVEL_4_2_CODEC;
	}

	if (w <= MAX_LEVEL_4_2_WIDTH && h <= MAX_LEVEL_4_2_HEIGHT) {
		return LEVEL_4_2_CODEC;
	}

	if (w <= MAX_LEVEL_5_1_WIDTH && h <= MAX_LEVEL_5_1_HEIGHT) {
		return LEVEL_5_1_CODEC;
	}

	return LEVEL_5_2_CODEC;
}

export function rewriteAvcCodecString(
	codec: string,
	width: number | undefined,
	height: number | undefined,
): string {
	if (!codec.toLowerCase().startsWith("avc1.")) {
		return codec;
	}
	return pickMobileSafeAvcCodec(width, height);
}

type AvcClampCleanup = () => void;

export function installAvcLevelClamp(): AvcClampCleanup {
	if (
		typeof globalThis === "undefined" ||
		typeof (globalThis as { VideoEncoder?: typeof VideoEncoder })
			.VideoEncoder === "undefined"
	) {
		return () => {};
	}

	const prototype = VideoEncoder.prototype;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "configure");

	if (!descriptor || typeof descriptor.value !== "function") {
		return () => {};
	}

	const originalConfigure = descriptor.value as (
		this: VideoEncoder,
		config: VideoEncoderConfig,
	) => void;

	const patched = function patchedConfigure(
		this: VideoEncoder,
		config: VideoEncoderConfig,
	) {
		const nextCodec = rewriteAvcCodecString(
			config.codec,
			config.width,
			config.height,
		);

		if (nextCodec === config.codec) {
			return originalConfigure.call(this, config);
		}

		const patchedConfig: VideoEncoderConfig = {
			...config,
			codec: nextCodec,
		};
		return originalConfigure.call(this, patchedConfig);
	};

	try {
		Object.defineProperty(prototype, "configure", {
			...descriptor,
			value: patched,
		});
	} catch {
		return () => {};
	}

	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		try {
			Object.defineProperty(prototype, "configure", descriptor);
		} catch {}
	};
}
