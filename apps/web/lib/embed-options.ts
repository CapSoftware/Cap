export type EmbedOptions = {
	showTitle: boolean;
	showOwner: boolean;
	showBranding: boolean;
	autoplay: boolean;
	muted: boolean;
	startTime: number | null;
};

export const DEFAULT_EMBED_OPTIONS: EmbedOptions = {
	showTitle: true,
	showOwner: true,
	showBranding: true,
	autoplay: false,
	muted: false,
	startTime: null,
};

type SearchParamValue = string | string[] | undefined;
type SearchParamsInput =
	| URLSearchParams
	| Record<string, SearchParamValue>
	| null
	| undefined;

const readParam = (params: SearchParamsInput, key: string) => {
	if (!params) return undefined;
	if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
	const value = params[key];
	return Array.isArray(value) ? value[0] : value;
};

const isOff = (value: string | undefined) => value === "false" || value === "0";
const isOn = (value: string | undefined) => value === "true" || value === "1";

const parseStartTime = (value: string | undefined) => {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

// Only an explicit `false` hides something and only an explicit `true` turns
// autoplay or muting on, so embeds without params keep how they always looked.
export function parseEmbedOptions(params: SearchParamsInput): EmbedOptions {
	return {
		showTitle: !isOff(readParam(params, "title")),
		showOwner: !isOff(readParam(params, "owner")),
		showBranding: !isOff(readParam(params, "branding")),
		autoplay: isOn(readParam(params, "autoplay")),
		muted: isOn(readParam(params, "muted")),
		startTime: parseStartTime(readParam(params, "t")),
	};
}

export function buildEmbedQuery(options: Partial<EmbedOptions>): string {
	const params = new URLSearchParams();
	const startTime = options.startTime;
	if (typeof startTime === "number" && Number.isFinite(startTime)) {
		const seconds = Math.floor(startTime);
		if (seconds > 0) params.set("t", String(seconds));
	}
	if (options.autoplay) params.set("autoplay", "true");
	if (options.muted) params.set("muted", "true");
	if (options.showTitle === false) params.set("title", "false");
	if (options.showOwner === false) params.set("owner", "false");
	if (options.showBranding === false) params.set("branding", "false");
	const query = params.toString();
	return query ? `?${query}` : "";
}
