// Seek paths clamp to the loaded duration. While early playback knows the
// recording's full length they clamp to that instead, so a seek past the
// uploaded part reaches the hold in early-playback.ts with its real target.
const fullLengths = new WeakMap<HTMLMediaElement, number>();

export function setFullLength(media: HTMLMediaElement, seconds: number | null) {
	if (seconds !== null && Number.isFinite(seconds) && seconds > 0) {
		fullLengths.set(media, seconds);
	} else {
		fullLengths.delete(media);
	}
}

export function seekLength(
	media: HTMLMediaElement | null | undefined,
	duration: number,
): number {
	const full = media ? fullLengths.get(media) : undefined;
	if (full === undefined) return duration;
	return Number.isFinite(duration) && duration > full ? duration : full;
}
