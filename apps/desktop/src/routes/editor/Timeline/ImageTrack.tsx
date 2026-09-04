import { OverlayTrack, type OverlayTrackProps } from "./StyleTrack";

export function ImageTrack(props: OverlayTrackProps) {
	return <OverlayTrack {...props} type="image" />;
}
