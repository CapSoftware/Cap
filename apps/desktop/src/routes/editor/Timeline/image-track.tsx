import { OverlayTrack, type OverlayTrackProps } from "./style-track";

export function ImageTrack(props: OverlayTrackProps) {
	return <OverlayTrack {...props} type="image" />;
}
