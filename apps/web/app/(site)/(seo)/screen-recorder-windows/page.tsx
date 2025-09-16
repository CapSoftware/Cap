import type { Metadata } from "next";
import { ScreenRecordWindowsPage } from "@/components/pages/seo/ScreenRecordWindowsPage";

export const metadata: Metadata = {
	title: "Best Screen Recorder for Windows: Easy, Powerful & Free (2025)",
	description:
		"Cap is the best screen recorder for Windows, offering HD quality recording, unlimited free usage, and seamless sharing. A perfect OBS alternative for tutorials, presentations, and more.",
	openGraph: {
		title: "Best Screen Recorder for Windows: Easy, Powerful & Free (2025)",
		description:
			"Cap is the best screen recorder for Windows, offering HD quality recording, unlimited free usage, and seamless sharing. A perfect OBS alternative for tutorials, presentations, and more.",
		url: "https://cap.so/screen-recorder-windows",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Best Screen Recorder for Windows",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Best Screen Recorder for Windows | Cap",
		description:
			"Cap is the best screen recorder for Windows, offering HD quality recording, unlimited free usage, and seamless sharing. A perfect OBS alternative for tutorials, presentations, and more.",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return <ScreenRecordWindowsPage />;
}
