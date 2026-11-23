const HOUR_SECONDS = 60 * 60;

export const PLAYBACK_URL_EXPIRES_SECONDS = 24 * HOUR_SECONDS;
export const STREAM_URL_MIN_SECONDS = 12 * HOUR_SECONDS;
export const STREAM_URL_WINDOW_SECONDS = 6 * HOUR_SECONDS;

export type SignedUrlValidity = {
	signingDate?: Date;
	expiresIn: number;
};

export const playbackUrlValidity = (): SignedUrlValidity => ({
	expiresIn: PLAYBACK_URL_EXPIRES_SECONDS,
});

// A browser caches media under its signed URL, and a URL signed from the
// current time is new on every request, so a repeat view downloaded the media
// again. Signing from the start of a fixed window gives every request in that
// window the same URL, and the URL still works for minSeconds after the
// window ends.
export function windowedUrlValidity(
	now: number,
	minSeconds: number,
	windowSeconds: number,
): { signingDate: Date; expiresIn: number } {
	const windowMs = windowSeconds * 1000;
	return {
		signingDate: new Date(Math.floor(now / windowMs) * windowMs),
		expiresIn: windowSeconds + minSeconds,
	};
}

export const streamUrlValidity = (now: number = Date.now()) =>
	windowedUrlValidity(now, STREAM_URL_MIN_SECONDS, STREAM_URL_WINDOW_SECONDS);
