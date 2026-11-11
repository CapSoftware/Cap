import {
	DELIVERY_DOLLARS_PER_1000_MINUTES,
	SPEECH_DOLLARS_PER_HOUR,
	STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
} from "@/lib/developer-pricing";

export const infraSeo = {
	path: "/infra",
	url: "https://cap.so/infra",
	title: "Cap Infra: video and speech APIs",
	description:
		"Upload a video and get back adaptive HLS up to 4K, an MP4, a thumbnail and a transcript, served from a CDN. Speech to text for any file. Free encoding, usage-based pricing, no plans.",
	keywords: [
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
	video: "video",
	speech: "speech",
	player: "player",
	pricing: "pricing",
	faq: "faq",
} as const;

export const NAV_LINKS = [
	{ label: "Video", href: `#${ANCHORS.video}` },
	{ label: "Speech", href: `#${ANCHORS.speech}` },
	{ label: "Player", href: `#${ANCHORS.player}` },
	{ label: "Pricing", href: `#${ANCHORS.pricing}` },
] as const;

export const LINKS = {
	start: "/dashboard/infra",
	docs: "/docs",
	signIn: "/login",
	home: "/",
	privacy: "/privacy",
	terms: "/terms",
	github: "https://github.com/CapSoftware/Cap",
} as const;

export const PRICES = {
	storagePer1000Minutes: STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	deliveryPer1000Minutes: DELIVERY_DOLLARS_PER_1000_MINUTES,
	speechPerHour: SPEECH_DOLLARS_PER_HOUR,
	proMonthlyCredit: 5,
} as const;

export const usd = (value: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
	}).format(value);

export const usdWhole = (value: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		maximumFractionDigits: 0,
	}).format(value);

export type PriceRow = {
	meter: string;
	price: string;
	unit: string;
	note?: string;
};

export const PRICE_ROWS: readonly PriceRow[] = [
	{
		meter: "Encoding",
		price: "Free",
		unit: "Every rendition, every upload",
	},
	{
		meter: "Storage",
		price: usd(PRICES.storagePer1000Minutes),
		unit: "per 1,000 minutes stored, per month",
	},
	{
		meter: "Delivery",
		price: usd(PRICES.deliveryPer1000Minutes),
		unit: "per 1,000 minutes watched",
	},
	{
		meter: "Speech to text",
		price: usd(PRICES.speechPerHour),
		unit: "per hour of audio",
		note: "Free for videos hosted on Cap Infra",
	},
	{
		meter: "Player",
		price: "Included",
		unit: "Embed it anywhere",
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
	id: "curl" | "ts" | "html";
	label: string;
	code: string;
};

export const CREATE_VIDEO: readonly CodeSample[] = [
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

export const CREATE_VIDEO_RESPONSE = `{
  "data": {
    "id": "${SAMPLE_ID}",
    "status": "processing"
  }
}`;

export const GET_VIDEO: readonly CodeSample[] = [
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

export const EMBED: readonly CodeSample[] = [
	{
		id: "html",
		label: "Cap player",
		code: `<iframe
  src="https://cap.so/embed/${SAMPLE_ID}"
  allowfullscreen
></iframe>`,
	},
];

export const DIRECT: readonly CodeSample[] = [
	{
		id: "html",
		label: "Your own player",
		code: `<video
  controls
  src="${PLAYBACK.mp4}"
  poster="${PLAYBACK.thumbnail}"
></video>`,
	},
];

export const VIDEO_OUTPUTS = [
	{
		name: "Adaptive HLS",
		detail: "Renditions from 360p up to 4K, never above the source resolution.",
	},
	{
		name: "MP4",
		detail: "A single file for downloads, previews and simple players.",
	},
	{
		name: "Thumbnail",
		detail: "Ready for your poster frames and listings.",
	},
	{
		name: "Transcript and captions",
		detail: "Generated automatically, with captions as WebVTT.",
	},
	{
		name: "Signed webhooks",
		detail: "Know the moment a video is ready or a transcript completes.",
	},
] as const;

export const LADDER = [
	{ label: "4K", scale: 1 },
	{ label: "1440p", scale: 0.86 },
	{ label: "1080p", scale: 0.72 },
	{ label: "720p", scale: 0.58 },
	{ label: "360p", scale: 0.44 },
] as const;

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
			"Nothing. Every upload is encoded into an adaptive HLS ladder and an MP4 at no charge. You pay for the minutes you store and the minutes your viewers watch.",
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
			"Cap is SOC 2 Type II, ISO 27001 and HIPAA compliant, and a BAA is available. Cap Infra runs on Cap's own GPUs, the same pipeline that processes every Cap recording.",
	},
];

export const infraSoftwareSchema = {
	"@context": "https://schema.org",
	"@type": "SoftwareApplication",
	"@id": "https://cap.so/infra#software",
	name: "Cap Infra",
	url: infraSeo.url,
	description:
		"Video and speech APIs from Cap. Upload, encode to adaptive HLS and MP4, generate thumbnails and transcripts, and serve from a CDN, priced by usage.",
	applicationCategory: "DeveloperApplication",
	operatingSystem: "Web",
	offers: {
		"@type": "Offer",
		price: 0,
		priceCurrency: "USD",
		description: "Usage-based pricing with free encoding.",
	},
	publisher: {
		"@type": "Organization",
		name: "Cap",
		url: "https://cap.so",
	},
} as const;
