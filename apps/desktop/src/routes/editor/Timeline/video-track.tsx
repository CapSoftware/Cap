import { OverlayTrack, type OverlayTrackProps } from "./style-track";

export function VideoTrack(props: OverlayTrackProps) {
	return <OverlayTrack {...props} type="video" />;
}
