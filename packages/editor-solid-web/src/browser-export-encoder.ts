// Local export's H.264 encoding. The export drives WebCodecs directly instead
// of through mediabunny's canvas source, which waits on the muxer after every
// frame; here packets are written in batches while the encoder keeps working.
import type { EncodedPacket } from "mediabunny";

// mediabunny's choice of profile and level for its own encoder, kept so the
// stream is described exactly as before.
const AVC_LEVELS: Array<
	[maxMacroblocks: number, maxBitrate: number, level: number]
> = [
	[99, 64_000, 0x0a],
	[396, 192_000, 0x0b],
	[396, 384_000, 0x0c],
	[396, 768_000, 0x0d],
	[396, 2_000_000, 0x14],
	[792, 4_000_000, 0x15],
	[1620, 4_000_000, 0x16],
	[1620, 10_000_000, 0x1e],
	[3600, 14_000_000, 0x1f],
	[5120, 20_000_000, 0x20],
	[8192, 20_000_000, 0x28],
	[8192, 50_000_000, 0x29],
	[8704, 50_000_000, 0x2a],
	[22080, 135_000_000, 0x32],
	[36864, 240_000_000, 0x33],
	[36864, 240_000_000, 0x34],
	[139264, 240_000_000, 0x3c],
	[139264, 480_000_000, 0x3d],
	[139264, 800_000_000, 0x3e],
];

export function avcCodecString(width: number, height: number, bitrate: number) {
	const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
	const level =
		AVC_LEVELS.find(
			([maxMacroblocks, maxBitrate]) =>
				macroblocks <= maxMacroblocks && bitrate <= maxBitrate,
		)?.[2] ?? 0x3e;
	return `avc1.6400${level.toString(16).padStart(2, "0")}`;
}

/// The keyframe group `frame` belongs to: a new one starts whenever `seconds`
/// elapse, the rule mediabunny's encoder used.
export function keyframeGroup(frame: number, fps: number, seconds: number) {
	return Math.floor(frame / fps / seconds);
}

/// Whether length-prefixed H.264 `data` holds an IDR slice. Some encoders
/// label their first keyframe a delta frame (mediabunny checks the same way).
export function avcHasIdr(data: Uint8Array) {
	let offset = 0;
	while (offset + 4 < data.byteLength) {
		const length =
			((data[offset] ?? 0) << 24) |
			((data[offset + 1] ?? 0) << 16) |
			((data[offset + 2] ?? 0) << 8) |
			(data[offset + 3] ?? 0);
		if (length <= 0) return false;
		if (((data[offset + 4] ?? 0) & 0x1f) === 5) return true;
		offset += 4 + length;
	}
	return false;
}

export type ExportPacket = {
	packet: EncodedPacket;
	meta?: EncodedVideoChunkMetadata;
};

/// Hands rendered frames to an H.264 encoder and collects its packets, each
/// mapped back to the output frame it encodes.
export class ExportEncoder {
	private readonly encoder: VideoEncoder;
	private readonly frameAt = new Map<number, number>();
	private readonly ready: ExportPacket[] = [];
	private emitted = 0;
	private failure: Error | null = null;

	constructor(
		config: VideoEncoderConfig,
		private readonly fps: number,
		private readonly packetFrom: (
			chunk: EncodedVideoChunk,
			frame: number,
			key: boolean,
		) => EncodedPacket,
	) {
		this.encoder = new VideoEncoder({
			output: (chunk, meta) => this.output(chunk, meta),
			error: (error) => {
				this.failure ??= error;
			},
		});
		this.encoder.configure(config);
	}

	/// The timestamp a frame was handed over with. WebKit's encoder hands
	/// back timestamps slightly off from the ones it was given, so the nearest
	/// pending one within half a frame counts.
	private pendingTimestamp(timestamp: number) {
		if (this.frameAt.has(timestamp)) return timestamp;
		let nearest: number | undefined;
		for (const pending of this.frameAt.keys())
			if (
				nearest === undefined ||
				Math.abs(pending - timestamp) < Math.abs(nearest - timestamp)
			)
				nearest = pending;
		return nearest !== undefined &&
			Math.abs(nearest - timestamp) <= 500_000 / this.fps
			? nearest
			: undefined;
	}

	private output(
		chunk: EncodedVideoChunk,
		meta: EncodedVideoChunkMetadata | undefined,
	) {
		const timestamp = this.pendingTimestamp(chunk.timestamp);
		const frame =
			timestamp === undefined ? undefined : this.frameAt.get(timestamp);
		if (timestamp === undefined || frame === undefined) {
			this.failure ??= new Error("Export encoder returned an unknown frame");
			return;
		}
		this.frameAt.delete(timestamp);
		let key = chunk.type === "key";
		if (!key && this.emitted === 0 && meta?.decoderConfig) {
			const data = new Uint8Array(chunk.byteLength);
			chunk.copyTo(data);
			key = avcHasIdr(data);
		}
		this.emitted++;
		this.ready.push({ packet: this.packetFrom(chunk, frame, key), meta });
	}

	private check() {
		if (this.failure) throw this.failure;
	}

	/// Encodes what `source` shows now as output frame `frame`. Resolves once
	/// the encoder can take another frame.
	async encode(frame: number, keyFrame: boolean, source: OffscreenCanvas) {
		this.check();
		// The same microsecond timestamps mediabunny gave the canvas frames.
		const timestamp = Math.trunc((frame / this.fps) * 1e6);
		this.frameAt.set(timestamp, frame);
		const videoFrame = new VideoFrame(source, {
			timestamp,
			duration: Math.trunc((1 / this.fps) * 1e6) || undefined,
		});
		try {
			this.encoder.encode(videoFrame, { keyFrame });
		} finally {
			videoFrame.close();
		}
		while (this.encoder.encodeQueueSize >= 4 && !this.failure)
			await new Promise<void>((resolve) =>
				this.encoder.addEventListener("dequeue", () => resolve(), {
					once: true,
				}),
			);
		this.check();
	}

	async flush() {
		await this.encoder.flush();
		this.check();
	}

	/// The packets encoded so far and not yet taken, in the order they came out.
	take(): ExportPacket[] {
		this.check();
		return this.ready.splice(0);
	}

	close() {
		if (this.encoder.state !== "closed") this.encoder.close();
	}
}
