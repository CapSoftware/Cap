import type {
	EncodedPacketSink,
	Input,
	VideoSample,
	VideoSampleSink,
} from "mediabunny";
import {
	acquireMediaInputAt,
	type MediaInputLease,
} from "./browser-media-inputs";
import type {
	BrowserVideoRole,
	BrowserVideoSourceProvider,
	BrowserVideoTrack,
} from "./browser-video-pool";
import { perfCount, perfEvent, perfSpan, perfStart } from "./editor-perf";

/// Up to 4K (Retina screens included) decodes with WebCodecs; a <video>
/// element would read the whole fragmented recording before it could seek.
export const MAX_DECODED_PIXELS = 3840 * 2160;

export type BrowserDecodedVideoFrame = {
	frame: VideoFrame;
	width: number;
	height: number;
	mediaTime: number;
	sourceColorFix: boolean;
};

const PARSED_URL_LIMIT = 16;

type DecodedSlot = {
	lease: MediaInputLease;
	sink: VideoSampleSink;
	packets: EncodedPacketSink;
	retagBt601: boolean;
	iterator: AsyncGenerator<VideoSample, void, unknown> | null;
	current: VideoSample | null;
	upcoming: VideoSample | null;
	serial: Promise<void>;
};

type SlotEntry = {
	url: string;
	promise: Promise<DecodedSlot | null>;
	activeCalls: number;
	retired: boolean;
	released: boolean;
};

function slotKey(
	segmentIndex: number,
	track: BrowserVideoTrack,
	role: BrowserVideoRole,
) {
	return `${segmentIndex}:${track}:${role}`;
}

function releaseEntry(entry: SlotEntry) {
	entry.retired = true;
	if (entry.activeCalls > 0 || entry.released) return;
	entry.released = true;
	void entry.promise
		.then(async (slot) => {
			if (!slot) return;
			try {
				await slot.serial;
				await resetStream(slot);
			} finally {
				slot.lease.release();
			}
		})
		.catch(() => undefined);
}

async function resetStream(slot: DecodedSlot) {
	const iterator = slot.iterator;
	slot.iterator = null;
	slot.current?.close();
	slot.current = null;
	slot.upcoming?.close();
	slot.upcoming = null;
	if (iterator) await iterator.return();
}

/// Decoding forward from the frame already on screen is cheaper than
/// restarting at a key frame, unless a key frame sits between the two.
async function keyFrameBetween(
	slot: DecodedSlot,
	from: number,
	to: number,
): Promise<boolean> {
	try {
		const key = await slot.packets.getKeyPacket(to, { metadataOnly: true });
		return key !== null && key.timestamp > from + 0.000001;
	} catch {
		return true;
	}
}

async function sampleAtTime(slot: DecodedSlot, sourceTime: number) {
	const current = slot.current;
	if (
		slot.iterator &&
		current &&
		(sourceTime + 0.000001 < current.timestamp ||
			(sourceTime > current.timestamp + 0.5 &&
				(await keyFrameBetween(slot, current.timestamp, sourceTime))))
	) {
		perfCount("decode.restart");
		perfEvent("decode.restart");
		await resetStream(slot);
	}
	if (!slot.iterator) {
		slot.iterator = slot.sink.samples(Math.max(sourceTime, 0.0001));
		const first = await slot.iterator.next();
		if (first.done) {
			await resetStream(slot);
			return slot.sink.getSample(Math.max(sourceTime, 0.0001));
		}
		slot.current = first.value;
	}
	if (!slot.current) return null;
	while (sourceTime > slot.current.timestamp + 0.000001) {
		if (!slot.upcoming) {
			const next = await slot.iterator.next();
			if (next.done) break;
			slot.upcoming = next.value;
		}
		if (slot.upcoming.timestamp > sourceTime + 0.000001) break;
		slot.current.close();
		slot.current = slot.upcoming;
		slot.upcoming = null;
	}
	return slot.current.clone();
}

/// How far ahead of the frame on screen the exact frame is still only a few
/// decodes away, as when stepping frame by frame.
const NEAR_DECODE_SECS = 0.1;

/// The key frame at or before `sourceTime`: a single decode, where the exact
/// frame can take up to a key interval of them. The exact frame a few decodes
/// ahead of the stream, or a frame it already decoded between the two, is
/// closer and about as cheap.
async function keyFrameAtTime(slot: DecodedSlot, sourceTime: number) {
	const current = slot.current;
	if (
		slot.iterator &&
		current &&
		sourceTime + 0.000001 >= current.timestamp &&
		sourceTime <= current.timestamp + NEAR_DECODE_SECS
	) {
		return sampleAtTime(slot, sourceTime);
	}
	const key = await slot.packets
		.getKeyPacket(Math.max(sourceTime, 0.0001), { metadataOnly: true })
		.catch(() => null);
	if (!key) return sampleAtTime(slot, sourceTime);
	if (
		slot.iterator &&
		current &&
		current.timestamp >= key.timestamp - 0.000001 &&
		current.timestamp <= sourceTime + 0.000001
	) {
		return current.clone();
	}
	return slot.sink.getSample(key.timestamp);
}

async function videoSinks(input: Input) {
	const { EncodedPacketSink, VideoSampleSink } = await import("mediabunny");
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error("Editor video track is unavailable");
	return {
		track,
		sink: new VideoSampleSink(track),
		packets: new EncodedPacketSink(track),
	};
}

/// Moves a slot onto an input that reaches `sourceTime` without walking the
/// whole recording before it (see `acquireMediaInputAt`).
async function reachTime(
	slot: DecodedSlot,
	url: string,
	sourceTime: number,
	signal: AbortSignal,
	scrubbing: boolean,
) {
	if (await slot.lease.covers(sourceTime)) return;
	const next = await acquireMediaInputAt(url, sourceTime, signal, scrubbing);
	if (next.input === slot.lease.input) {
		next.release();
		return;
	}
	try {
		const { sink, packets } = await videoSinks(next.input);
		await resetStream(slot);
		slot.lease.release();
		slot.lease = next;
		slot.sink = sink;
		slot.packets = packets;
		perfCount("decode.region");
		perfEvent(`decode.region ${sourceTime.toFixed(3)}`);
	} catch (cause) {
		next.release();
		throw cause;
	}
}

export class BrowserDecodedVideoPool {
	private readonly slots = new Map<string, SlotEntry>();
	private retainedKeys: Set<string> | null = null;
	private disposed = false;

	constructor(private readonly sourceProvider: BrowserVideoSourceProvider) {}

	private async createSlot(
		url: string,
		sourceTime: number,
	): Promise<DecodedSlot | null> {
		if (typeof VideoDecoder !== "function") return null;
		const lease = await acquireMediaInputAt(url, sourceTime);
		const release = lease.release;
		try {
			const { track, sink, packets } = await videoSinks(lease.input);
			const [width, height, config] = await Promise.all([
				track.getDisplayWidth(),
				track.getDisplayHeight(),
				track.getDecoderConfig(),
			]);
			if (
				width === null ||
				height === null ||
				width < 1 ||
				height < 1 ||
				width * height > MAX_DECODED_PIXELS ||
				!config ||
				!(await VideoDecoder.isConfigSupported(config)).supported
			) {
				release();
				return null;
			}
			return {
				lease,
				sink,
				packets,
				iterator: null,
				current: null,
				upcoming: null,
				serial: Promise.resolve(),
				retagBt601:
					config.codec.startsWith("avc1") &&
					config.colorSpace === undefined &&
					width <= 720 &&
					height <= 576,
			};
		} catch {
			release();
			return null;
		}
	}

	/// Every frame asks for the same few URLs; parsing one is a measurable
	/// part of a frame's work.
	private parsedUrls = new Map<string, { href: string; protocol: string }>();
	private parsedUrl(source: string) {
		let parsed = this.parsedUrls.get(source);
		if (!parsed) {
			const url = new URL(source, window.location.href);
			parsed = { href: url.href, protocol: url.protocol };
			if (this.parsedUrls.size >= PARSED_URL_LIMIT) this.parsedUrls.clear();
			this.parsedUrls.set(source, parsed);
		}
		return parsed;
	}

	async frame(
		segmentIndex: number,
		track: BrowserVideoTrack,
		role: BrowserVideoRole,
		sourceTime: number,
		signal: AbortSignal,
		keyFrame = false,
	): Promise<BrowserDecodedVideoFrame | null | "fallback"> {
		if (this.disposed) throw new Error("Editor decoded video pool is closed");
		if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
			throw new Error("Editor clip index is invalid");
		}
		if (!Number.isFinite(sourceTime) || sourceTime < 0) {
			throw new Error("Editor video time is invalid");
		}
		if (signal.aborted) {
			throw signal.reason ?? new DOMException("Canceled", "AbortError");
		}
		const source = await this.sourceProvider(segmentIndex, track, signal);
		if (!source) {
			if (track === "camera") return null;
			throw new Error("Editor display video is unavailable");
		}
		const url = this.parsedUrl(source.url);
		if (
			(url.protocol !== "https:" &&
				url.protocol !== "http:" &&
				url.protocol !== "blob:") ||
			(source.expiresAt !== null && source.expiresAt <= Date.now())
		) {
			throw new Error("Editor video source URL is invalid");
		}
		const key = slotKey(segmentIndex, track, role);
		let entry = this.slots.get(key);
		if (entry && entry.url !== url.href) {
			releaseEntry(entry);
			this.slots.delete(key);
			entry = undefined;
		}
		if (!entry) {
			entry = {
				url: url.href,
				promise: this.createSlot(url.href, sourceTime),
				activeCalls: 0,
				retired: false,
				released: false,
			};
			this.slots.set(key, entry);
		}
		entry.activeCalls++;
		try {
			const slot = await entry.promise;
			if (!slot) return "fallback";
			if (signal.aborted || this.disposed) {
				throw signal.reason ?? new DOMException("Canceled", "AbortError");
			}
			let releaseSerial: () => void = () => undefined;
			const previous = slot.serial;
			slot.serial = new Promise<void>((resolve) => {
				releaseSerial = resolve;
			});
			let sample: VideoSample | null;
			try {
				await previous;
				if (signal.aborted || this.disposed) {
					throw signal.reason ?? new DOMException("Canceled", "AbortError");
				}
				const decodeStarted = perfStart();
				perfEvent(
					`decode.start ${track} ${sourceTime.toFixed(3)}${keyFrame ? " key" : ""}`,
				);
				await reachTime(slot, url.href, sourceTime, signal, keyFrame);
				perfEvent(`decode.reached ${track}`);
				sample = keyFrame
					? await keyFrameAtTime(slot, sourceTime)
					: await sampleAtTime(slot, sourceTime);
				perfEvent(`decode.done ${track} ${sample?.timestamp.toFixed(3)}`);
				if (sample && !keyFrame) slot.lease.reached(sample.timestamp);
				perfSpan("decode.sample", decodeStarted);
			} finally {
				releaseSerial();
			}
			if (!sample) throw new Error("Editor decoded frame is unavailable");
			try {
				let videoFrame: VideoFrame | null = sample.toVideoFrame();
				let colorRetagged = false;
				try {
					if (
						slot.retagBt601 &&
						videoFrame.colorSpace.matrix !== "bt470bg" &&
						videoFrame.format !== null &&
						(videoFrame.format === "I420" || videoFrame.format === "NV12") &&
						sample.rotation === 0 &&
						sample.visibleRect.left === 0 &&
						sample.visibleRect.top === 0 &&
						sample.visibleRect.width === sample.codedWidth &&
						sample.visibleRect.height === sample.codedHeight
					) {
						const pixels = new Uint8Array(sample.allocationSize());
						const layout = await sample.copyTo(pixels);
						const tagged = new VideoFrame(pixels, {
							format: videoFrame.format,
							codedWidth: sample.codedWidth,
							codedHeight: sample.codedHeight,
							timestamp: videoFrame.timestamp,
							layout,
							colorSpace: {
								primaries: "bt709",
								transfer: "bt709",
								matrix: "bt470bg",
								fullRange: false,
							},
						});
						videoFrame.close();
						videoFrame = tagged;
						colorRetagged = true;
					}
					if (signal.aborted || this.disposed) {
						throw signal.reason ?? new DOMException("Canceled", "AbortError");
					}
					// The renderer copies the decoder's frame straight into its
					// texture; an ImageBitmap or a downscale first would cost the GPU
					// another copy of every frame.
					const frame = videoFrame;
					videoFrame = null;
					return {
						frame,
						width: frame.displayWidth,
						height: frame.displayHeight,
						mediaTime: sample.timestamp,
						sourceColorFix:
							slot.retagBt601 &&
							!colorRetagged &&
							frame.colorSpace.matrix !== "bt470bg" &&
							navigator.userAgent.includes("Firefox/"),
					};
				} finally {
					videoFrame?.close();
				}
			} finally {
				sample.close();
			}
		} catch (cause) {
			if (signal.aborted || this.disposed) throw cause;
			if (this.slots.get(key) === entry) this.slots.delete(key);
			releaseEntry(entry);
			return "fallback";
		} finally {
			entry.activeCalls--;
			if (entry.activeCalls === 0 && entry.retired) releaseEntry(entry);
			if (
				entry.activeCalls === 0 &&
				this.slots.get(key) === entry &&
				this.retainedKeys !== null &&
				!this.retainedKeys.has(key)
			) {
				this.slots.delete(key);
				releaseEntry(entry);
			}
		}
	}

	/// Reads the packets for `seconds` of a track from `sourceTime` into its
	/// input's cache without decoding them, so playing from there finds its
	/// media loaded instead of fetching each frame as it comes due. Only the
	/// input the paused frame already reaches is read.
	async bufferAhead(
		segmentIndex: number,
		track: BrowserVideoTrack,
		sourceTime: number,
		seconds: number,
		signal: AbortSignal,
	) {
		const key = slotKey(segmentIndex, track, "primary");
		const entry = this.slots.get(key);
		if (!entry || entry.retired || this.disposed) return;
		entry.activeCalls++;
		try {
			const slot = await entry.promise;
			if (!slot || signal.aborted || !(await slot.lease.covers(sourceTime)))
				return;
			const start = await slot.packets.getKeyPacket(
				Math.max(sourceTime, 0.0001),
				{ metadataOnly: true },
			);
			if (!start || signal.aborted) return;
			perfEvent(`buffer.start ${track} ${sourceTime.toFixed(3)}`);
			for await (const packet of slot.packets.packets(start)) {
				if (signal.aborted || this.disposed) break;
				if (packet.timestamp > sourceTime + seconds) break;
			}
			perfEvent(`buffer.done ${track}`);
		} catch {
			// Buffering ahead is only a head start; playback reads what it needs.
		} finally {
			entry.activeCalls--;
			if (entry.activeCalls === 0 && entry.retired) releaseEntry(entry);
		}
	}

	retainSegments(primary: number, overlap: number | null) {
		const wanted = new Set<string>();
		for (const track of ["display", "camera"] as const) {
			wanted.add(slotKey(primary, track, "primary"));
			if (overlap !== null) wanted.add(slotKey(overlap, track, "overlap"));
		}
		this.retainedKeys = wanted;
		for (const [key, entry] of this.slots) {
			if (wanted.has(key)) continue;
			this.slots.delete(key);
			releaseEntry(entry);
		}
	}

	releaseOverlaps() {
		for (const [key, entry] of this.slots) {
			if (!key.endsWith(":overlap")) continue;
			this.slots.delete(key);
			this.retainedKeys?.delete(key);
			releaseEntry(entry);
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.slots.values()) releaseEntry(entry);
		this.slots.clear();
		this.retainedKeys = null;
	}
}
