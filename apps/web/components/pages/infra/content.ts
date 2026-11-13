import { canUseInfra } from "@/lib/infra-access";
import {
	INFRA_RESOLUTION_TIERS,
	INFRA_SPEECH_DOLLARS_PER_HOUR,
	INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
	type InfraResolutionTier,
} from "@/lib/infra-pricing";

export const PRICES = {
	storagePer1000Minutes: INFRA_STORAGE_DOLLARS_PER_1000_MINUTES_PER_MONTH,
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
	description: `${HEADLINE} Upload a video and get back adaptive HLS up to 4K, an MP4, a poster and a hosted player. Uploading and encoding are free, storage is from ${usd(PRICES.storagePer1000Minutes[DEFAULT_TIER])} per 1,000 minutes a month and speech to text is ${usd(PRICES.speechPerHour)} per audio hour.`,
	ogDescription: `${HEADLINE} Adaptive HLS up to 4K, an MP4 and a hosted player from one upload.`,
	keywords: [
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
	speed: "speed",
	video: "video",
	speech: "speech",
	player: "player",
	pricing: "pricing",
	pro: "pro",
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

const DOCS = "/docs/api/rest-api";

export const LINKS = {
	docs: DOCS,
	uploadDocs: `${DOCS}#multipart-upload`,
	pro: "/pricing",
	trust: "https://trust.cap.so",
	signIn: "/login",
	home: "/",
	privacy: "/privacy",
	terms: "/terms",
	github: "https://github.com/CapSoftware/Cap",
} as const;

export const ACCESS_EMAIL = "hello@cap.so";

export const OPEN_ACCESS = canUseInfra(null);

export const START = OPEN_ACCESS
	? { label: "Start building", href: "/dashboard/infra" }
	: {
			label: "Request access",
			href: `mailto:${ACCESS_EMAIL}?subject=Cap%20Infra%20access`,
		};

export const PREVIEW_NOTE = OPEN_ACCESS
	? null
	: `Cap Infra is in preview. Email ${ACCESS_EMAIL} for access.`;

export const SPEED_SHORT_CLIP_SECONDS = 3;

export const SPEED_LONG_MINUTES = 20;

export const SPEED_LONG_SECONDS = 15;

export const SPEED_TESTS = [
	{
		source: "a short clip",
		seconds: SPEED_SHORT_CLIP_SECONDS,
	},
	{
		source: `a ${SPEED_LONG_MINUTES} minute 4K screen recording`,
		seconds: SPEED_LONG_SECONDS,
	},
] as const;

export const SPEED_LONG = {
	sourceSeconds: SPEED_LONG_MINUTES * 60,
	seconds: SPEED_LONG_SECONDS,
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
		meter: "Uploading and encoding",
		price: "Free",
		note: "at every resolution",
	},
	{
		meter: "Storage",
		unit: "per 1,000 minutes, per month",
		rates: PRICES.storagePer1000Minutes,
	},
	{
		meter: "Player",
		price: "Included",
		note: "a hosted page and an iframe embed",
	},
];

export type CodeSample = {
	id: "curl" | "embed" | "direct";
	label: string;
	code: string;
};

export const CREATE_UPLOAD = `curl -X POST https://cap.so/api/developer/v1/uploads \\
  -H "Authorization: Bearer csk_your_secret_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "User Recording", "userId": "user_42", "corsOrigin": "https://app.example.com"}'`;

export const GET_VIDEO_STATUS = `curl https://cap.so/api/developer/v1/videos/abc123def456/status \\
  -H "Authorization: Bearer csk_your_secret_key_here"`;

export const VIDEO_STATUS_RESPONSE = `{
  "data": {
    "id": "abc123def456",
    "externalUserId": "user_42",
    "duration": 124.5,
    "width": 1920,
    "height": 1080,
    "transcriptionStatus": null,
    "ready": true,
    "status": "ready",
    "errorReason": null,
    "playbackId": "Zk3vQ9s2Lm8Rt1Xy7Bc4Df6G",
    "renditions": [
      { "name": "1080p", "width": 1920, "height": 1080, "bitrate": 3565000, "bytes": 55480000, "codecs": "avc1.640028,mp4a.40.2" },
      { "name": "720p", "width": 1280, "height": 720, "bitrate": 1161000, "bytes": 18070000, "codecs": "avc1.64001f,mp4a.40.2" },
      { "name": "360p", "width": 640, "height": 360, "bitrate": 261000, "bytes": 4060000, "codecs": "avc1.64001e,mp4a.40.2" }
    ],
    "takenDown": false,
    "hlsUrl": "https://cap.so/api/developer/playback/Zk3vQ9s2Lm8Rt1Xy7Bc4Df6G/master.m3u8",
    "mp4Url": "https://cap.so/api/developer/playback/Zk3vQ9s2Lm8Rt1Xy7Bc4Df6G/video.mp4",
    "posterUrl": "https://cap.so/api/developer/playback/Zk3vQ9s2Lm8Rt1Xy7Bc4Df6G/poster.jpg",
    "outputs": { "hls": "ready", "mp4": "ready" }
  }
}`;

export const VIDEO_FLOW: readonly CodeSample[] = [
	{
		id: "curl",
		label: "curl",
		code: `${CREATE_UPLOAD}

${GET_VIDEO_STATUS}`,
	},
];

export const CREATE_TRANSCRIPT: readonly CodeSample[] = [
	{
		id: "curl",
		label: "curl",
		code: `curl -X POST https://cap.so/api/developer/v1/transcripts \\
  -H "Authorization: Bearer csk_your_secret_key_here" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: standup-2026-11-11" \\
  -d '{"url": "https://example.com/standup.mp3"}'`,
	},
];

export const SAMPLE_PLAYBACK = {
	embed: "https://cap.so/dev/Zk3vQ9s2Lm8Rt1Xy7Bc4Df6G/embed",
	mp4: "https://cap.so/api/developer/playback/Zk3vQ9s2Lm8Rt1Xy7Bc4Df6G/video.mp4",
	poster:
		"https://cap.so/api/developer/playback/Zk3vQ9s2Lm8Rt1Xy7Bc4Df6G/poster.jpg",
} as const;

export const PLAYER: readonly CodeSample[] = [
	{
		id: "embed",
		label: "Cap player",
		code: `<iframe
  src="${SAMPLE_PLAYBACK.embed}"
  title="Product Demo"
  style="width: 100%; aspect-ratio: 16 / 9; border: 0"
  allow="autoplay"
  allowfullscreen
  loading="lazy"
></iframe>`,
	},
	{
		id: "direct",
		label: "Your player",
		code: `<video
  src="${SAMPLE_PLAYBACK.mp4}"
  poster="${SAMPLE_PLAYBACK.poster}"
  controls
  playsinline
></video>`,
	},
];

const roundedDown = (value: number, step: number) =>
	Math.floor(value / step) * step;

export const PRO_CREDIT_COVERS = [
	{
		amount: roundedDown(
			(PRICES.proMonthlyCredit / PRICES.storagePer1000Minutes[DEFAULT_TIER]) *
				1000,
			100,
		),
		unit: "minutes stored for 30 days",
	},
	{
		amount: roundedDown(PRICES.proMonthlyCredit / PRICES.speechPerHour, 1),
		unit: "hours transcribed",
	},
] as const;

export const AGENT_SUMMARY =
	"Add your app's secret key to your project and paste one prompt. Your agent reads the API docs, wires up uploads and playback, and keeps the key on the server.";

export const AGENT_TOOLS =
	"Works in Claude Code, Codex, Cursor and any coding agent that can work in your project.";

export const VIDEO_OUTPUTS = [
	{
		name: "Adaptive HLS",
		detail: "Up to five renditions from 360p to 4K, never above the source.",
	},
	{
		name: "MP4",
		detail: "One file for downloads and as a fallback.",
	},
	{
		name: "Poster",
		detail: "A frame from the video to show before playback.",
	},
	{
		name: "Hosted player",
		detail: "A link to a player page, ready when the video is created.",
	},
	{
		name: "Iframe embed",
		detail: "The same player for your own pages.",
	},
] as const;

export const LADDER = ["4K", "1440p", "1080p", "720p", "360p"] as const;

export type Faq = { question: string; answer: string };

const PREVIEW_FAQ: readonly Faq[] = PREVIEW_NOTE
	? [{ question: "Who can use Cap Infra today?", answer: PREVIEW_NOTE }]
	: [];

export const infraFaqs: readonly Faq[] = [
	...PREVIEW_FAQ,
	{
		question: "What does Cap Infra charge for?",
		answer:
			"Two things: stored video and speech to text. Uploading and encoding are free at every resolution.",
	},
	{
		question: "How does resolution change the price?",
		answer: `Storage is priced per 1,000 minutes a month by resolution tier: ${perTier(PRICES.storagePer1000Minutes)}. A video is billed at the lower of its source resolution and the tier it was created with. The default tier is 1080p, and 1440p and 4K are set per upload.`,
	},
	{
		question: "How do I pay?",
		answer: `With prepaid credits. Each app has its own balance, and auto top-up can add credit from a saved card when the balance runs low. There are no seats and no plans. Cap Pro includes ${usdWhole(PRICES.proMonthlyCredit)} of credit every month.`,
	},
	{
		question: "Do I have to use the Cap player?",
		answer:
			"No. A ready video has an HLS URL and an MP4 URL that need no API key and work in any player. One can still be encoding when the video becomes ready, so play whichever is present. The hosted player is there when you want a link or an iframe embed with nothing to build.",
	},
	{
		question: "Can I use the speech API without hosting my video on Cap?",
		answer: `Yes. Send a public URL or upload an audio or video file and get a transcript back, at ${usd(PRICES.speechPerHour)} per hour of audio. Uploaded videos are not transcribed automatically.`,
	},
	{
		question: "How do I know when a video is ready?",
		answer:
			"Check the video's status from your server every few seconds until it is ready or errored. A video is ready as soon as its first output can be played, and the other output follows.",
	},
	{
		question: "How do API keys work?",
		answer:
			"Each app has a secret key that stays on your server. Your server creates an upload and gives the browser a short-lived upload token that works for that one video.",
	},
	{
		question: "Is Cap Infra compliant for sensitive video?",
		answer:
			"Cap is SOC 2 Type II, ISO 27001 and HIPAA compliant, and a BAA is available. Cap is open source.",
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
		description: `Usage-based pricing. Uploading and encoding are free. Storage per 1,000 minutes a month: ${perTier(PRICES.storagePer1000Minutes)}. Speech to text: ${usd(PRICES.speechPerHour)} per audio hour.`,
	},
	publisher: {
		"@type": "Organization",
		name: "Cap",
		url: "https://cap.so",
	},
} as const;
