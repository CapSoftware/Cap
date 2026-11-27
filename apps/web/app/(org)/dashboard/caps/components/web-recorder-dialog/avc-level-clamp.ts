import { pickMobileSafeAvcCodec } from "@cap/recorder-core/recorder-encoding";

export { pickMobileSafeAvcCodec };

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
