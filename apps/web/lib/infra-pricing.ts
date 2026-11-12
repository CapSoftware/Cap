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

export const INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES: Record<
	InfraResolutionTier,
	number
> = {
	"1080p": 0.19,
	"1440p": 0.3,
	"2160p": 0.94,
};

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
