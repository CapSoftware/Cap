import type { CSSProperties } from "react";
import { normalizeHexColor } from "@/lib/share-call-to-action";

export const PLAYER_BRAND_INK = "#111113";
export const PLAYER_BRAND_WHITE = "#FFFFFF";

/**
 * The player's controls sit on a dark scrim over the video. Below this
 * contrast against black a coloured progress bar or focus ring disappears, so
 * those keep Cap's white instead (WCAG 2.2 non-text contrast is 3:1).
 */
export const MIN_CONTROL_CONTRAST = 3;

export type PlayerBrand = {
	color: string;
	foreground: typeof PLAYER_BRAND_INK | typeof PLAYER_BRAND_WHITE;
	hover: string;
	accent: string | null;
};

const channelToLinear = (channel: number) => {
	const value = channel / 255;
	return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const hexToRgb = (hex: string) => {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff] as const;
};

export function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex);
	return (
		0.2126 * channelToLinear(r) +
		0.7152 * channelToLinear(g) +
		0.0722 * channelToLinear(b)
	);
}

export function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [light, dark] = la > lb ? [la, lb] : [lb, la];
	return (light + 0.05) / (dark + 0.05);
}

const mixHex = (hex: string, target: number, amount: number) => {
	const toHex = (channel: number) =>
		Math.round(channel + (target - channel) * amount)
			.toString(16)
			.padStart(2, "0");
	const [r, g, b] = hexToRgb(hex);
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
};

export function resolvePlayerBrand(input: unknown): PlayerBrand | null {
	const color = normalizeHexColor(input);
	if (!color) return null;
	const foreground =
		contrastRatio(color, PLAYER_BRAND_WHITE) >=
		contrastRatio(color, PLAYER_BRAND_INK)
			? PLAYER_BRAND_WHITE
			: PLAYER_BRAND_INK;
	return {
		color,
		foreground,
		hover:
			foreground === PLAYER_BRAND_WHITE
				? mixHex(color, 0, 0.12)
				: mixHex(color, 255, 0.12),
		accent:
			contrastRatio(color, "#000000") >= MIN_CONTROL_CONTRAST ? color : null,
	};
}

function hexToHslComponents(hex: string) {
	const [r, g, b] = hexToRgb(hex).map((channel) => channel / 255) as [
		number,
		number,
		number,
	];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const lightness = (max + min) / 2;
	const delta = max - min;
	if (delta === 0) return `0 0% ${Math.round(lightness * 1000) / 10}%`;
	const saturation = delta / (1 - Math.abs(2 * lightness - 1));
	const hue =
		max === r
			? ((g - b) / delta) % 6
			: max === g
				? (b - r) / delta + 2
				: (r - g) / delta + 4;
	const degrees = Math.round(((hue * 60 + 360) % 360) * 10) / 10;
	return `${degrees} ${Math.round(saturation * 1000) / 10}% ${Math.round(lightness * 1000) / 10}%`;
}

/**
 * Props for the element that wraps a branded player. The CSS in
 * `globals.css` keys off `data-player-brand`, so pages without a brand render
 * exactly the classes they always have.
 */
export function playerBrandAttributes(brand: PlayerBrand | null): {
	"data-player-brand"?: "";
	"data-player-brand-accent"?: "";
	style?: CSSProperties;
} {
	if (!brand) return {};
	const style: Record<string, string> = {
		"--player-brand": brand.color,
		"--player-brand-hover": brand.hover,
		"--player-brand-foreground": brand.foreground,
	};
	if (brand.accent) {
		style["--player-brand-accent"] = brand.accent;
		style["--player-brand-ring"] = hexToHslComponents(brand.accent);
	}
	return {
		"data-player-brand": "",
		...(brand.accent ? { "data-player-brand-accent": "" as const } : {}),
		style: style as CSSProperties,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function playerColorFromOrganizationMetadata(
	metadata: unknown,
): string | null {
	if (!isRecord(metadata) || !isRecord(metadata.branding)) return null;
	return normalizeHexColor(metadata.branding.playerColor);
}

export function getPlayerBrand({
	ownerIsPro,
	organizationMetadata,
}: {
	ownerIsPro: boolean;
	organizationMetadata: unknown;
}): PlayerBrand | null {
	if (!ownerIsPro) return null;
	return resolvePlayerBrand(
		playerColorFromOrganizationMetadata(organizationMetadata),
	);
}
