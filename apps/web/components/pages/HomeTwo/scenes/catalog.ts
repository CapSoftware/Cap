export type Chapter = { start: number; end: number; pose: number };

const chapterList = (
	...spans: [duration: number, pose: number][]
): Chapter[] => {
	let cursor = 0;
	return spans.map(([duration, pose]) => {
		const start = cursor;
		cursor += duration;
		return { start, end: cursor, pose: start + pose };
	});
};

export const SCENE_META = {
	instant: {
		chapters: chapterList([6100, 4200], [5500, 4700], [6000, 5400]),
		poster: 10800,
	},
	studio: {
		chapters: chapterList([6400, 5800], [7000, 6300], [6600, 2200]),
		poster: 11800,
	},
	screenshot: {
		chapters: chapterList([6000, 4200], [6000, 4400]),
		poster: 4200,
	},
	share: {
		chapters: chapterList([7000, 6000], [7000, 6500], [6500, 5500]),
		poster: 13500,
	},
	agent: {
		chapters: chapterList([3600, 3000], [7000, 6800], [6400, 4200]),
		poster: 13800,
	},
};
