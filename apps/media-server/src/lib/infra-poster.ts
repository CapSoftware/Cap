import type { ThumbnailOptions } from "./media-video";

export const INFRA_POSTER_MAX_DIMENSION = 1920;

export const INFRA_POSTER_OPTIONS: ThumbnailOptions = {
	width: INFRA_POSTER_MAX_DIMENSION,
	height: INFRA_POSTER_MAX_DIMENSION,
};

// Cap Infra posters are shown at the player's full size, so they are kept up
// to 1920 on the long side. Every other job keeps the default thumbnail size.
export function posterThumbnailOptions(
	infra: boolean | undefined,
): ThumbnailOptions {
	return infra === true ? INFRA_POSTER_OPTIONS : {};
}
