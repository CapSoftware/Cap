export interface DeveloperVideoPlayback {
	autoPlay: boolean;
	muted: boolean;
	loop: boolean;
	controls: boolean;
	startAt: number;
}

export type DeveloperVideoQuery = Record<string, string | string[] | undefined>;

const SECONDS_PATTERN = /^\d{1,6}(\.\d{1,3})?$/;

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
		startAt: seconds(query.t),
	};
}
