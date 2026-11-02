import { homepageCopy } from "@/data/homepage-copy";
import { PRICING } from "@/data/pricing";

export const homepageSeo = {
	url: "https://cap.so/",
	title: "Cap — Free Screen Recorder & Open Source Loom Alternative",
	description:
		"Cap is the free, open source screen recorder for Mac, Windows, and Linux. Record, edit, take screenshots, and share videos with a link.",
} as const;

export const homepageSchema = {
	"@context": "https://schema.org",
	"@graph": [
		{
			"@type": "Organization",
			"@id": "https://cap.so/#organization",
			name: "Cap",
			url: homepageSeo.url,
			logo: {
				"@type": "ImageObject",
				url: "https://cap.so/cap-logo.png",
				width: 1440,
				height: 480,
			},
			sameAs: [
				"https://github.com/CapSoftware/Cap",
				"https://x.com/cap",
				"https://www.linkedin.com/company/caprecorder/",
			],
			contactPoint: {
				"@type": "ContactPoint",
				email: "hello@cap.so",
				contactType: "customer support",
			},
		},
		{
			"@type": "WebSite",
			"@id": "https://cap.so/#website",
			name: "Cap",
			url: homepageSeo.url,
			publisher: { "@id": "https://cap.so/#organization" },
			inLanguage: "en",
		},
		{
			"@type": "WebPage",
			"@id": "https://cap.so/#webpage",
			url: homepageSeo.url,
			name: homepageSeo.title,
			description: homepageSeo.description,
			isPartOf: { "@id": "https://cap.so/#website" },
			mainEntity: { "@id": "https://cap.so/#software" },
			inLanguage: "en",
		},
		{
			"@type": "SoftwareApplication",
			"@id": "https://cap.so/#software",
			name: "Cap",
			url: homepageSeo.url,
			description: homepageSeo.description,
			applicationCategory: "MultimediaApplication",
			operatingSystem: ["macOS", "Windows", "Linux"],
			downloadUrl: "https://cap.so/download",
			publisher: { "@id": "https://cap.so/#organization" },
			mainEntityOfPage: { "@id": "https://cap.so/#webpage" },
			featureList: [
				"Screen, webcam, and audio recording",
				"Instant share links that upload while you record",
				"Local 4K recording at 60fps with a built-in video editor",
				"Automatic zoom on clicks",
				"Cursor smoothing and click effects",
				"Camera layouts: webcam bubble, split screen, camera only",
				"Automatic captions in 19 languages, generated on device",
				"Blur and pixelate sensitive information",
				"Custom backgrounds, padding, rounded corners, and shadows",
				"Animated text, titles, and lower thirds",
				"3D camera effects and color grading",
				"Trim, split, and speed controls from 0.25x to 8x",
				"MP4 and GIF export",
				"Screenshot capture with annotation tools",
				"AI titles, summaries, chapters, and transcripts",
				"Timestamped comments, reactions, and viewer analytics",
				"Password protected links and custom domains",
				"Google Drive and S3 storage integrations",
				"CLI and MCP server for AI agents",
				"Loom video importer for single videos and CSV libraries",
				"Open source and self-hostable",
			],
			offers: [
				{
					"@type": "Offer",
					name: "Cap Free",
					price: 0,
					priceCurrency: "USD",
					url: "https://cap.so/download",
					description: "Free local recording and editing for personal use.",
				},
				{
					"@type": "Offer",
					name: "Desktop License",
					price: PRICING.commercial.lifetime,
					priceCurrency: "USD",
					url: "https://cap.so/pricing",
					description: "One-time desktop license for commercial use.",
				},
				{
					"@type": "Offer",
					name: "Cap Pro",
					price: PRICING.pro.monthly,
					priceCurrency: "USD",
					url: "https://cap.so/pricing",
					description:
						"Per user, billed monthly. Annual billing is also available.",
				},
			],
		},
		{
			"@type": "FAQPage",
			"@id": "https://cap.so/#faq",
			isPartOf: { "@id": "https://cap.so/#webpage" },
			mainEntity: homepageCopy.faq.items.map((item) => ({
				"@type": "Question",
				name: item.question,
				acceptedAnswer: { "@type": "Answer", text: item.answer },
			})),
		},
	],
};
