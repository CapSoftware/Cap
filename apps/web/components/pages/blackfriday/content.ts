import { PRICING } from "@/data/pricing";

export const CODE = "BLACKFRIDAY";

/** The offer closes at the end of Cyber Monday, Pacific time. */
export const ENDS_AT = Date.parse("2026-12-01T07:59:59Z");
export const ENDS_LABEL = "Cyber Monday, December 1";

export const PRICE = {
	full: PRICING.pro.yearlyTotal,
	now: PRICING.pro.yearlyTotal / 2,
	perMonth: Math.floor((PRICING.pro.yearlyTotal / 2 / 12) * 100) / 100,
} as const;

/** The film, served by Cap Infra. */
export const FILM = {
	title: "Cap Friday, the film",
	ratio: "1920 / 1010",
	hls: "https://cap.so/api/developer/playback/Zc480wz4cSqlAmUtuLaLWYMz/master.m3u8",
	mp4: "https://cap.so/api/developer/playback/Zc480wz4cSqlAmUtuLaLWYMz/video.mp4",
	poster:
		"https://cap.so/api/developer/playback/Zc480wz4cSqlAmUtuLaLWYMz/poster.jpg",
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

export const ANCHORS = { film: "film", offer: "offer", faq: "faq" } as const;
