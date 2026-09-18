import {
	acquireCameraStream,
	acquireDisplayStream,
	acquireMicStream,
	createAudioMixer,
} from "@cap/recorder-core/capture-streams";
import { selectRecordingPipelineFromSupport } from "@cap/recorder-core/recorder-utils";
import { RecordingSpool } from "@cap/recorder-core/recording-spool";

export type EditorClipCapture = {
	display: File;
	camera: File | null;
	cameraOffsetMs: number;
};

export type EditorClipCaptureOptions = {
	cameraEnabled: boolean;
	micEnabled: boolean;
	systemAudioEnabled: boolean;
	onDisplayEnded?: () => void;
	onError?: (error: Error) => void;
};

export type EditorClipCaptureSession = {
	cameraPreviewStream: MediaStream | null;
	stop: () => Promise<EditorClipCapture>;
	recover: () => Promise<EditorClipCapture | null>;
	pause: () => void;
	resume: () => void;
	discard: () => Promise<void>;
	release: () => Promise<void>;
};

function recordingFormat(hasAudio: boolean) {
	const pipeline = selectRecordingPipelineFromSupport(hasAudio, (candidate) =>
		MediaRecorder.isTypeSupported(candidate),
	);
	if (!pipeline) throw new Error("This browser cannot record an editor clip");
	return pipeline;
}

function stoppedRecorder(recorder: MediaRecorder) {
	return new Promise<void>((resolve) => {
		recorder.addEventListener("stop", () => resolve(), { once: true });
	});
}

async function stopActiveRecorder(recorder: MediaRecorder | null) {
	if (!recorder || recorder.state === "inactive") return;
	await new Promise<void>((resolve) => {
		recorder.addEventListener("stop", () => resolve(), { once: true });
		try {
			recorder.stop();
		} catch {
			resolve();
		}
	});
}

function capturedFile(blob: Blob | null, role: "screen" | "camera") {
	if (!blob || blob.size < 1)
		throw new Error(
			`${role === "screen" ? "Screen" : "Camera"} recording is empty`,
		);
	const type = blob.type.split(";")[0] ?? "";
	const extension = type === "video/mp4" ? "mp4" : "webm";
	return new File(
		[blob],
		`editor-clip-${crypto.randomUUID()}-${role}.${extension}`,
		{
			type: type === "video/mp4" ? "video/mp4" : "video/webm",
		},
	);
}

export async function startEditorClipCapture(
	options: EditorClipCaptureOptions,
): Promise<EditorClipCaptureSession> {
	if (
		typeof MediaRecorder === "undefined" ||
		!navigator.mediaDevices?.getDisplayMedia ||
		!navigator.mediaDevices?.getUserMedia
	) {
		throw new Error("This browser cannot capture a new editor clip");
	}
	let displayStream: MediaStream | null = null;
	let cameraStream: MediaStream | null = null;
	let micStream: MediaStream | null = null;
	let mixer: Awaited<ReturnType<typeof createAudioMixer>> | null = null;
	let displaySpool: RecordingSpool | null = null;
	let cameraSpool: RecordingSpool | null = null;
	let activeDisplayRecorder: MediaRecorder | null = null;
	let activeCameraRecorder: MediaRecorder | null = null;
	try {
		displayStream = await acquireDisplayStream({
			systemAudioEnabled: options.systemAudioEnabled,
		});
		const displayTrack = displayStream.getVideoTracks()[0];
		if (!displayTrack) throw new Error("Screen picker returned no video track");
		if (options.cameraEnabled) cameraStream = await acquireCameraStream();
		if (options.micEnabled) micStream = await acquireMicStream();
		if (displayTrack.readyState !== "live")
			throw new Error("Screen sharing ended before recording started");
		if (cameraStream?.getVideoTracks()[0]?.readyState === "ended")
			throw new Error("Camera ended before recording started");
		const systemAudioTracks = options.systemAudioEnabled
			? displayStream.getAudioTracks()
			: [];
		if (systemAudioTracks.length > 0 || micStream) {
			mixer = await createAudioMixer({ systemAudioTracks, micStream });
		}
		const displayInput = new MediaStream([
			displayTrack,
			...(mixer?.stream.getAudioTracks() ?? []),
		]);
		const displayFormat = recordingFormat(
			displayInput.getAudioTracks().length > 0,
		);
		const cameraFormat = cameraStream ? recordingFormat(false) : null;
		displaySpool = await RecordingSpool.create({
			mimeType: displayFormat.mimeType,
			sessionId: `editor-screen-${crypto.randomUUID()}`,
		});
		if (cameraFormat) {
			cameraSpool = await RecordingSpool.create({
				mimeType: cameraFormat.mimeType,
				sessionId: `editor-camera-${crypto.randomUUID()}`,
			});
		}
		const displayRecorder = new MediaRecorder(displayInput, {
			mimeType: displayFormat.mimeType,
		});
		const cameraRecorder =
			cameraStream && cameraFormat
				? new MediaRecorder(cameraStream, { mimeType: cameraFormat.mimeType })
				: null;
		activeDisplayRecorder = displayRecorder;
		activeCameraRecorder = cameraRecorder;
		const screenSpool = displaySpool;
		const sidecarSpool = cameraSpool;
		let recordingError: Error | null = null;
		let displayStartedAt = performance.now();
		let cameraStartedAt = displayStartedAt;
		const recordError = (error: Error) => {
			if (recordingError) return;
			recordingError = error;
			options.onError?.(error);
		};
		const append = (spool: RecordingSpool, event: BlobEvent) => {
			if (event.data.size < 1) return;
			void spool.appendChunk(event.data).catch(recordError);
		};
		displayRecorder.addEventListener("dataavailable", (event) =>
			append(screenSpool, event),
		);
		cameraRecorder?.addEventListener("dataavailable", (event) => {
			if (sidecarSpool) append(sidecarSpool, event);
		});
		const displayStopped = stoppedRecorder(displayRecorder);
		const cameraStopped = cameraRecorder
			? stoppedRecorder(cameraRecorder)
			: Promise.resolve();
		displayRecorder.addEventListener("start", () => {
			displayStartedAt = performance.now();
		});
		cameraRecorder?.addEventListener("start", () => {
			cameraStartedAt = performance.now();
		});
		let stopPromise: Promise<EditorClipCapture> | null = null;
		let released = false;
		let captureStarted = false;
		const closeCapture = async () => {
			for (const stream of [displayStream, cameraStream, micStream]) {
				for (const track of stream?.getTracks() ?? []) track.stop();
			}
			await mixer?.close();
		};
		const release = async () => {
			if (released) return;
			released = true;
			await Promise.all([screenSpool.dispose(), sidecarSpool?.dispose()]);
		};
		const stop = () => {
			stopPromise ??= (async () => {
				try {
					for (const recorder of [displayRecorder, cameraRecorder]) {
						if (recorder && recorder.state !== "inactive") recorder.stop();
					}
					await Promise.all([displayStopped, cameraStopped]);
					await Promise.all([screenSpool.flush(), sidecarSpool?.flush()]);
					if (recordingError) throw recordingError;
					const displayBlob = await screenSpool.toBlob();
					const cameraBlob = sidecarSpool ? await sidecarSpool.toBlob() : null;
					return {
						display: capturedFile(displayBlob, "screen"),
						camera: sidecarSpool ? capturedFile(cameraBlob, "camera") : null,
						cameraOffsetMs: cameraRecorder
							? Math.round(cameraStartedAt - displayStartedAt)
							: 0,
					};
				} finally {
					await closeCapture();
				}
			})();
			return stopPromise;
		};
		const recover = async () => {
			await stop().catch(() => undefined);
			const [displayBlob, cameraBlob] = await Promise.all([
				screenSpool.recoverBlob(),
				sidecarSpool?.recoverBlob() ?? Promise.resolve(null),
			]);
			if (!displayBlob || displayBlob.size < 1) return null;
			return {
				display: capturedFile(displayBlob, "screen"),
				camera:
					cameraBlob && cameraBlob.size > 0
						? capturedFile(cameraBlob, "camera")
						: null,
				cameraOffsetMs: cameraRecorder
					? Math.round(cameraStartedAt - displayStartedAt)
					: 0,
			};
		};
		const discard = async () => {
			await stop().catch(() => undefined);
			await release();
		};
		const pause = () => {
			for (const recorder of [displayRecorder, cameraRecorder]) {
				if (recorder?.state === "recording") recorder.pause();
			}
		};
		const resume = () => {
			for (const recorder of [displayRecorder, cameraRecorder]) {
				if (recorder?.state === "paused") recorder.resume();
			}
		};
		const recordingFailed = (event: Event) => {
			const error =
				"error" in event && event.error instanceof Error
					? event.error
					: new Error("Browser media recording failed");
			recordError(error);
			if (captureStarted) void stop().catch(() => undefined);
		};
		displayRecorder.addEventListener("error", recordingFailed, { once: true });
		cameraRecorder?.addEventListener("error", recordingFailed, { once: true });
		displayTrack.addEventListener(
			"ended",
			() => {
				if (captureStarted) void stop().catch(() => undefined);
				options.onDisplayEnded?.();
			},
			{ once: true },
		);
		displayRecorder.start(1000);
		cameraRecorder?.start(1000);
		captureStarted = true;
		if (displayTrack.readyState !== "live")
			throw new Error("Screen sharing ended before recording started");
		if (recordingError) throw recordingError;
		return {
			cameraPreviewStream: cameraStream,
			stop,
			recover,
			pause,
			resume,
			discard,
			release,
		};
	} catch (error) {
		await Promise.all([
			stopActiveRecorder(activeDisplayRecorder),
			stopActiveRecorder(activeCameraRecorder),
		]);
		for (const stream of [displayStream, cameraStream, micStream]) {
			for (const track of stream?.getTracks() ?? []) track.stop();
		}
		await mixer?.close();
		await Promise.all([displaySpool?.dispose(), cameraSpool?.dispose()]);
		throw error;
	}
}
