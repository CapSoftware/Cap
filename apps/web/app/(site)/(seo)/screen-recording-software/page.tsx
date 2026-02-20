import type { Metadata } from "next";
import { ScreenRecordingSoftwarePage } from "@/components/pages/seo/ScreenRecordingSoftwarePage";

export const metadata: Metadata = {
	title: "Screen Recording Software — Free HD Screen Capture | Cap",
	description:
		"Free, open-source screen recording software for Mac and Windows. Capture HD video with audio, share instantly, and own your data. Download Cap today.",
	alternates: {
		canonical: "https://cap.so/screen-recording-software",
	},
	openGraph: {
		title: "Screen Recording Software — Free HD Screen Capture | Cap",
		description:
			"Free, open-source screen recording software for Mac and Windows. Capture HD video with audio, share instantly, and own your data.",
		url: "https://cap.so/screen-recording-software",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Screen Recording Software",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Screen Recording Software — Free HD Screen Capture | Cap",
		description:
			"Free, open-source screen recording software for Mac and Windows. Capture HD video with audio, share instantly, and own your data.",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return <ScreenRecordingSoftwarePage />;
}
