import type { Input, VideoSample, VideoSampleSink } from "mediabunny";
import type {
	BrowserVideoRole,
	BrowserVideoSourceProvider,
	BrowserVideoTrack,
} from "./browser-video-pool";

export type BrowserDecodedVideoFrame = {
	bitmap: ImageBitmap;
	width: number;
	height: number;
	mediaTime: number;
	sourceColorFix: boolean;
};

type DecodedSlot = {
	input: Input;
	sink: VideoSampleSink;
	retagBt601: boolean;
	iterator: AsyncGenerator<VideoSample, void, unknown> | null;
	current: VideoSample | null;
	upcoming: VideoSample | null;
	lastRequestedTime: number;
	streamSamples: number;
	slowStreamSamples: number;
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
				slot.input.dispose();
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
	slot.lastRequestedTime = -1;
	slot.streamSamples = 0;
	slot.slowStreamSamples = 0;
	if (iterator) await iterator.return();
}

async function sampleAtTime(
	slot: DecodedSlot,
	sourceTime: number,
	stream: boolean,
) {
	if (!stream) {
		await resetStream(slot);
		return slot.sink.getSample(Math.max(sourceTime, 0.0001));
	}
	if (
		slot.iterator &&
		(sourceTime + 0.000001 < slot.lastRequestedTime ||
			(slot.current && sourceTime + 0.000001 < slot.current.timestamp))
	) {
		await resetStream(slot);
	}
	if (!slot.iterator) {
		slot.iterator = slot.sink.samples(Math.max(sourceTime, 0.0001));
		const first = await slot.iterator.next();
		if (first.done) return null;
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
	slot.lastRequestedTime = sourceTime;
	return slot.current.clone();
}

export class BrowserDecodedVideoPool {
	private readonly slots = new Map<string, SlotEntry>();
	private readonly slowSources = new Set<string>();
	private retainedKeys: Set<string> | null = null;
	private disposed = false;

	constructor(private readonly sourceProvider: BrowserVideoSourceProvider) {}

	private async createSlot(url: string): Promise<DecodedSlot | null> {
		if (typeof VideoDecoder !== "function") return null;
		const { ALL_FORMATS, Input, UrlSource, VideoSampleSink } = await import(
			"mediabunny"
		);
		const input = new Input({
			formats: ALL_FORMATS,
			source: new UrlSource(url, { maxCacheSize: 8 * 1024 * 1024 }),
		});
		try {
			const track = await input.getPrimaryVideoTrack();
			if (!track) throw new Error("Editor video track is unavailable");
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
				width > 1920 ||
				height > 1080 ||
				!config ||
				!(await VideoDecoder.isConfigSupported(config)).supported
			) {
				input.dispose();
				return null;
			}
			return {
				input,
				sink: new VideoSampleSink(track),
				iterator: null,
				current: null,
				upcoming: null,
				lastRequestedTime: -1,
				streamSamples: 0,
				slowStreamSamples: 0,
				serial: Promise.resolve(),
				retagBt601:
					config.codec.startsWith("avc1") &&
					config.colorSpace === undefined &&
					width <= 720 &&
					height <= 576,
			};
		} catch {
			input.dispose();
			return null;
		}
	}

	async frame(
		segmentIndex: number,
		track: BrowserVideoTrack,
		role: BrowserVideoRole,
		sourceTime: number,
		signal: AbortSignal,
		stream = false,
		maxSourceWidth: number | null = null,
		maxSourceHeight: number | null = null,
	): Promise<BrowserDecodedVideoFrame | null | "fallback"> {
		if (this.disposed) throw new Error("Editor decoded video pool is closed");
		if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
			throw new Error("Editor clip index is invalid");
		}
		if (!Number.isFinite(sourceTime) || sourceTime < 0) {
			throw new Error("Editor video time is invalid");
		}
		if (
			(maxSourceWidth !== null &&
				(!Number.isSafeInteger(maxSourceWidth) || maxSourceWidth < 2)) ||
			(maxSourceHeight !== null &&
				(!Number.isSafeInteger(maxSourceHeight) || maxSourceHeight < 2))
		) {
			throw new Error("Editor decoded frame size is invalid");
		}
		if (signal.aborted) {
			throw signal.reason ?? new DOMException("Canceled", "AbortError");
		}
		const source = await this.sourceProvider(segmentIndex, track, signal);
		if (!source) {
			if (track === "camera") return null;
			throw new Error("Editor display video is unavailable");
		}
		const url = new URL(source.url, window.location.href);
		if (
			(url.protocol !== "https:" &&
				url.protocol !== "http:" &&
				url.protocol !== "blob:") ||
			(source.expiresAt !== null && source.expiresAt <= Date.now())
		) {
			throw new Error("Editor video source URL is invalid");
		}
		if (this.slowSources.has(url.href)) return "fallback";
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
				promise: this.createSlot(url.href),
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
			let decodeStarted = 0;
			try {
				await previous;
				if (signal.aborted || this.disposed) {
					throw signal.reason ?? new DOMException("Canceled", "AbortError");
				}
				decodeStarted = performance.now();
				sample = await sampleAtTime(slot, sourceTime, stream);
			} finally {
				releaseSerial();
			}
			if (!sample) throw new Error("Editor decoded frame is unavailable");
			try {
				let videoFrame = sample.toVideoFrame();
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
					const scale =
						maxSourceWidth !== null && maxSourceHeight !== null
							? Math.min(
									1,
									maxSourceWidth / videoFrame.displayWidth,
									maxSourceHeight / videoFrame.displayHeight,
								)
							: 1;
					let bitmap: ImageBitmap;
					if (scale < 1) {
						try {
							bitmap = await createImageBitmap(videoFrame, {
								resizeWidth: Math.max(
									2,
									Math.round(videoFrame.displayWidth * scale),
								),
								resizeHeight: Math.max(
									2,
									Math.round(videoFrame.displayHeight * scale),
								),
								resizeQuality: "medium",
							});
						} catch {
							bitmap = await createImageBitmap(videoFrame);
						}
					} else {
						bitmap = await createImageBitmap(videoFrame);
					}
					if (signal.aborted || this.disposed) {
						bitmap.close();
						throw signal.reason ?? new DOMException("Canceled", "AbortError");
					}
					if (stream) {
						const elapsedMs = performance.now() - decodeStarted;
						if (slot.streamSamples === 0 && elapsedMs > 250) {
							this.retireSource(url.href);
						} else if (slot.streamSamples > 0) {
							slot.slowStreamSamples =
								elapsedMs > 100 ? slot.slowStreamSamples + 1 : 0;
							if (slot.slowStreamSamples >= 2) this.retireSource(url.href);
						}
						slot.streamSamples++;
					}
					return {
						bitmap,
						width: bitmap.width,
						height: bitmap.height,
						mediaTime: sample.timestamp,
						sourceColorFix:
							slot.retagBt601 &&
							!colorRetagged &&
							videoFrame.colorSpace.matrix !== "bt470bg" &&
							navigator.userAgent.includes("Firefox/"),
					};
				} finally {
					videoFrame.close();
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

	private retireSource(url: string) {
		this.slowSources.add(url);
		for (const [key, entry] of this.slots) {
			if (entry.url !== url) continue;
			this.slots.delete(key);
			releaseEntry(entry);
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
		this.slowSources.clear();
		this.retainedKeys = null;
	}
}
