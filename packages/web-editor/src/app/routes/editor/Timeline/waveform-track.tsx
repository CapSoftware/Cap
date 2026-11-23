import { OverlayTrack, type OverlayTrackProps } from "./style-track";

export function WaveformTrack(props: OverlayTrackProps) {
	return <OverlayTrack {...props} type="waveform" />;
}
