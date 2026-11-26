import type { Metadata } from "next";
import { ScreenRecordMacPage } from "@/components/pages/seo/ScreenRecordMacPage";
import { ogImageUrl } from "@/lib/og/url";

const ogImage = ogImageUrl({
	title: "Free screen recorder for Mac",
	tag: "Screen Recorder",
});

export const metadata: Metadata = {
	title: "Free screen recorder for Mac: record your screen | Cap",
	description:
		"Record your screen on Mac with Cap, free for personal use. Capture a display, window or area on Apple silicon or Intel Macs and export MP4 in up to 4K.",
	openGraph: {
		title: "Free screen recorder for Mac: record your screen | Cap",
		description:
			"Record your screen on Mac with Cap, free for personal use. Capture a display, window or area on Apple silicon or Intel Macs and export MP4 in up to 4K.",
		url: "https://cap.so/screen-recorder-mac",
		siteName: "Cap",
		images: [
			{
				url: ogImage,
				width: 1200,
				height: 630,
				alt: "Free screen recorder for Mac",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Free screen recorder for Mac: record your screen | Cap",
		description:
			"Record your screen on Mac with Cap, free for personal use. Capture a display, window or area on Apple silicon or Intel Macs and export MP4 in up to 4K.",
		images: [ogImage],
	},
	alternates: {
		canonical: "https://cap.so/screen-recorder-mac",
	},
};

export default function Page() {
	return <ScreenRecordMacPage />;
}
