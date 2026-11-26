import type { Metadata } from "next";
import { ScreenRecordWindowsPage } from "@/components/pages/seo/ScreenRecordWindowsPage";
import { ogImageUrl } from "@/lib/og/url";

const ogImage = ogImageUrl({
	title: "Free screen recorder for Windows 10 & 11",
	tag: "Screen Recorder",
});

export const metadata: Metadata = {
	title: "Free screen recorder for Windows 10 and 11 PCs | Cap",
	description:
		"Record your screen on Windows 10 and 11 with Cap, a free, open source screen recorder for PC. Share a link the moment you stop, or edit and export in 4K.",
	openGraph: {
		title: "Free screen recorder for Windows 10 and 11 PCs | Cap",
		description:
			"Record your screen on Windows 10 and 11 with Cap, a free, open source screen recorder for PC. Share a link the moment you stop, or edit and export in 4K.",
		url: "https://cap.so/screen-recorder-windows",
		siteName: "Cap",
		images: [
			{
				url: ogImage,
				width: 1200,
				height: 630,
				alt: "Cap: free screen recorder for Windows 10 and 11",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Free screen recorder for Windows 10 and 11 PCs | Cap",
		description:
			"Record your screen on Windows 10 and 11 with Cap, a free, open source screen recorder for PC. Share a link the moment you stop, or edit and export in 4K.",
		images: [ogImage],
	},
	alternates: {
		canonical: "https://cap.so/screen-recorder-windows",
	},
};

export default function Page() {
	return <ScreenRecordWindowsPage />;
}
