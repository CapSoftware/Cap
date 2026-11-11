import {
	INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
	INFRA_RESOLUTION_TIERS,
	INFRA_SPEECH_DOLLARS_PER_HOUR,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	type InfraResolutionTier,
} from "@/lib/infra-pricing";

export const PRICES = {
	storagePer1000Minutes: INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	deliveryPer1000Minutes: INFRA_DELIVERY_DOLLARS_PER_1000_MINUTES,
	speechPerHour: INFRA_SPEECH_DOLLARS_PER_HOUR,
	proMonthlyCredit: 5,
} as const;

export const TIERS = INFRA_RESOLUTION_TIERS;

export const DEFAULT_TIER: InfraResolutionTier = "1080p";

export const TIER_LABEL: Record<InfraResolutionTier, string> = {
	"1080p": "1080p",
	"1440p": "1440p",
	"2160p": "4K",
};

export const TIER_RANGE: Record<InfraResolutionTier, string> = {
	"1080p": "up to 1080p",
	"1440p": "at 1440p",
	"2160p": "at 4K",
};

export const usd = (value: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
	}).format(value);

export const usdRate = (value: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 3,
	}).format(value);

export const usdWhole = (value: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(value);

const perTier = (rates: Record<InfraResolutionTier, number>) =>
	`${usd(rates["1080p"])} up to 1080p, ${usd(rates["1440p"])} at 1440p and ${usd(rates["2160p"])} at 4K`;

export const HEADLINE = "Cheap, fast & reliable video infrastructure.";

export const HEADLINE_LINES = [
	"Cheap, fast & reliable",
	"video infrastructure.",
] as const;

export const infraSeo = {
	path: "/infra",
	url: "https://cap.so/infra",
	title: "Cap Infra: cheap, fast & reliable video infrastructure",
	description: `${HEADLINE} Upload a video and get back adaptive HLS up to 4K, an MP4, a thumbnail and a transcript. Free encoding, storage from ${usd(PRICES.storagePer1000Minutes[DEFAULT_TIER])} and delivery from ${usd(PRICES.deliveryPer1000Minutes[DEFAULT_TIER])} per 1,000 minutes, speech to text at ${usd(PRICES.speechPerHour)} per audio hour.`,
	ogDescription: `${HEADLINE} Free encoding, delivery from ${usd(PRICES.deliveryPer1000Minutes[DEFAULT_TIER])} per 1,000 minutes.`,
	keywords: [
		"cheapest video API",
		"video infrastructure",
		"video API",
		"video hosting API",
		"video encoding API",
		"HLS streaming API",
		"adaptive bitrate streaming",
		"speech to text API",
		"transcription API",
		"video transcription API",
		"embeddable video player",
		"usage based video hosting",
	],
} as const;

export const ANCHORS = {
	agents: "agents",
	compare: "compare",
	speed: "speed",
	video: "video",
	speech: "speech",
	player: "player",
	pricing: "pricing",
	faq: "faq",
} as const;

export const NAV_LINKS = [
	{ label: "Agents", href: `#${ANCHORS.agents}` },
	{ label: "Video", href: `#${ANCHORS.video}` },
	{ label: "Speech", href: `#${ANCHORS.speech}` },
	{ label: "Player", href: `#${ANCHORS.player}` },
	{ label: "Pricing", href: `#${ANCHORS.pricing}` },
] as const;

export const COMPLIANCE = "SOC 2 Type II, ISO 27001 and HIPAA compliant.";

export const BAA = "BAA available.";

export const TRUST = [COMPLIANCE, BAA, "Open source."] as const;

export const LINKS = {
	start: "/dashboard/infra",
	docs: "/docs",
	agentDocs: "/docs/agents",
	trust: "https://trust.cap.so",
	signIn: "/login",
	home: "/",
	privacy: "/privacy",
	terms: "/terms",
	github: "https://github.com/CapSoftware/Cap",
} as const;

export const SPEED_VIDEO_MINUTES = 30;

export const SPEED_SECONDS_TO_PLAYABLE = 5;

export const SPEED_MINUTES_TO_FULLY_PROCESSED = 2;

export const SPEED_SPEECH_SECONDS_PER_AUDIO_HOUR = 24;

export const SPEED_VIDEO = {
	source: `${SPEED_VIDEO_MINUTES} minutes of 4K video`,
	sourceSeconds: SPEED_VIDEO_MINUTES * 60,
	playableSeconds: SPEED_SECONDS_TO_PLAYABLE,
	processedSeconds: SPEED_MINUTES_TO_FULLY_PROCESSED * 60,
} as const;

export const SPEED_SPEECH = {
	source: "One hour of audio",
	sourceSeconds: 60 * 60,
	seconds: SPEED_SPEECH_SECONDS_PER_AUDIO_HOUR,
} as const;

export const clock = (totalSeconds: number) => {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = String(totalSeconds % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
		: `${minutes}:${seconds}`;
};

export type PriceRow = {
	meter: string;
	unit?: string;
	rates?: Record<InfraResolutionTier, number>;
	price?: string;
	note?: string;
};

export const PRICE_ROWS: readonly PriceRow[] = [
	{
		meter: "Encoding",
		price: "Free",
		note: "at every resolution",
	},
	{
		meter: "Storage",
		unit: "per 1,000 minutes, per month",
		rates: PRICES.storagePer1000Minutes,
	},
	{
		meter: "Delivery",
		unit: "per 1,000 minutes watched",
		rates: PRICES.deliveryPer1000Minutes,
	},
	{
		meter: "Speech to text",
		unit: "per hour of audio",
		price: usd(PRICES.speechPerHour),
		note: "free for videos hosted on Cap Infra",
	},
	{
		meter: "Player",
		price: "Included",
		note: "embed it anywhere",
	},
];

export const API_BASE = "https://cap.so/api/developer/v1";

export const SAMPLE_ID = "8k2m4x9q";

const MEDIA = `https://cdn.example.com/${SAMPLE_ID}`;

export const PLAYBACK = {
	hls: `${MEDIA}/master.m3u8`,
	mp4: `${MEDIA}/1080p.mp4`,
	thumbnail: `${MEDIA}/thumbnail.jpg`,
	captions: `${MEDIA}/captions.vtt`,
} as const;

export type CodeSample = {
	id: "curl" | "ts" | "embed" | "direct";
	label: string;
	code: string;
};

const CREATE_VIDEO: readonly CodeSample[] = [
	{
		id: "curl",
		label: "curl",
		code: `curl -X POST ${API_BASE}/videos \\
  -H "Authorization: Bearer csk_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "url": "https://example.com/video.mp4" }'`,
	},
	{
		id: "ts",
		label: "TypeScript",
		code: `const res = await fetch("${API_BASE}/videos", {
  method: "POST",
  headers: {
    Authorization: "Bearer csk_...",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ url: "https://example.com/video.mp4" }),
});

const { data } = await res.json();`,
	},
];

const GET_VIDEO: readonly CodeSample[] = [
	{
		id: "curl",
		label: "curl",
		code: `curl ${API_BASE}/videos/${SAMPLE_ID} \\
  -H "Authorization: Bearer csk_..."`,
	},
	{
		id: "ts",
		label: "TypeScript",
		code: `const res = await fetch("${API_BASE}/videos/${SAMPLE_ID}", {
  headers: { Authorization: "Bearer csk_..." },
});

const { data } = await res.json();`,
	},
];

export const GET_VIDEO_RESPONSE = `{
  "data": {
    "id": "${SAMPLE_ID}",
    "status": "ready",
    "duration": 184.2,
    "playback": {
      "hls": "${PLAYBACK.hls}",
      "mp4": "${PLAYBACK.mp4}",
      "thumbnail": "${PLAYBACK.thumbnail}",
      "captions": "${PLAYBACK.captions}"
    }
  }
}`;

export const VIDEO_FLOW: readonly CodeSample[] = [
	{
		id: "curl",
		label: "curl",
		code: `${CREATE_VIDEO[0]?.code}

${GET_VIDEO[0]?.code}`,
	},
	{
		id: "ts",
		label: "TypeScript",
		code: `const created = await fetch("${API_BASE}/videos", {
  method: "POST",
  headers: {
    Authorization: "Bearer csk_...",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ url: "https://example.com/video.mp4" }),
}).then((res) => res.json());

const video = await fetch(
  \`${API_BASE}/videos/\${created.data.id}\`,
  { headers: { Authorization: "Bearer csk_..." } },
).then((res) => res.json());`,
	},
];

export const CREATE_TRANSCRIPT: readonly CodeSample[] = [
	{
		id: "curl",
		label: "curl",
		code: `curl -X POST ${API_BASE}/transcripts \\
  -H "Authorization: Bearer csk_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "audio_url": "https://example.com/call.mp3" }'`,
	},
	{
		id: "ts",
		label: "TypeScript",
		code: `const res = await fetch("${API_BASE}/transcripts", {
  method: "POST",
  headers: {
    Authorization: "Bearer csk_...",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ audio_url: "https://example.com/call.mp3" }),
});

const { data } = await res.json();`,
	},
];

export const PLAYER: readonly CodeSample[] = [
	{
		id: "embed",
		label: "Cap player",
		code: `<iframe
  src="https://cap.so/embed/${SAMPLE_ID}"
  allowfullscreen
></iframe>`,
	},
	{
		id: "direct",
		label: "Your player",
		code: `<video
  controls
  src="${PLAYBACK.mp4}"
  poster="${PLAYBACK.thumbnail}"
></video>`,
	},
];

export const AGENT_STEPS = [
	"Copy the prompt.",
	"Paste it into your agent.",
	"Ask for what you want.",
] as const;

export const AGENT_TOOLS =
	"Works in Claude Code, Codex, Cursor and any agent that can run shell commands.";

export const VIDEO_OUTPUTS = [
	{
		name: "Adaptive HLS",
		detail: "Five renditions from 360p to 4K, never above the source.",
	},
	{
		name: "MP4",
		detail: "One file for downloads and simple players.",
	},
	{
		name: "Thumbnail",
		detail: "A poster frame for listings and previews.",
	},
	{
		name: "Transcript",
		detail: "Generated for every video, with WebVTT captions.",
	},
	{
		name: "Signed webhooks",
		detail: "Sent the moment a video or transcript is ready.",
	},
] as const;

export const LADDER = ["4K", "1440p", "1080p", "720p", "360p"] as const;

export const UPLOAD_SOURCES = [
	"the dashboard",
	"the REST API",
	"a URL to import",
] as const;

export type Faq = { question: string; answer: string };

export const infraFaqs: readonly Faq[] = [
	{
		question: "What does encoding cost?",
		answer:
			"Nothing, at every resolution. Every upload is encoded into an adaptive HLS ladder and an MP4 at no charge. You pay for the minutes you store and the minutes your viewers watch.",
	},
	{
		question: "How does resolution change the price?",
		answer: `Storage is priced on the video's resolution, per 1,000 minutes a month: ${perTier(PRICES.storagePer1000Minutes)}. Delivery is billed on the resolution each viewer actually watched, per 1,000 minutes: ${perTier(PRICES.deliveryPer1000Minutes)}. Videos are encoded up to 1080p by default, and 1440p and 4K are a per-video setting.`,
	},
	{
		question: "How do I pay?",
		answer: `With prepaid credits, and you can turn on auto top-up so you never run dry. There are no minimums, no seats and no plans. Cap Pro subscribers get ${usdWhole(PRICES.proMonthlyCredit)} of usage every month.`,
	},
	{
		question: "Do I have to use the Cap player?",
		answer:
			"No. Every video comes with direct HLS and MP4 URLs that work in any player. The Cap player is there when you want a lightweight embed with nothing to build.",
	},
	{
		question: "Can I use the speech API without hosting my video on Cap?",
		answer: `Yes. Send any audio or video file and get a transcript back, at ${usd(PRICES.speechPerHour)} per hour of audio. If you already use a speech SDK, change its base URL to Cap. Transcripts for videos hosted on Cap Infra are free.`,
	},
	{
		question: "How do I know when a video is ready?",
		answer:
			"Cap sends a signed webhook when a video is ready and when a transcript completes. You can also fetch the video at any time and check its status.",
	},
	{
		question: "How do API keys work?",
		answer:
			"Each app gets its own keys. Use the public key in browsers and the secret key on your servers.",
	},
	{
		question: "Is Cap Infra compliant for sensitive video?",
		answer:
			"Cap is SOC 2 Type II, ISO 27001 and HIPAA compliant, and a BAA is available. Cap is open source, and the pipeline runs on Cap's own GPUs.",
	},
];

export const infraSoftwareSchema = {
	"@context": "https://schema.org",
	"@type": "SoftwareApplication",
	"@id": "https://cap.so/infra#software",
	name: "Cap Infra",
	url: infraSeo.url,
	description: infraSeo.description,
	applicationCategory: "DeveloperApplication",
	operatingSystem: "Web",
	offers: {
		"@type": "Offer",
		price: 0,
		priceCurrency: "USD",
		description: `Usage-based pricing with free encoding. Storage per 1,000 minutes a month: ${perTier(PRICES.storagePer1000Minutes)}. Delivery per 1,000 minutes watched: ${perTier(PRICES.deliveryPer1000Minutes)}. Speech to text: ${usd(PRICES.speechPerHour)} per audio hour.`,
	},
	publisher: {
		"@type": "Organization",
		name: "Cap",
		url: "https://cap.so",
	},
} as const;
