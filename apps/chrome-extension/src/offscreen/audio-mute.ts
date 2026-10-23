export const setMicrophoneMuted = (
	microphoneStream: MediaStream | null | undefined,
	muted: boolean,
) => {
	if (!microphoneStream) return;
	for (const track of microphoneStream.getAudioTracks()) {
		track.enabled = !muted;
	}
};
