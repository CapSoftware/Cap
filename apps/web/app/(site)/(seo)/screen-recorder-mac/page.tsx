import type { Metadata } from "next";
import { ScreenRecordMacPage } from "@/components/pages/seo/ScreenRecordMacPage";

export const metadata: Metadata = {
	title: "Best Screen Recorder for Mac | High-Quality, Free & Easy (2025)",
	description:
		"Cap is the best free screen recorder for Mac, offering HD quality, unlimited recording, and easy export. Ideal for tutorials, presentations, and educational videos.",
	openGraph: {
		title: "Best Screen Recorder for Mac | High-Quality, Free & Easy (2025)",
		description:
			"Cap is the best free screen recorder for Mac, offering HD quality, unlimited recording, and easy export. Ideal for tutorials, presentations, and educational videos.",
		url: "https://cap.so/screen-recorder-mac",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Best Screen Recorder for Mac",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Best Screen Recorder for Mac | Cap",
		description:
			"Cap is the best free screen recorder for Mac, offering HD quality, unlimited recording, and easy export. Ideal for tutorials, presentations, and educational videos.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/screen-recorder-mac",
	},
};

export default function Page() {
	return <ScreenRecordMacPage />;
}
