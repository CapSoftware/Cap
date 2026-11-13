export const FILM_EVENT = "cap:infra-film";

export const FILM = {
	title: "Cap Infra, the film",
	ratio: "3840 / 1608",
} as const;

export const FILM_DEFAULT_BASE =
	"https://cap.so/api/developer/playback/SXxI6Fih1EaER7qbgepQyDln";

export interface FilmFiles {
	hls: string;
	mp4: string;
	poster: string;
}

export const filmFiles = (base: string | undefined): FilmFiles => {
	const root = base?.trim().replace(/\/+$/, "") || FILM_DEFAULT_BASE;
	return {
		hls: `${root}/master.m3u8`,
		mp4: `${root}/video.mp4`,
		poster: `${root}/poster.jpg`,
	};
};
