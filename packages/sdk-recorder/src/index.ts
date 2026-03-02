import { getSupportedMimeType } from "./core/mime-types";
import {
	acquireStreams,
	buildCompositeStream,
	type ManagedStreams,
	releaseStreams,
} from "./core/stream-manager";
import type {
	RecorderEventMap,
	RecorderOptions,
	RecorderPhase,
	RecordingResult,
} from "./types";
import { MultipartClient } from "./upload/multipart-client";

export type {
	RecorderOptions,
	RecorderPhase,
	RecordingResult,
	RecorderEventMap,
};

const DEFAULT_API_BASE = "https://cap.so";

type EventHandler<K extends keyof RecorderEventMap> = (
	event: RecorderEventMap[K],
) => void;

export class CapRecorder {
	private options: Required<
		Pick<RecorderOptions, "publicKey" | "apiBase" | "mode">
	> &
		RecorderOptions;
	private _phase: RecorderPhase = "idle";
	private _videoId: string | null = null;
	private _durationMs = 0;
	private recorder: MediaRecorder | null = null;
	private streams: ManagedStreams | null = null;
	private chunks: Blob[] = [];
	private durationInterval: ReturnType<typeof setInterval> | null = null;
	private accumulatedMs = 0;
	private lastResumeTime = 0;
	private selectedMimeType = "";
	private client: MultipartClient;
	private listeners = new Map<
		string,
		Set<EventHandler<keyof RecorderEventMap>>
	>();

	constructor(options: RecorderOptions) {
		this.options = {
			apiBase: DEFAULT_API_BASE,
			mode: "fullscreen",
			...options,
		};
		this.client = new MultipartClient(
			this.options.apiBase,
			this.options.publicKey,
		);
	}

	get phase(): RecorderPhase {
		return this._phase;
	}

	get videoId(): string | null {
		return this._videoId;
	}

	get durationMs(): number {
		return this._durationMs;
	}

	on<K extends keyof RecorderEventMap>(
		event: K,
		handler: EventHandler<K>,
	): () => void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		const set = this.listeners.get(event);
		if (set) set.add(handler as EventHandler<keyof RecorderEventMap>);
		return () => {
			this.listeners.get(event)?.delete(handler);
		};
	}

	private emit<K extends keyof RecorderEventMap>(
		event: K,
		data: RecorderEventMap[K],
	) {
		const handlers = this.listeners.get(event);
		if (handlers) {
			for (const handler of handlers) {
				try {
					handler(data);
				} catch (err) {
					console.error(`CapRecorder: error in "${event}" handler:`, err);
				}
			}
		}
	}

	private setPhase(phase: RecorderPhase) {
		this._phase = phase;
		this.emit("phasechange", { phase });
	}

	async start(): Promise<void> {
		if (this._phase !== "idle") {
			throw new Error(`Cannot start from phase "${this._phase}"`);
		}

		try {
			this.setPhase("requesting-permission");

			this.streams = await acquireStreams({
				mode: this.options.mode,
				camera: this.options.camera,
				microphone: this.options.microphone,
				systemAudio: this.options.systemAudio,
			});

			const composite = buildCompositeStream(this.streams);
			if (composite.getTracks().length === 0) {
				throw new Error("No media tracks available");
			}

			const mimeType = getSupportedMimeType();
			this.selectedMimeType = mimeType;
			this.recorder = new MediaRecorder(composite, {
				mimeType: mimeType || undefined,
			});

			this.chunks = [];
			this.recorder.ondataavailable = (e) => {
				if (e.data.size > 0) {
					this.chunks.push(e.data);
				}
			};

			if (this.streams.display) {
				const videoTrack = this.streams.display.getVideoTracks()[0];
				if (videoTrack) {
					videoTrack.onended = () => {
						this.stop();
					};
				}
			}

			this.recorder.start(1000);
			this.accumulatedMs = 0;
			this.lastResumeTime = Date.now();
			this.startDurationTimer();
			this.setPhase("recording");
		} catch (error) {
			this.setPhase("error");
			this.emit("error", {
				error: error instanceof Error ? error : new Error(String(error)),
			});
			this.cleanup();
			throw error;
		}
	}

	pause(): void {
		if (this._phase !== "recording" || !this.recorder) return;
		this.accumulatedMs += Date.now() - this.lastResumeTime;
		this.recorder.pause();
		this.stopDurationTimer();
		this.setPhase("paused");
	}

	resume(): void {
		if (this._phase !== "paused" || !this.recorder) return;
		this.recorder.resume();
		this.lastResumeTime = Date.now();
		this.startDurationTimer();
		this.setPhase("recording");
	}

	async stop(): Promise<RecordingResult> {
		if (
			(this._phase !== "recording" && this._phase !== "paused") ||
			!this.recorder
		) {
			throw new Error(`Cannot stop from phase "${this._phase}"`);
		}

		this.setPhase("stopping");
		this.stopDurationTimer();

		const recorder = this.recorder;
		return new Promise((resolve, reject) => {
			recorder.onstop = async () => {
				try {
					const result = await this.uploadRecording();
					resolve(result);
				} catch (err) {
					reject(err);
				}
			};
			recorder.stop();
		});
	}

	destroy(): void {
		if (this.recorder && this.recorder.state !== "inactive") {
			this.recorder.stop();
		}
		this.cleanup();
		this.setPhase("idle");
	}

	private async uploadRecording(): Promise<RecordingResult> {
		this.setPhase("uploading");

		try {
			const blob = new Blob(this.chunks, {
				type: this.selectedMimeType || "video/webm",
			});

			const { videoId, shareUrl, embedUrl } = await this.client.createVideo({
				userId: this.options.userId,
			});

			this._videoId = videoId;

			await this.client.uploadBlob(videoId, blob);

			const result: RecordingResult = {
				videoId,
				shareUrl,
				embedUrl,
			};

			this.setPhase("complete");
			this.emit("complete", result);
			this.cleanup();

			return result;
		} catch (error) {
			this.setPhase("error");
			const err = error instanceof Error ? error : new Error(String(error));
			this.emit("error", { error: err });
			this.cleanup();
			throw err;
		}
	}

	private startDurationTimer() {
		this.durationInterval = setInterval(() => {
			this._durationMs =
				this.accumulatedMs + (Date.now() - this.lastResumeTime);
			this.emit("durationchange", { durationMs: this._durationMs });
		}, 100);
	}

	private stopDurationTimer() {
		if (this.durationInterval) {
			clearInterval(this.durationInterval);
			this.durationInterval = null;
		}
	}

	private cleanup() {
		this.stopDurationTimer();
		if (this.streams) {
			releaseStreams(this.streams);
			this.streams = null;
		}
		this.recorder = null;
		this.chunks = [];
	}
}
