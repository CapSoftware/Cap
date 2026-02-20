import type { Metadata } from "next";
import { ScreenRecordWindowsPage } from "@/components/pages/seo/ScreenRecordWindowsPage";

export const metadata: Metadata = {
	title: "Best Free Screen Recorder for Windows 10 & 11 | Cap",
	description:
		"Record your screen on Windows with Cap — free, open-source screen recorder with HD video, audio, webcam overlay, and instant sharing. No watermarks. Works on Windows 10 & 11.",
	openGraph: {
		title: "Best Free Screen Recorder for Windows 10 & 11 | Cap",
		description:
			"Record your screen on Windows with Cap — free, open-source screen recorder with HD video, audio, webcam overlay, and instant sharing. No watermarks. Works on Windows 10 & 11.",
		url: "https://cap.so/screen-recorder-windows",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Best Free Screen Recorder for Windows",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Best Free Screen Recorder for Windows 10 & 11 | Cap",
		description:
			"Record your screen on Windows with Cap — free, open-source screen recorder with HD video, audio, webcam overlay, and instant sharing. No watermarks.",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return <ScreenRecordWindowsPage />;
}
