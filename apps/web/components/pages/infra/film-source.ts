export const FILM_EVENT = "cap:infra-film";

const FILM_FILES =
	process.env.NODE_ENV === "development" ? "/infra/film" : null;

export const FILM = {
	title: "Cap Infra, the film",
	seconds: 41,
	ratio: "3840 / 1608",
	files: FILM_FILES
		? {
				hls: `${FILM_FILES}/master.m3u8`,
				mp4: `${FILM_FILES}/film-1080.mp4`,
				poster: `${FILM_FILES}/poster.webp`,
			}
		: null,
} as const;
