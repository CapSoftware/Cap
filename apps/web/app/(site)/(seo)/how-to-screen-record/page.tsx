import type { Metadata } from "next";
import { HowToScreenRecordPage } from "@/components/pages/seo/HowToScreenRecordPage";

export const metadata: Metadata = {
	title: "How to Screen Record on Mac, Windows & Chrome (2026 Guide) | Cap",
	description:
		"Learn how to screen record with audio on Mac, Windows, and Chrome. Free step-by-step guide covering built-in tools and Cap, the open-source screen recorder.",
	openGraph: {
		title: "How to Screen Record on Mac, Windows & Chrome (2026 Guide) | Cap",
		description:
			"Learn how to screen record with audio on any platform. Step-by-step instructions for macOS, Windows, and Chrome with free and paid options.",
		url: "https://cap.so/how-to-screen-record",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "How to Screen Record — Complete 2026 Guide by Cap",
			},
		],
		locale: "en_US",
		type: "article",
	},
	twitter: {
		card: "summary_large_image",
		title: "How to Screen Record on Mac, Windows & Chrome (2026 Guide) | Cap",
		description:
			"Learn how to screen record with audio on Mac, Windows, and Chrome. Free step-by-step guide.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/how-to-screen-record",
	},
};

export default function Page() {
	return <HowToScreenRecordPage />;
}
