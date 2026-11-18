import { PRICING } from "@/data/pricing";

export const CODE = "BLACKFRIDAY";

// 11:59:59 pm Pacific on Cyber Monday.
export const ENDS_AT = Date.parse("2026-12-01T07:59:59Z");
export const ENDS_LABEL = "Cyber Monday, December 1";

export const PRICE = {
	full: PRICING.pro.yearlyTotal,
	now: PRICING.pro.yearlyTotal / 2,
	perMonth: Math.floor((PRICING.pro.yearlyTotal / 2 / 12) * 100) / 100,
} as const;

export const FILM = {
	title: "Cap Friday, the film",
	ratio: "1920 / 1010",
	hls: "https://cap.so/api/developer/playback/Zc480wz4cSqlAmUtuLaLWYMz/master.m3u8",
	mp4: "https://cap.so/api/developer/playback/Zc480wz4cSqlAmUtuLaLWYMz/video.mp4",
} as const;

export const INCLUDED = [
	"Unlimited cloud storage and bandwidth",
	"AI titles, summaries, chapters and transcripts on every recording",
	"Custom domain for your shares",
	"Password-protected shares and viewer analytics",
	"Team workspaces",
	"Loom importer",
	"Your own S3 bucket or Google Drive",
	"Everything in the Desktop license, plus priority support",
] as const;

export const FEATURES: readonly {
	title: string;
	body: string;
}[] = [
	{
		title: "Share in seconds",
		body: "Stop recording and a shareable link is ready straight away.",
	},
	{
		title: "Cap AI on every video",
		body: "Titles, summaries, clickable chapters and a searchable transcript, written for you.",
	},
	{
		title: "Unlimited cloud",
		body: "Unlimited storage and bandwidth, so you never delete a recording to make room.",
	},
	{
		title: "Comments and analytics",
		body: "Threaded comments, reactions and viewer analytics turn a video into a conversation.",
	},
	{
		title: "Your own domain",
		body: "Serve every share from cap.yourdomain.com, with your brand on the page.",
	},
	{
		title: "Private when it matters",
		body: "Password-protect any share, or keep a recording to your workspace.",
	},
	{
		title: "Bring your own storage",
		body: "Point Cap at your own S3 bucket or Google Drive and keep the files yourself.",
	},
	{
		title: "Studio quality",
		body: "Record up to 4K at 60 fps, then polish with zooms, backgrounds and captions.",
	},
	{
		title: "Built for teams",
		body: "Shared workspaces and spaces keep every team's videos in one place.",
	},
];

export const PLATFORMS: readonly {
	name: string;
	note: string;
}[] = [
	{ name: "macOS", note: "Native app" },
	{ name: "Windows", note: "Native app" },
	{ name: "Linux", note: "Native app" },
	{ name: "iOS", note: "Record on your iPhone" },
	{ name: "Chrome", note: "Browser extension" },
	{ name: "Web", note: "Record in any browser" },
];

export const TEAM_POINTS = [
	"Shared workspaces and spaces for every team",
	"Comments, reactions and viewer analytics on every video",
	"One bill, with seats you can add any time",
	"Your domain, your storage, your branding",
] as const;

export const TESTIMONIAL_NAMES = [
	"Steven Tey",
	"Rohith Gilla",
	"evening kid",
	"Greg_Ld",
	"Jay Ghiya",
	"abdul🪐",
] as const;

export const FAQ = [
	{
		question: "How do I get the discount?",
		answer:
			"Press Claim 50% off. BLACKFRIDAY is applied at checkout for you, so you'll see the discounted total before you pay. You can also type the code into any Cap Pro Yearly checkout.",
	},
	{
		question: "Does it work for my whole team?",
		answer:
			"Yes. Pick how many seats you need and every seat on the yearly plan is half price.",
	},
	{
		question: "I'm already on Cap Pro Yearly. Can I get it too?",
		answer:
			"Yes. Email hello@cap.so before the offer ends and we'll lock in another year for you at the Black Friday price.",
	},
	{
		question: "When does it end?",
		answer: `The offer closes at the end of ${ENDS_LABEL}, Pacific time.`,
	},
] as const;

export const RENEWAL_MAIL =
	"mailto:hello@cap.so?subject=Black%20Friday%3A%20lock%20in%20another%20year";

export const LOOM_MAIL =
	"mailto:hello@cap.so?subject=Black%20Friday%3A%20migrate%20us%20from%20Loom";

export const ANCHORS = { film: "film", offer: "offer", faq: "faq" } as const;
