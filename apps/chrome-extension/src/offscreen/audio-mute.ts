export interface RecordingAudioContext {
	microphoneStream?: MediaStream;
	recordingStream?: MediaStream;
	streams?: MediaStream[];
}

export const setMicrophoneMuted = (
	microphoneStream: MediaStream | null | undefined,
	muted: boolean,
) => {
	if (!microphoneStream) return;
	for (const track of microphoneStream.getAudioTracks()) {
		track.enabled = !muted;
	}
};

export const resolveMicrophoneStream = (
	mode: string,
	mainStream: MediaStream,
	microphoneStream: MediaStream | null | undefined,
): MediaStream | undefined => {
	if (mode === "camera") {
		return mainStream.getAudioTracks().length > 0 ? mainStream : undefined;
	}
	return microphoneStream ?? undefined;
};

export const toggleMicrophoneMuteForRecording = (
	recording: RecordingAudioContext | null | undefined,
	muted: boolean,
) => {
	if (!recording) return;
	setMicrophoneMuted(recording.microphoneStream, muted);
};
