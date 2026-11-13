export interface DeveloperVideoPlayback {
	autoPlay: boolean;
	muted: boolean;
	loop: boolean;
	controls: boolean;
	captions: boolean;
	startAt: number;
	accentColor: string | null;
	radius: number;
	maxQuality: number | null;
	poster: boolean;
	keyboard: boolean;
	events: boolean;
	qualityMenu: boolean;
	speedMenu: boolean;
	pip: boolean;
	fullscreen: boolean;
}

export type DeveloperVideoQuery = Record<string, string | string[] | undefined>;

const SECONDS_PATTERN = /^\d{1,6}(\.\d{1,3})?$/;
const HEX_COLOR_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RADIUS_PATTERN = /^\d{1,2}$/;
const QUALITY_PATTERN = /^(\d{3,4})p?$/i;
const MAX_EMBED_RADIUS = 24;
const LOWEST_QUALITY = 144;
const HIGHEST_QUALITY = 4320;

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

const flag = (value: string | string[] | undefined, fallback: boolean) => {
	const text = first(value);
	if (text === "1" || text === "true") return true;
	if (text === "0" || text === "false") return false;
	return fallback;
};

const seconds = (value: string | string[] | undefined) => {
	const text = first(value);
	return text && SECONDS_PATTERN.test(text) ? Number(text) : 0;
};

export const embedAccentColor = (value: string | string[] | undefined) => {
	const hex = HEX_COLOR_PATTERN.exec(first(value) ?? "")?.[1]?.toLowerCase();
	if (!hex) return null;
	return hex.length === 3
		? `#${[...hex].map((digit) => digit + digit).join("")}`
		: `#${hex}`;
};

const cornerRadius = (value: string | string[] | undefined) => {
	const text = first(value);
	if (!text || !RADIUS_PATTERN.test(text)) return 0;
	return Math.min(MAX_EMBED_RADIUS, Number(text));
};

const qualityCap = (value: string | string[] | undefined) => {
	const height = Number(QUALITY_PATTERN.exec(first(value) ?? "")?.[1]);
	return height >= LOWEST_QUALITY && height <= HIGHEST_QUALITY ? height : null;
};

export function developerVideoPlayback(
	query: DeveloperVideoQuery,
	variant: "share" | "embed",
): DeveloperVideoPlayback {
	const embed = variant === "embed";
	return {
		autoPlay: embed && flag(query.autoplay, false),
		muted: embed && flag(query.muted, false),
		loop: embed && flag(query.loop, false),
		controls: !embed || flag(query.controls, true),
		captions: embed && flag(query.captions, false),
		startAt: seconds(query.t),
		accentColor: embed ? embedAccentColor(query.color) : null,
		radius: embed ? cornerRadius(query.radius) : 0,
		maxQuality: embed ? qualityCap(query.quality) : null,
		poster: !embed || flag(query.poster, true),
		keyboard: !embed || flag(query.keyboard, true),
		events: embed,
		qualityMenu: !embed || flag(query.quality_menu, true),
		speedMenu: !embed || flag(query.speed_menu, true),
		pip: !embed || flag(query.pip, true),
		fullscreen: !embed || flag(query.fullscreen, true),
	};
}

// Asks the playback route for a master playlist that lists no rendition
// taller than the cap, so hls.js and Safari's own player both keep under it.
export function cappedPlaylistUrl(hls: string, maxQuality: number | null) {
	if (maxQuality === null) return hls;
	try {
		const url = new URL(hls);
		url.searchParams.set("max", String(maxQuality));
		return url.toString();
	} catch {
		return hls;
	}
}
