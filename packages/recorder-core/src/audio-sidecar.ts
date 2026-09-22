import {
	InstantRecordingUploader,
	initiateMultipartUpload,
	type RecorderApiOptions,
} from "./instant-mp4-uploader";
import {
	initialLocalRecordingState,
	type LocalRecordingState,
} from "./local-recording-backup";
import type { VideoId } from "./recorder-types";
import { selectAudioRecordingPipeline } from "./recorder-utils";
import { createRecordingSessionId, RecordingSpool } from "./recording-spool";

const RECORDING_TIMESLICE_MS = 1000;
const DATA_REQUEST_GUARD_MS = 2500;
const STOP_TIMEOUT_MS = 10_000;
const MEMORY_BACKUP_MAX_BYTES = 64 * 1024 * 1024;

export type AudioSidecarKind = "mic" | "systemAudio";

export type AudioSidecarMetadata = {
	kind: AudioSidecarKind;
	sessionId: string;
	mimeType: string;
	subpath: string;
	offsetMs: number;
	recordedBytes: number;
};

type AudioSidecarOptions = {
	kind: AudioSidecarKind;
	stream: MediaStream;
	videoId: VideoId;
	screenSubpath: string;
	api?: RecorderApiOptions;
	onFatalError: (error: Error) => void;
	onBackupFallback?: (error: Error) => void;
};

export async function uploadRecoveredAudioSidecar(options: {
	videoId: VideoId;
	source: AudioSidecarMetadata;
	blob: Blob;
	screenSubpath: string;
	durationSeconds: number;
	api?: RecorderApiOptions;
}) {
	if (
		options.blob.size !== options.source.recordedBytes ||
		options.blob.size === 0
	) {
		throw new Error("Audio source backup does not match its recording");
	}
	const api: RecorderApiOptions = {
		...options.api,
		extraBody: {
			...options.api?.extraBody,
			screenSubpath: options.screenSubpath,
			audioOffsetMs: options.source.offsetMs,
		},
	};
	const session = await initiateMultipartUpload({
		videoId: options.videoId,
		contentType: options.source.mimeType,
		subpath: options.source.subpath,
		api,
	});
	const uploader = new InstantRecordingUploader({
		videoId: options.videoId,
		uploadId: session.uploadId,
		provider: session.provider,
		mimeType: options.source.mimeType,
		subpath: options.source.subpath,
		setUploadStatus: () => undefined,
		sendProgressUpdate: async () => undefined,
		api,
	});
	await uploader.finalize({
		finalBlob: options.blob,
		durationSeconds: options.durationSeconds,
		subpath: options.source.subpath,
	});
}

export class AudioRecordingSidecar {
	private readonly recorder: MediaRecorder;
	private spool: RecordingSpool | null;
	private readonly uploader: InstantRecordingUploader;
	private readonly api: RecorderApiOptions;
	private readonly onFatalError: (error: Error) => void;
	private readonly onBackupFallback?: (error: Error) => void;
	private readonly fallbackSessionId: string;
	private readonly kind: AudioSidecarKind;
	private readonly subpath: string;
	private readonly mimeType: string;
	private captureOffsetMs = 0;
	private bytes = 0;
	private failed: Error | null = null;
	private spoolFailed = false;
	private memoryBackup: LocalRecordingState = initialLocalRecordingState();
	private stopPromise: Promise<number> | null = null;
	private dataRequestInterval: number | null = null;
	private spoolHeartbeatInterval: number | null = null;
	private lastDataAt = 0;
	private uploadCompleted = false;

	private constructor(
		options: AudioSidecarOptions,
		recorder: MediaRecorder,
		spool: RecordingSpool | null,
		uploader: InstantRecordingUploader,
		api: RecorderApiOptions,
		mimeType: string,
		subpath: string,
	) {
		this.kind = options.kind;
		this.recorder = recorder;
		this.spool = spool;
		this.spoolFailed = spool === null;
		this.uploader = uploader;
		this.api = api;
		this.onFatalError = options.onFatalError;
		this.onBackupFallback = options.onBackupFallback;
		this.fallbackSessionId = createRecordingSessionId();
		this.mimeType = mimeType;
		this.subpath = subpath;
		this.recorder.addEventListener("dataavailable", (event) => {
			this.handleChunk(event.data);
		});
		this.recorder.addEventListener("error", () => {
			this.fail(new Error(`${this.kind} audio recording failed`));
		});
	}

	static async create(options: AudioSidecarOptions) {
		const pipeline = selectAudioRecordingPipeline();
		if (!pipeline || options.stream.getAudioTracks().length === 0) {
			throw new Error(
				`No supported ${options.kind} audio recorder is available`,
			);
		}
		const subpath = `${options.kind === "mic" ? "mic" : "system-audio"}-upload.${pipeline.fileExtension}`;
		const api: RecorderApiOptions = {
			...options.api,
			extraBody: {
				...options.api?.extraBody,
				screenSubpath: options.screenSubpath,
				audioOffsetMs: 0,
			},
		};
		const spool = await RecordingSpool.create({
			mimeType: pipeline.mimeType,
		}).catch((error) => {
			options.onBackupFallback?.(
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		});
		try {
			const session = await initiateMultipartUpload({
				videoId: options.videoId,
				contentType: pipeline.mimeType,
				subpath,
				api,
			});
			const uploader = new InstantRecordingUploader({
				videoId: options.videoId,
				uploadId: session.uploadId,
				provider: session.provider,
				mimeType: pipeline.mimeType,
				subpath,
				setUploadStatus: () => undefined,
				sendProgressUpdate: async () => undefined,
				api,
				onFatalError: options.onFatalError,
			});
			try {
				const recorder = new MediaRecorder(options.stream, {
					mimeType: pipeline.mimeType,
				});
				return new AudioRecordingSidecar(
					options,
					recorder,
					spool,
					uploader,
					api,
					pipeline.mimeType,
					subpath,
				);
			} catch (error) {
				await uploader.cancel();
				throw error;
			}
		} catch (error) {
			await spool?.dispose();
			throw error;
		}
	}

	get metadata(): AudioSidecarMetadata {
		return {
			kind: this.kind,
			sessionId: this.spool?.sessionId ?? this.fallbackSessionId,
			mimeType: this.mimeType,
			subpath: this.subpath,
			offsetMs: this.captureOffsetMs,
			recordedBytes: this.bytes,
		};
	}

	get isUploadCompleted() {
		return this.uploadCompleted;
	}

	start(screenStartRequestedAt: number) {
		let audioStartRequestedAt = performance.now();
		try {
			this.recorder.start(RECORDING_TIMESLICE_MS);
		} catch {
			audioStartRequestedAt = performance.now();
			this.recorder.start();
		}
		this.captureOffsetMs = Math.round(
			audioStartRequestedAt - screenStartRequestedAt,
		);
		this.api.extraBody = {
			...this.api.extraBody,
			audioOffsetMs: this.captureOffsetMs,
		};
		this.lastDataAt = performance.now();
		this.dataRequestInterval = window.setInterval(() => {
			if (
				this.recorder.state === "recording" &&
				performance.now() - this.lastDataAt > DATA_REQUEST_GUARD_MS
			) {
				try {
					this.recorder.requestData();
				} catch (error) {
					this.fail(error instanceof Error ? error : new Error(String(error)));
				}
			}
		}, RECORDING_TIMESLICE_MS);
		if (this.spool) {
			this.spoolHeartbeatInterval = window.setInterval(() => {
				void this.spool?.touch();
			}, RECORDING_TIMESLICE_MS * 15);
		}
	}

	pause() {
		if (this.recorder.state === "recording") this.recorder.pause();
	}

	resume() {
		if (this.recorder.state === "paused") this.recorder.resume();
	}

	async stop() {
		if (this.stopPromise) return this.stopPromise;
		this.clearIntervals();
		let timeoutHandle: number | null = null;
		const recorderStop = new Promise<number>((resolve, reject) => {
			if (this.recorder.state === "inactive") {
				this.completeStop(resolve, reject);
				return;
			}
			this.recorder.addEventListener(
				"stop",
				() => this.completeStop(resolve, reject),
				{ once: true },
			);
			try {
				this.recorder.stop();
			} catch (error) {
				reject(error);
			}
		});
		const timeout = new Promise<never>((_resolve, reject) => {
			timeoutHandle = window.setTimeout(
				() => reject(new Error(`${this.kind} audio recorder did not stop`)),
				STOP_TIMEOUT_MS,
			);
		});
		this.stopPromise = Promise.race([recorderStop, timeout]).finally(() => {
			if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
		});
		return this.stopPromise;
	}

	async finalize(durationSeconds: number) {
		const recordedBytes = await this.stop();
		if (
			recordedBytes === 0 ||
			this.failed ||
			(this.spoolFailed && this.memoryBackup.overflowed)
		) {
			throw this.failed ?? new Error(`${this.kind} audio source was not saved`);
		}
		await this.uploader.finalize({
			finalBlob: null,
			durationSeconds,
			subpath: this.subpath,
		});
		this.uploadCompleted = true;
	}

	async disposeBackup() {
		await this.spool?.dispose();
		this.memoryBackup = initialLocalRecordingState();
	}

	markUploadedBackup() {
		this.spool?.markUploaded();
	}

	async prepareRetryMetadata(): Promise<AudioSidecarMetadata | null> {
		await this.stop().catch(() => undefined);
		if (this.bytes === 0) return null;
		const blob = await this.recoverBlob();
		if (!blob) return null;
		if (
			!this.spool ||
			this.spool.totalBytes !== this.bytes ||
			this.spoolFailed
		) {
			const replacement = await RecordingSpool.create({
				mimeType: this.mimeType,
				maxPendingChunkBytes: blob.size,
			}).catch(() => null);
			if (!replacement) return null;
			try {
				await replacement.appendChunk(blob);
				await replacement.flush();
			} catch {
				await replacement.dispose();
				return null;
			}
			await this.spool?.dispose();
			this.spool = replacement;
			this.spoolFailed = false;
			this.memoryBackup = initialLocalRecordingState();
		}
		return this.metadata;
	}

	async recoverBlob() {
		if (
			!this.memoryBackup.overflowed &&
			this.memoryBackup.retainedBytes === this.bytes &&
			this.memoryBackup.chunks.length > 0
		) {
			return new Blob(this.memoryBackup.chunks, { type: this.mimeType });
		}
		const spooled = await this.spool?.recoverBlob().catch(() => null);
		return spooled?.size === this.bytes ? spooled : null;
	}

	async cancel() {
		this.clearIntervals();
		if (this.recorder.state !== "inactive") {
			await this.stop().catch(() => undefined);
		}
		try {
			await this.uploader.cancel();
		} finally {
			await this.spool?.dispose();
			this.memoryBackup = initialLocalRecordingState();
		}
	}

	async abortUploadRetainSpool() {
		this.clearIntervals();
		if (this.recorder.state !== "inactive") {
			await this.stop().catch(() => undefined);
		}
		if (!this.uploadCompleted) await this.uploader.cancel();
	}

	private handleChunk(chunk: Blob) {
		if (chunk.size === 0) return;
		this.lastDataAt = performance.now();
		this.bytes += chunk.size;
		if (!this.memoryBackup.overflowed) {
			if (
				this.memoryBackup.retainedBytes + chunk.size >
				MEMORY_BACKUP_MAX_BYTES
			) {
				this.memoryBackup = {
					chunks: [],
					retainedBytes: 0,
					overflowed: true,
				};
			} else {
				this.memoryBackup.chunks.push(chunk);
				this.memoryBackup.retainedBytes += chunk.size;
			}
		}
		if (this.spoolFailed || !this.spool) {
			if (this.memoryBackup.overflowed) {
				this.fail(new Error(`${this.kind} audio backup reached its limit`));
			}
		} else {
			void this.spool.appendChunk(chunk).catch((error) => {
				this.useMemoryBackup(
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		}
		try {
			this.uploader.handleChunk(chunk, this.bytes);
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private async completeStop(
		resolve: (value: number) => void,
		reject: (error: unknown) => void,
	) {
		try {
			try {
				if (!this.spoolFailed) await this.spool?.flush();
			} catch (error) {
				this.useMemoryBackup(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			if (this.failed) throw this.failed;
			resolve(this.bytes);
		} catch (error) {
			reject(error);
		}
	}

	private fail(error: Error) {
		if (this.failed) return;
		this.failed = error;
		this.onFatalError(error);
	}

	private useMemoryBackup(error: Error) {
		if (this.spoolFailed) return;
		this.spoolFailed = true;
		this.onBackupFallback?.(error);
		if (this.memoryBackup.overflowed) {
			this.fail(new Error(`${this.kind} audio backup reached its limit`));
		}
	}

	private clearIntervals() {
		if (this.dataRequestInterval !== null) {
			window.clearInterval(this.dataRequestInterval);
			this.dataRequestInterval = null;
		}
		if (this.spoolHeartbeatInterval !== null) {
			window.clearInterval(this.spoolHeartbeatInterval);
			this.spoolHeartbeatInterval = null;
		}
	}
}
