import {
	INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
	INFRA_SPEECH_DOLLARS_PER_HOUR,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	type InfraResolutionTier,
} from "@/lib/infra-pricing";

export const AS_OF = "11 November 2026";

export type ProviderId =
	| "cap"
	| "bunny"
	| "apiVideo"
	| "mux"
	| "cloudflare"
	| "assemblyai"
	| "deepgram";

export type Provider = {
	name: string;
	source: string;
	references?: readonly { label: string; href: string }[];
};

export const PROVIDERS: Record<ProviderId, Provider> = {
	cap: { name: "Cap Infra", source: "https://cap.so/infra#pricing" },
	bunny: {
		name: "Bunny Stream",
		source: "https://bunny.net/pricing/stream/",
		references: [
			{ label: "CDN pricing", href: "https://bunny.net/pricing/cdn/" },
			{
				label: "video specification",
				href: "https://docs.bunny.net/stream/video-specification",
			},
		],
	},
	apiVideo: { name: "api.video", source: "https://api.video/pricing/" },
	mux: { name: "Mux", source: "https://www.mux.com/docs/pricing/video" },
	cloudflare: {
		name: "Cloudflare Stream",
		source: "https://developers.cloudflare.com/stream/pricing/",
	},
	assemblyai: {
		name: "AssemblyAI",
		source: "https://www.assemblyai.com/pricing",
	},
	deepgram: { name: "Deepgram", source: "https://deepgram.com/pricing" },
};

export const SOURCE_ORDER: readonly ProviderId[] = [
	"mux",
	"cloudflare",
	"apiVideo",
	"bunny",
	"assemblyai",
	"deepgram",
];

export type TierRates = Record<InfraResolutionTier, number>;

export type TieredRow = { provider: ProviderId; rates: TierRates };

const flat = (rate: number): TierRates => ({
	"1080p": rate,
	"1440p": rate,
	"2160p": rate,
});

export const STORAGE_PER_1000_MINUTES_PER_MONTH: readonly TieredRow[] = [
	{ provider: "cap", rates: INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH },
	{
		provider: "bunny",
		rates: { "1080p": 0.86, "1440p": 1.48, "2160p": 3.38 },
	},
	{ provider: "apiVideo", rates: flat(2.85) },
	{ provider: "mux", rates: { "1080p": 3, "1440p": 4.8, "2160p": 9.6 } },
	{ provider: "cloudflare", rates: flat(5) },
];

export const DELIVERY_PER_1000_MINUTES: readonly TieredRow[] = [
	{ provider: "cap", rates: INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES },
	{
		provider: "bunny",
		rates: { "1080p": 0.2, "1440p": 0.31, "2160p": 0.95 },
	},
	{ provider: "cloudflare", rates: flat(1) },
	{ provider: "mux", rates: { "1080p": 1, "1440p": 1.6, "2160p": 3.2 } },
	{ provider: "apiVideo", rates: flat(1.7) },
];

export const MUX_COLD_STORAGE: TierRates = {
	"1080p": 1.2,
	"1440p": 1.92,
	"2160p": 3.84,
};

export const MUX_COLD_STORAGE_DAYS = 90;

export const MUX_VOLUME_DELIVERY: TierRates = {
	"1080p": 0.7,
	"1440p": 1.12,
	"2160p": 2.24,
};

export const MUX_VOLUME_DELIVERY_MINUTES = 10_000_000;

export const MUX_PAID_ENCODING_PER_1000_MINUTES = { from: 25, to: 150 };

export const BUNNY_DOLLARS_PER_GB = {
	stored: 0.01,
	deliveredVolume: 0.005,
	deliveredStandard: 0.01,
};

export const BUNNY_STANDARD_DELIVERY: TierRates = {
	"1080p": 0.39,
	"1440p": 0.62,
	"2160p": 1.89,
};

export type EncodingRow = {
	provider: ProviderId;
	price: string;
	detail?: string;
};

export const ENCODING: readonly EncodingRow[] = [
	{ provider: "cap", price: "Free", detail: "every resolution" },
	{ provider: "bunny", price: "Free", detail: "standard encoding" },
	{ provider: "cloudflare", price: "Free" },
	{ provider: "apiVideo", price: "Free" },
	{ provider: "mux", price: "Free", detail: "basic quality" },
];

export type SpeechRow = { provider: ProviderId; model?: string; rate: number };

export const SPEECH_PER_AUDIO_HOUR: readonly SpeechRow[] = [
	{ provider: "cap", rate: INFRA_SPEECH_DOLLARS_PER_HOUR },
	{ provider: "assemblyai", model: "Universal-2", rate: 0.15 },
	{ provider: "assemblyai", model: "Universal-3.5 Pro", rate: 0.21 },
	{ provider: "deepgram", model: "Nova-3", rate: 0.258 },
	{ provider: "deepgram", model: "Nova-3 multilingual", rate: 0.312 },
	{ provider: "apiVideo", rate: 6 },
];

export const SPEECH_SCALE_MAX = 0.312;

export const EXAMPLE_MONTH = {
	tier: "1080p",
	minutesStored: 20_000,
	minutesWatched: 500_000,
} as const satisfies {
	tier: InfraResolutionTier;
	minutesStored: number;
	minutesWatched: number;
};

const rateFor = (rows: readonly TieredRow[], provider: ProviderId) =>
	rows.find((row) => row.provider === provider)?.rates[EXAMPLE_MONTH.tier] ?? 0;

export const EXAMPLE_MONTH_BILLS = STORAGE_PER_1000_MINUTES_PER_MONTH.map(
	({ provider }) => ({
		provider,
		total:
			Math.round(
				((EXAMPLE_MONTH.minutesStored / 1000) *
					rateFor(STORAGE_PER_1000_MINUTES_PER_MONTH, provider) +
					(EXAMPLE_MONTH.minutesWatched / 1000) *
						rateFor(DELIVERY_PER_1000_MINUTES, provider)) *
					100,
			) / 100,
	}),
).sort((a, b) => a.total - b.total);
