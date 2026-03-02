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
}

export async function acquireStreams(
	config: StreamConfig,
): Promise<ManagedStreams> {
	const result: ManagedStreams = {
		display: null,
		camera: null,
		microphone: null,
	};

	if (config.mode !== "camera") {
		const displayMediaOptions: DisplayMediaStreamOptions = {
			video: true,
			audio: config.systemAudio ?? false,
		};

		if (config.mode === "window") {
			(displayMediaOptions as Record<string, unknown>).preferCurrentTab = false;
		}

		result.display =
			await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
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
	}

	return result;
}

export function releaseStreams(streams: ManagedStreams) {
	for (const stream of Object.values(streams)) {
		if (stream) {
			for (const track of stream.getTracks()) {
				track.stop();
			}
		}
	}
}

export function buildCompositeStream(streams: ManagedStreams): MediaStream {
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

	return new MediaStream(tracks);
}
