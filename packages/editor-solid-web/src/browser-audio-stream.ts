import type { RemoteMedia } from "./browser-remote-media";

const MIME = 'audio/webm; codecs="opus"';
/// Recordings longer than this stream through a MediaSource; shorter ones
/// load quickly enough for a media element to seek in on its own.
export const STREAMED_AUDIO_MIN_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const AHEAD_SECONDS = 30;
const BEHIND_SECONDS = 20;
/// A position this far past the end of the audio being streamed is quicker to
/// reach by locating its cluster than by reading on.
const RELOCATE_SECONDS = 8;

export function canStreamAudio(contentType: string | null | undefined) {
	return (
		contentType === "audio/webm" &&
		typeof MediaSource !== "undefined" &&
		MediaSource.isTypeSupported(MIME)
	);
}

function bufferedRangeAt(buffered: TimeRanges, time: number) {
	for (let index = 0; index < buffered.length; index++) {
		if (buffered.start(index) - 0.05 <= time && time < buffered.end(index)) {
			return { start: buffered.start(index), end: buffered.end(index) };
		}
	}
	return null;
}

/// Plays a WebM audio recording through a MediaSource fed from where the
/// element is. A MediaRecorder file has no Cues, so an element given the file
/// itself reads every cluster before a seek target (tens of megabytes an hour
/// into a long recording); here the cluster at the target is found from a few
/// small reads and the element is given the audio from there on.
export class StreamedAudio {
	private readonly source = new MediaSource();
	private buffer: SourceBuffer | null = null;
	private readonly url: string;
	private init: Uint8Array | null = null;
	private appendAt: number | null = null;
	/// Start time of the cluster the current run of appends began at.
	private streamFrom = 0;
	private streamTarget = 0;
	private needsInit = true;
	private pumping = false;
	private again = false;
	private disposed = false;
	private readonly onEvent = () => this.pump();
	private readonly onError = () =>
		this.fail(new Error("Editor audio stream could not play"));

	constructor(
		private readonly media: RemoteMedia,
		private readonly element: HTMLAudioElement,
		private readonly duration: number | null,
		private readonly onFailure: (cause: unknown) => void,
	) {
		this.url = URL.createObjectURL(this.source);
		this.source.addEventListener("sourceopen", () => this.open(), {
			once: true,
		});
		for (const type of ["seeking", "timeupdate", "waiting", "play"]) {
			element.addEventListener(type, this.onEvent);
		}
		element.addEventListener("error", this.onError);
		element.src = this.url;
	}

	private open() {
		if (this.disposed) return;
		try {
			this.buffer = this.source.addSourceBuffer(MIME);
			if (this.duration !== null && this.duration > 0) {
				this.source.duration = this.duration;
			}
			this.buffer.addEventListener("updateend", this.onEvent);
			this.buffer.addEventListener("error", this.onError);
			this.pump();
		} catch (cause) {
			this.fail(cause);
		}
	}

	private fail(cause: unknown) {
		if (this.disposed) return;
		this.dispose();
		this.onFailure(cause);
	}

	private waitForBuffer() {
		const buffer = this.buffer;
		if (!buffer?.updating) return Promise.resolve();
		return new Promise<void>((resolve) =>
			buffer.addEventListener("updateend", () => resolve(), { once: true }),
		);
	}

	private async append(bytes: Uint8Array) {
		const buffer = this.buffer;
		if (!buffer || this.disposed) return;
		await this.waitForBuffer();
		if (this.disposed) return;
		buffer.appendBuffer(bytes as BufferSource);
		await this.waitForBuffer();
	}

	private pump() {
		if (this.disposed || !this.buffer) return;
		if (this.pumping) {
			this.again = true;
			return;
		}
		this.pumping = true;
		void this.fill()
			.catch((cause: unknown) => this.fail(cause))
			.finally(() => {
				this.pumping = false;
				if (this.again && !this.disposed) {
					this.again = false;
					this.pump();
				}
			});
	}

	private streamEnd(buffer: SourceBuffer) {
		const buffered = buffer.buffered;
		for (let index = 0; index < buffered.length; index++) {
			if (
				buffered.start(index) - 0.25 <= this.streamFrom &&
				this.streamFrom < buffered.end(index)
			) {
				return buffered.end(index);
			}
		}
		return this.streamFrom;
	}

	/// Keeps the audio from a little before the element's position to
	/// `AHEAD_SECONDS` after it buffered, starting over at a located cluster
	/// when the position is outside the audio being streamed.
	private async fill() {
		const buffer = this.buffer;
		if (!buffer) return;
		const size = await this.media.fileSize();
		this.init ??= await this.media.webmInit();
		if (!this.init) throw new Error("Editor audio stream has no init segment");
		for (let step = 0; step < 64 && !this.disposed; step++) {
			const time = this.element.currentTime;
			const here = bufferedRangeAt(buffer.buffered, time);
			if (here && here.end >= Math.min(time + AHEAD_SECONDS, this.endTime())) {
				break;
			}
			if (
				this.appendAt === null ||
				time < this.streamFrom - 0.05 ||
				time >
					Math.max(this.streamEnd(buffer), this.streamTarget) + RELOCATE_SECONDS
			) {
				const point = await this.media.locate(time, undefined, "webm");
				if (this.disposed) return;
				if (!point) throw new Error("Editor audio stream cannot seek");
				await this.waitForBuffer();
				if (this.disposed) return;
				// Drops any half-appended cluster from the previous run.
				if (this.source.readyState === "open") buffer.abort();
				this.needsInit = true;
				this.appendAt = point.offset;
				this.streamFrom = point.time;
				this.streamTarget = time;
			}
			const appendAt = this.appendAt;
			if (appendAt >= size) {
				await this.waitForBuffer();
				if (!this.disposed && this.source.readyState === "open") {
					this.source.endOfStream();
				}
				break;
			}
			if (this.needsInit) {
				await this.append(this.init);
				this.needsInit = false;
			}
			const response = await this.media.read(
				appendAt,
				Math.min(size, appendAt + CHUNK_BYTES),
			);
			const reader = response.body.getReader();
			const parts: Uint8Array[] = [];
			let length = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parts.push(value);
				length += value.byteLength;
			}
			if (this.disposed || this.appendAt !== appendAt) return;
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const part of parts) {
				bytes.set(part, offset);
				offset += part.byteLength;
			}
			await this.append(bytes);
			this.appendAt = appendAt + length;
			await this.evict(this.element.currentTime);
		}
	}

	private endTime() {
		return this.duration !== null && this.duration > 0
			? this.duration
			: Number.POSITIVE_INFINITY;
	}

	private async evict(time: number) {
		const buffer = this.buffer;
		if (!buffer || buffer.buffered.length === 0) return;
		const start = buffer.buffered.start(0);
		const end = buffer.buffered.end(buffer.buffered.length - 1);
		const removals: Array<[number, number]> = [];
		if (time - start > BEHIND_SECONDS * 2) {
			removals.push([start, time - BEHIND_SECONDS]);
			this.streamFrom = Math.max(this.streamFrom, time - BEHIND_SECONDS);
		}
		if (end - time > AHEAD_SECONDS * 4) {
			removals.push([time + AHEAD_SECONDS * 2, end]);
		}
		for (const [from, to] of removals) {
			await this.waitForBuffer();
			if (this.disposed) return;
			buffer.remove(from, to);
			await this.waitForBuffer();
		}
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		for (const type of ["seeking", "timeupdate", "waiting", "play"]) {
			this.element.removeEventListener(type, this.onEvent);
		}
		this.element.removeEventListener("error", this.onError);
		this.buffer?.removeEventListener("updateend", this.onEvent);
		this.buffer?.removeEventListener("error", this.onError);
		URL.revokeObjectURL(this.url);
	}
}
