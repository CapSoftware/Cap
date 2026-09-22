export type BrowserVideoTrack = "display" | "camera";
export type BrowserVideoRole = "primary" | "overlap";

export type BrowserVideoSource = {
	url: string;
	expiresAt: number | null;
};

export type BrowserVideoSourceProvider = (
	segmentIndex: number,
	track: BrowserVideoTrack,
	signal: AbortSignal,
) => Promise<BrowserVideoSource | null>;

type VideoSlot = {
	element: HTMLVideoElement;
	url: string;
	activeCalls: number;
	primed: boolean;
};

function mediaError(video: HTMLVideoElement) {
	const code = video.error?.code;
	return new Error(
		code === undefined
			? "Editor video could not decode"
			: `Editor video could not decode (media error ${code})`,
	);
}

function waitForVideo(
	video: HTMLVideoElement,
	eventName: "loadeddata" | "seeked",
	signal: AbortSignal,
	timeoutMs: number,
) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new DOMException("Canceled", "AbortError"));
			return;
		}
		let settled = false;
		const done = (error?: Error) => {
			if (settled) return;
			settled = true;
			video.removeEventListener(eventName, onReady);
			video.removeEventListener("error", onError);
			signal.removeEventListener("abort", onAbort);
			window.clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		const onReady = () => done();
		const onError = () => done(mediaError(video));
		const onAbort = () =>
			done(
				signal.reason instanceof Error
					? signal.reason
					: new DOMException("Canceled", "AbortError"),
			);
		const timer = window.setTimeout(
			() => done(new Error("Editor video decode timed out")),
			timeoutMs,
		);
		video.addEventListener(eventName, onReady, { once: true });
		video.addEventListener("error", onError, { once: true });
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function waitForDecodedVideoFrame(
	video: HTMLVideoElement,
	signal: AbortSignal,
	timeoutMs: number,
) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason ?? new DOMException("Canceled", "AbortError"));
			return;
		}
		let settled = false;
		const done = (error?: Error) => {
			if (settled) return;
			settled = true;
			window.clearInterval(interval);
			window.clearTimeout(timer);
			video.removeEventListener("resize", check);
			video.removeEventListener("loadeddata", check);
			video.removeEventListener("error", onError);
			signal.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (
				video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
				video.videoWidth > 0 &&
				video.videoHeight > 0
			) {
				done();
			}
		};
		const onError = () => done(mediaError(video));
		const onAbort = () =>
			done(
				signal.reason instanceof Error
					? signal.reason
					: new DOMException("Canceled", "AbortError"),
			);
		const timer = window.setTimeout(
			() => done(new Error("Editor video frame timed out")),
			timeoutMs,
		);
		const interval = window.setInterval(check, 25);
		video.addEventListener("resize", check);
		video.addEventListener("loadeddata", check);
		video.addEventListener("error", onError, { once: true });
		signal.addEventListener("abort", onAbort, { once: true });
		check();
	});
}

function waitForPresentedVideoFrame(
	video: HTMLVideoElement,
	target: number,
	signal: AbortSignal,
	timeoutMs: number,
) {
	if (typeof video.requestVideoFrameCallback !== "function")
		return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		let callbackId = 0;
		const done = (presented: boolean) => {
			if (settled) return;
			settled = true;
			video.cancelVideoFrameCallback(callbackId);
			window.clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(presented);
		};
		const onAbort = () => done(false);
		const onFrame: VideoFrameRequestCallback = (_, metadata) => {
			if (Math.abs(metadata.mediaTime - target) <= 0.075) {
				done(true);
			} else if (!settled) {
				callbackId = video.requestVideoFrameCallback(onFrame);
			}
		};
		const timer = window.setTimeout(() => done(false), timeoutMs);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		else callbackId = video.requestVideoFrameCallback(onFrame);
	});
}

function sourceUrl(value: string) {
	const url = new URL(value, window.location.href);
	if (
		url.protocol !== "https:" &&
		url.protocol !== "http:" &&
		url.protocol !== "blob:"
	) {
		throw new Error("Editor video source URL is invalid");
	}
	return url.href;
}

function slotKey(
	segmentIndex: number,
	track: BrowserVideoTrack,
	role: BrowserVideoRole,
) {
	return `${segmentIndex}:${track}:${role}`;
}

function sourceKey(segmentIndex: number, track: BrowserVideoTrack) {
	return `${segmentIndex}:${track}`;
}

function releaseSlot(slot: VideoSlot) {
	slot.element.pause();
	slot.element.removeAttribute("src");
	slot.element.load();
	slot.element.remove();
}

export class BrowserVideoPool {
	private readonly slots = new Map<string, VideoSlot>();
	private readonly retired = new Set<VideoSlot>();
	private readonly sources = new Map<string, BrowserVideoSource>();
	private readonly host = document.createElement("div");
	private retainedKeys: Set<string> | null = null;
	private disposed = false;

	constructor(private readonly sourceProvider: BrowserVideoSourceProvider) {
		this.host.style.cssText =
			"position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0.01";
		document.body.append(this.host);
	}

	private async source(
		segmentIndex: number,
		track: BrowserVideoTrack,
		signal: AbortSignal,
	) {
		const key = sourceKey(segmentIndex, track);
		const cached = this.sources.get(key);
		if (
			cached &&
			(cached.expiresAt === null || cached.expiresAt > Date.now() + 60_000)
		) {
			return cached;
		}
		const fresh = await this.sourceProvider(segmentIndex, track, signal);
		if (!fresh) {
			if (track === "camera") return null;
			throw new Error("Editor display video is unavailable");
		}
		const result = { url: sourceUrl(fresh.url), expiresAt: fresh.expiresAt };
		if (result.expiresAt !== null && result.expiresAt <= Date.now()) {
			throw new Error("Editor video source URL has expired");
		}
		this.sources.set(key, result);
		return result;
	}

	private async slot(
		segmentIndex: number,
		track: BrowserVideoTrack,
		role: BrowserVideoRole,
		signal: AbortSignal,
	): Promise<VideoSlot | null> {
		if (this.disposed) throw new Error("Editor video pool is closed");
		const source = await this.source(segmentIndex, track, signal);
		if (!source) return null;
		if (signal.aborted) {
			throw signal.reason ?? new DOMException("Canceled", "AbortError");
		}
		const key = slotKey(segmentIndex, track, role);
		let slot = this.slots.get(key);
		let created = false;
		if (slot && slot.url !== source.url) {
			if (slot.activeCalls > 0) this.retired.add(slot);
			else releaseSlot(slot);
			this.slots.delete(key);
			slot = undefined;
		}
		if (!slot) {
			const video = document.createElement("video");
			video.muted = true;
			video.playsInline = true;
			video.preload = "auto";
			if (!source.url.startsWith("blob:")) video.crossOrigin = "anonymous";
			video.src = source.url;
			this.host.append(video);
			slot = { element: video, url: source.url, activeCalls: 0, primed: false };
			this.slots.set(key, slot);
			created = true;
		}
		slot.activeCalls++;
		try {
			if (slot.element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
				const loaded = waitForVideo(slot.element, "loadeddata", signal, 15_000);
				if (
					created ||
					slot.element.networkState === HTMLMediaElement.NETWORK_EMPTY
				) {
					slot.element.load();
				}
				await loaded;
			}
			if (this.disposed) throw new Error("Editor video pool is closed");
			return slot;
		} catch (cause) {
			slot.activeCalls--;
			if (slot.activeCalls === 0 && this.retired.delete(slot)) {
				releaseSlot(slot);
			}
			if (
				slot.activeCalls === 0 &&
				this.slots.get(key) === slot &&
				!signal.aborted
			) {
				releaseSlot(slot);
				this.slots.delete(key);
				this.sources.delete(sourceKey(segmentIndex, track));
			}
			throw cause;
		}
	}

	async frame(
		segmentIndex: number,
		track: BrowserVideoTrack,
		role: BrowserVideoRole,
		sourceTime: number,
		playing: boolean,
		speed: number,
		signal: AbortSignal,
		forceSeek = false,
	): Promise<HTMLVideoElement | null> {
		if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
			throw new Error("Editor clip index is invalid");
		}
		if (!Number.isFinite(sourceTime) || sourceTime < 0) {
			throw new Error("Editor video time is invalid");
		}
		const slot = await this.slot(segmentIndex, track, role, signal);
		if (!slot) return null;
		const video = slot.element;
		try {
			const target = Number.isFinite(video.duration)
				? Math.min(sourceTime, Math.max(video.duration - 0.001, 0))
				: sourceTime;
			// Firefox can clear WebM frame dimensions after a seek to exactly zero;
			// this sample is still inside the first encoded frame.
			const decodeTarget =
				target === 0 && Number.isFinite(video.duration) && video.duration > 0
					? Math.min(video.duration / 2, 0.0001)
					: target;
			const tolerance =
				playing && !forceSeek && speed >= 0.25 && speed <= 4 ? 0.05 : 1 / 120;
			if (
				!slot.primed ||
				Math.abs(video.currentTime - decodeTarget) > tolerance
			) {
				video.pause();
				if (Math.abs(video.currentTime - decodeTarget) > 0) {
					const presentation = playing
						? null
						: waitForPresentedVideoFrame(video, decodeTarget, signal, 250);
					const seeked = waitForVideo(video, "seeked", signal, 10_000);
					video.currentTime = decodeTarget;
					await seeked;
					if (presentation && !(await presentation) && !signal.aborted) {
						await new Promise((resolve) => window.setTimeout(resolve, 16));
					}
					if (speed > 4 && navigator.vendor === "Google Inc.") {
						await new Promise(requestAnimationFrame);
					}
				}
				slot.primed = true;
			}
			if (signal.aborted) {
				throw signal.reason ?? new DOMException("Canceled", "AbortError");
			}
			if (playing && speed >= 0.25 && speed <= 4) {
				video.playbackRate = speed;
				if (video.paused) await video.play();
				if (signal.aborted) {
					video.pause();
					throw signal.reason ?? new DOMException("Canceled", "AbortError");
				}
			} else if (!video.paused) {
				video.pause();
			}
			if (
				video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
				video.videoWidth === 0 ||
				video.videoHeight === 0
			) {
				await waitForDecodedVideoFrame(video, signal, 5_000);
			}
			return video;
		} finally {
			slot.activeCalls--;
			if (slot.activeCalls === 0 && this.retired.delete(slot)) {
				releaseSlot(slot);
			}
			const key = slotKey(segmentIndex, track, role);
			if (
				slot.activeCalls === 0 &&
				this.slots.get(key) === slot &&
				this.retainedKeys !== null &&
				!this.retainedKeys.has(key)
			) {
				releaseSlot(slot);
				this.slots.delete(key);
			}
		}
	}

	pause() {
		for (const slot of this.slots.values()) slot.element.pause();
	}

	retainSegments(primary: number, overlap: number | null) {
		const wanted = new Set<string>();
		for (const track of ["display", "camera"] as const) {
			wanted.add(slotKey(primary, track, "primary"));
			if (overlap !== null) {
				wanted.add(slotKey(overlap, track, "overlap"));
			}
		}
		this.retainedKeys = wanted;
		for (const [key, slot] of this.slots) {
			if (wanted.has(key) || slot.activeCalls > 0) continue;
			releaseSlot(slot);
			this.slots.delete(key);
		}
	}

	releaseOverlaps() {
		for (const [key, slot] of this.slots) {
			if (!key.endsWith(":overlap")) continue;
			this.retainedKeys?.delete(key);
			if (slot.activeCalls > 0) continue;
			releaseSlot(slot);
			this.slots.delete(key);
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const slot of this.slots.values()) releaseSlot(slot);
		for (const slot of this.retired) releaseSlot(slot);
		this.slots.clear();
		this.retired.clear();
		this.sources.clear();
		this.retainedKeys = null;
		this.host.remove();
	}
}
