import type { RecordingMode } from "../types";

export interface StreamConfig {
	mode: RecordingMode;
	camera?: { deviceId?: string; enabled?: boolean };
	microphone?: { deviceId?: string; enabled?: boolean };
	systemAudio?: boolean;
}

export interface ManagedStreams {
	display: MediaStream | null;
	camera: MediaStream | null;
	microphone: MediaStream | null;
	audioMix?: { context: AudioContext; stream: MediaStream };
}

export async function acquireStreams(
	config: StreamConfig,
	signal: AbortSignal,
): Promise<ManagedStreams> {
	const result: ManagedStreams = {
		display: null,
		camera: null,
		microphone: null,
	};

	signal.throwIfAborted();
	const onAbort = () => releaseStreams(result);
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		if (config.mode !== "camera") {
			const displayMediaOptions: DisplayMediaStreamOptions = {
				video: true,
				audio: config.systemAudio ?? false,
			};

			if (config.mode === "window") {
				(displayMediaOptions as Record<string, unknown>).preferCurrentTab =
					false;
			}

			result.display =
				await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
			signal.throwIfAborted();
		}

		if (config.camera?.enabled !== false) {
			const constraints: MediaStreamConstraints = {
				video: config.camera?.deviceId
					? { deviceId: { exact: config.camera.deviceId } }
					: true,
				audio: false,
			};
			try {
				result.camera = await navigator.mediaDevices.getUserMedia(constraints);
			} catch {
				result.camera = null;
			}
			signal.throwIfAborted();
		}

		if (config.microphone?.enabled !== false) {
			const constraints: MediaStreamConstraints = {
				video: false,
				audio: config.microphone?.deviceId
					? { deviceId: { exact: config.microphone.deviceId } }
					: true,
			};
			try {
				result.microphone =
					await navigator.mediaDevices.getUserMedia(constraints);
			} catch {
				result.microphone = null;
			}
			signal.throwIfAborted();
		}

		return result;
	} catch (error) {
		releaseStreams(result);
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export function releaseStreams(streams: ManagedStreams) {
	const { audioMix } = streams;
	for (const stream of [
		streams.display,
		streams.camera,
		streams.microphone,
		audioMix?.stream,
	]) {
		if (stream) {
			for (const track of stream.getTracks()) {
				track.stop();
			}
		}
	}
	if (audioMix) {
		void audioMix.context.close().catch((error) => {
			console.error("CapRecorder: failed to close audio mixer:", error);
		});
		streams.audioMix = undefined;
	}
}

export async function buildCompositeStream(
	streams: ManagedStreams,
): Promise<MediaStream> {
	const tracks: MediaStreamTrack[] = [];

	if (streams.display) {
		for (const track of streams.display.getVideoTracks()) {
			tracks.push(track);
		}
		for (const track of streams.display.getAudioTracks()) {
			tracks.push(track);
		}
	}

	if (streams.camera && !streams.display) {
		for (const track of streams.camera.getVideoTracks()) {
			tracks.push(track);
		}
	}

	if (streams.microphone) {
		for (const track of streams.microphone.getAudioTracks()) {
			tracks.push(track);
		}
	}

	const audioTracks = tracks.filter((track) => track.kind === "audio");
	if (audioTracks.length <= 1) return new MediaStream(tracks);

	const context = new AudioContext();
	const destination = context.createMediaStreamDestination();
	streams.audioMix = { context, stream: destination.stream };
	const mix = context.createGain();
	mix.gain.value = 1 / audioTracks.length;
	mix.connect(destination);
	for (const track of audioTracks) {
		context.createMediaStreamSource(new MediaStream([track])).connect(mix);
	}
	let startupTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			context.resume(),
			new Promise<never>((_, reject) => {
				startupTimeout = setTimeout(() => {
					reject(
						new Error(
							"Recording audio startup timed out. Check your audio device and try again.",
						),
					);
				}, 10_000);
			}),
		]);
	} finally {
		clearTimeout(startupTimeout);
	}

	return new MediaStream([
		...tracks.filter((track) => track.kind !== "audio"),
		...destination.stream.getAudioTracks(),
	]);
}
