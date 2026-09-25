import type { VideoCallToAction } from "@cap/database/types";

export const CTA_LABEL_MAX_LENGTH = 40;
export const CTA_HEADLINE_MAX_LENGTH = 80;
export const CTA_URL_MAX_LENGTH = 2048;

export const CORNER_CARD_DELAY_SECONDS = 3;
export const CORNER_CARD_MIN_WIDTH = 640;
export const CORNER_CARD_MIN_HEIGHT = 300;

export const CTA_COLOR_PRESETS = [
	{ name: "Blue", value: "#2F6BFF" },
	{ name: "Ink", value: "#111113" },
	{ name: "Green", value: "#12A150" },
	{ name: "Violet", value: "#7A4DFF" },
	{ name: "Pink", value: "#E5337A" },
	{ name: "Orange", value: "#F26B1D" },
] as const;

export const DEFAULT_CTA_COLOR = CTA_COLOR_PRESETS[0].value;

export const CTA_LABEL_SUGGESTIONS = [
	"Book a call",
	"Try it free",
	"Learn more",
	"Get started",
	"Reply to me",
] as const;

export type ShareCallToAction = {
	label: string;
	url: string;
	headline: string | null;
	color: string;
	showWhilePlaying: boolean;
};

export type CallToActionInput = {
	label: string;
	url: string;
	headline?: string | null;
	color?: string | null;
	showWhilePlaying?: boolean;
};

export type CallToActionErrors = Partial<
	Record<"label" | "url" | "headline", string>
>;

export type CallToActionValidation =
	| { ok: true; value: ShareCallToAction }
	| { ok: false; errors: CallToActionErrors };

const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

const safeDecode = (value: string) => {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
};

export function normalizeCallToActionUrl(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed || /\s/.test(trimmed)) return null;

	const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}

	if (url.protocol === "mailto:") {
		const address = safeDecode(url.pathname);
		if (!address || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
			return null;
		}
	} else if (url.protocol === "http:" || url.protocol === "https:") {
		if (url.username || url.password) return null;
		const host = url.hostname;
		if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
			return null;
		}
	} else {
		return null;
	}

	const normalized = url.toString();
	return normalized.length > CTA_URL_MAX_LENGTH ? null : normalized;
}

export function normalizeHexColor(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
	if (!match?.[1]) return null;
	const hex =
		match[1].length === 3
			? match[1]
					.split("")
					.map((char) => char + char)
					.join("")
			: match[1];
	return `#${hex.toUpperCase()}`;
}

export function validateCallToAction(
	input: CallToActionInput,
): CallToActionValidation {
	const errors: CallToActionErrors = {};

	const label = collapseWhitespace(input.label ?? "");
	if (!label) errors.label = "Add the text for your button";
	else if (label.length > CTA_LABEL_MAX_LENGTH)
		errors.label = `Keep it under ${CTA_LABEL_MAX_LENGTH} characters`;

	const url = (input.url ?? "").trim();
	const normalizedUrl = url ? normalizeCallToActionUrl(url) : null;
	if (!url) errors.url = "Add where the button should go";
	else if (!normalizedUrl) errors.url = "Enter a valid link, like cap.so/demo";

	const headline = collapseWhitespace(input.headline ?? "");
	if (headline.length > CTA_HEADLINE_MAX_LENGTH)
		errors.headline = `Keep it under ${CTA_HEADLINE_MAX_LENGTH} characters`;

	if (Object.keys(errors).length > 0 || !normalizedUrl) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		value: {
			label,
			url: normalizedUrl,
			headline: headline || null,
			color: normalizeHexColor(input.color) ?? DEFAULT_CTA_COLOR,
			showWhilePlaying: input.showWhilePlaying ?? true,
		},
	};
}

export function toStoredCallToAction(
	value: ShareCallToAction,
): VideoCallToAction {
	return {
		label: value.label,
		url: value.url,
		...(value.headline ? { headline: value.headline } : {}),
		color: value.color,
		showWhilePlaying: value.showWhilePlaying,
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function parseShareCallToAction(
	settings: unknown,
): ShareCallToAction | null {
	if (!isRecord(settings)) return null;
	const stored = settings.callToAction;
	if (!isRecord(stored)) return null;
	if (typeof stored.label !== "string" || typeof stored.url !== "string") {
		return null;
	}

	const result = validateCallToAction({
		label: stored.label,
		url: stored.url,
		headline: typeof stored.headline === "string" ? stored.headline : null,
		color: typeof stored.color === "string" ? stored.color : null,
		showWhilePlaying:
			typeof stored.showWhilePlaying === "boolean"
				? stored.showWhilePlaying
				: undefined,
	});
	return result.ok ? result.value : null;
}

const channelToLinear = (channel: number) => {
	const value = channel / 255;
	return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (hex: string) => {
	const value = Number.parseInt(hex.slice(1), 16);
	const r = channelToLinear((value >> 16) & 0xff);
	const g = channelToLinear((value >> 8) & 0xff);
	const b = channelToLinear(value & 0xff);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function readableTextColor(color: string): "#FFFFFF" | "#111113" {
	const hex = normalizeHexColor(color) ?? DEFAULT_CTA_COLOR;
	const luminance = relativeLuminance(hex);
	const contrastWithWhite = 1.05 / (luminance + 0.05);
	const contrastWithInk = (luminance + 0.05) / 0.0555;
	return contrastWithWhite >= contrastWithInk ? "#FFFFFF" : "#111113";
}

export function callToActionDestinationLabel(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "mailto:") {
			return decodeURIComponent(parsed.pathname);
		}
		return parsed.hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

export function shouldShowCornerCard({
	cta,
	width,
	height,
	dismissed,
	pastIntro,
	ended,
}: {
	cta: ShareCallToAction;
	width: number;
	height: number;
	dismissed: boolean;
	pastIntro: boolean;
	ended: boolean;
}) {
	return (
		cta.showWhilePlaying &&
		!dismissed &&
		!ended &&
		pastIntro &&
		width >= CORNER_CARD_MIN_WIDTH &&
		height >= CORNER_CARD_MIN_HEIGHT
	);
}
