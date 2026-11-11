export const FILM_EVENT = "cap:infra-film";

export const FILM = {
	title: "Cap Infra, the film",
	ratio: "3840 / 1608",
} as const;

export interface FilmFiles {
	hls: string;
	mp4: string;
	poster: string;
}

export const filmFiles = (base: string | undefined): FilmFiles | null => {
	const root = base?.trim().replace(/\/+$/, "");
	if (!root) return null;
	return {
		hls: `${root}/master.m3u8`,
		mp4: `${root}/video.mp4`,
		poster: `${root}/poster.jpg`,
	};
};
