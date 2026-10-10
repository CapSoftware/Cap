import {
	InstantRecordingUploader,
	initiateMultipartUpload,
	type RecorderApiOptions,
	RecordingSpool,
	type VideoId,
} from "@cap/recorder-core";
import {
	type CapturedTabInputEvent,
	parseCapturedTabInputBatch,
} from "../shared/input-events";
import { mapTabPointerToVideo } from "./input-coordinates";
import { InputTimeline } from "./input-timeline";

const INPUT_SUBPATH = "input-events-upload.ndjson";
const INPUT_MIME_TYPE = "application/x-ndjson";
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_COLLECTORS = 1_000;

export class InputEventSidecar {
	private timeline: InputTimeline | null = null;
	private readonly nextSequenceByCollector = new Map<string, number>();
	private appendChain = Promise.resolve();
	private platform: string | null = null;
	private totalBytes = 0;
	private failed: Error | null = null;
	private uploadCompleted = false;

	private constructor(
		readonly spool: RecordingSpool,
		readonly recordingId: string,
		readonly tabId: number,
		readonly videoWidth: number,
		readonly videoHeight: number,
	) {}

	static async create(input: {
		recordingId: string;
		tabId: number;
		videoWidth: number;
		videoHeight: number;
	}) {
		const spool = await RecordingSpool.create({ mimeType: INPUT_MIME_TYPE });
		return new InputEventSidecar(
			spool,
			input.recordingId,
			input.tabId,
			input.videoWidth,
			input.videoHeight,
		);
	}

	get recordedBytes() {
		return this.totalBytes;
	}

	get isUploadCompleted() {
		return this.uploadCompleted;
	}

	start(epochMs: number) {
		this.timeline = new InputTimeline(epochMs);
	}

	pause(epochMs: number) {
		this.timeline?.pause(epochMs);
	}

	resume(epochMs: number) {
		this.timeline?.resume(epochMs);
	}

	stop(epochMs: number) {
		this.timeline?.stop(epochMs);
	}

	accept(raw: unknown, senderTabId: number | undefined) {
		const batch = parseCapturedTabInputBatch(raw);
		if (
			!batch ||
			senderTabId !== this.tabId ||
			batch.recordingId !== this.recordingId
		) {
			return Promise.reject(new Error("Tab input batch is unauthorized"));
		}
		const pending = this.appendChain.then(async () => {
			if (this.failed) throw this.failed;
			const nextSequence =
				this.nextSequenceByCollector.get(batch.collectorId) ?? 0;
			if (batch.sequence < nextSequence) return;
			if (batch.sequence !== nextSequence) {
				throw new Error("Tab input batch sequence is incomplete");
			}
			if (
				nextSequence === 0 &&
				this.nextSequenceByCollector.size >= MAX_COLLECTORS
			) {
				throw new Error("Too many tab input capture sessions");
			}
			if (this.platform && this.platform !== batch.platform) {
				throw new Error("Tab input platform changed during recording");
			}
			const mapped = batch.events.flatMap((event) => {
				const timeMs = this.timeline?.timeFor(event.epochMs) ?? null;
				if (timeMs === null) return [];
				return [
					this.mapEvent(
						event,
						timeMs,
						batch.viewportWidth,
						batch.viewportHeight,
					),
				];
			});
			const lines = [
				...(!this.platform
					? [JSON.stringify({ version: 1, platform: batch.platform })]
					: []),
				...mapped.map((event) => JSON.stringify(event)),
			];
			if (lines.length > 0) {
				const blob = new Blob([`${lines.join("\n")}\n`], {
					type: INPUT_MIME_TYPE,
				});
				if (this.totalBytes + blob.size > MAX_INPUT_BYTES) {
					throw new Error("Tab input events exceeded the supported size");
				}
				await this.spool.appendChunk(blob);
				this.totalBytes += blob.size;
			}
			this.platform ??= batch.platform;
			this.nextSequenceByCollector.set(batch.collectorId, nextSequence + 1);
		});
		this.appendChain = pending.then(
			() => undefined,
			(error: unknown) => {
				this.failed = error instanceof Error ? error : new Error(String(error));
			},
		);
		return pending;
	}

	private mapEvent(
		event: CapturedTabInputEvent,
		timeMs: number,
		viewportWidth: number,
		viewportHeight: number,
	) {
		if (!("x" in event)) {
			return {
				kind: event.kind,
				timeMs,
				key: event.key,
				code: event.code,
				modifiers: event.modifiers,
			};
		}
		const position = mapTabPointerToVideo(
			event.x,
			event.y,
			viewportWidth,
			viewportHeight,
			this.videoWidth,
			this.videoHeight,
		);
		if (!position) throw new Error("Tab input viewport is invalid");
		return {
			kind: event.kind,
			timeMs,
			x: position.x,
			y: position.y,
			cursor: event.cursor,
			button: event.button,
			modifiers: event.modifiers,
		};
	}

	async recoverBlob() {
		await this.appendChain;
		if (this.failed) throw this.failed;
		return this.spool.recoverBlob();
	}

	async upload(input: {
		videoId: VideoId;
		screenSubpath: string;
		durationSeconds: number;
		api: RecorderApiOptions;
	}) {
		const blob = await this.recoverBlob();
		if (!blob || blob.size === 0) return false;
		await uploadInputEventBlob({ ...input, blob });
		this.uploadCompleted = true;
		return true;
	}

	async dispose() {
		await this.spool.dispose();
	}
}

export async function uploadInputEventBlob(input: {
	videoId: VideoId;
	screenSubpath: string;
	durationSeconds: number;
	api: RecorderApiOptions;
	blob: Blob;
}) {
	if (
		input.blob.size < 1 ||
		input.blob.size > MAX_INPUT_BYTES ||
		input.blob.type !== INPUT_MIME_TYPE
	) {
		throw new Error("Invalid tab input event sidecar");
	}
	const api: RecorderApiOptions = {
		...input.api,
		extraBody: {
			...input.api.extraBody,
			screenSubpath: input.screenSubpath,
		},
	};
	const session = await initiateMultipartUpload({
		videoId: input.videoId,
		contentType: INPUT_MIME_TYPE,
		subpath: INPUT_SUBPATH,
		api,
	});
	const uploader = new InstantRecordingUploader({
		videoId: input.videoId,
		uploadId: session.uploadId,
		provider: session.provider,
		mimeType: INPUT_MIME_TYPE,
		subpath: INPUT_SUBPATH,
		api,
		setUploadStatus: () => undefined,
		sendProgressUpdate: async () => undefined,
	});
	await uploader.finalize({
		finalBlob: input.blob,
		durationSeconds: input.durationSeconds,
		subpath: INPUT_SUBPATH,
	});
}
