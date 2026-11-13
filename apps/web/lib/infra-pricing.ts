export const INFRA_RESOLUTION_TIERS = ["1080p", "1440p", "2160p"] as const;

export type InfraResolutionTier = (typeof INFRA_RESOLUTION_TIERS)[number];

export const INFRA_TIER_MAX_PIXELS: Record<InfraResolutionTier, number> = {
	"1080p": 2_073_600,
	"1440p": 4_194_304,
	"2160p": 8_294_400,
};

export const INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH: Record<
	InfraResolutionTier,
	number
> = {
	"1080p": 0.85,
	"1440p": 1.45,
	"2160p": 2.8,
};

export const INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES = 0.95;

export const INFRA_DELIVERY_PRICE_UNIT = "per 1,000 delivered minutes";

export const INFRA_DELIVERY_PRICE = `$${INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES.toFixed(2)}`;

export const INFRA_DELIVERY_BILLED_FROM = "2026-11-14";

const billedFromDay = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric",
	timeZone: "UTC",
}).format(new Date(`${INFRA_DELIVERY_BILLED_FROM}T00:00:00Z`));

export const INFRA_DELIVERY_BILLED_FROM_TEXT = `Delivery is billed from ${billedFromDay}. Earlier days are not charged.`;

export const INFRA_DELIVERY_PRICE_TEXT = `${INFRA_DELIVERY_PRICE} ${INFRA_DELIVERY_PRICE_UNIT}`;

export const INFRA_SPEECH_DOLLARS_PER_HOUR = 0.1;

export function infraResolutionTier(
	width: number,
	height: number,
): InfraResolutionTier {
	const pixels = width * height;
	if (pixels <= INFRA_TIER_MAX_PIXELS["1080p"]) return "1080p";
	if (pixels <= INFRA_TIER_MAX_PIXELS["1440p"]) return "1440p";
	return "2160p";
}
