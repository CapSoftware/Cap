import type { Metadata } from "next";
import {
	ScreenRecordingPage,
	screenRecordingContent,
} from "@/components/pages/seo/ScreenRecordingPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Screen Recording — Free HD Capture, Instant Sharing | Cap",
	description:
		"Record your screen in HD with audio and webcam overlay, then share instantly with a link. Cap is free, open-source screen recording software for Mac and Windows.",
	alternates: {
		canonical: "https://cap.so/screen-recording",
	},
	openGraph: {
		title: "Screen Recording — Free HD Capture, Instant Sharing | Cap",
		description:
			"Record your screen in HD with audio and webcam overlay, then share instantly with a link. Free, open-source, available on Mac and Windows.",
		url: "https://cap.so/screen-recording",
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
		title: "Screen Recording — Free HD Capture, Instant Sharing | Cap",
		description:
			"Record your screen in HD with audio and webcam overlay, then share instantly with a link. Free, open-source, available on Mac and Windows.",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(createFAQSchema(screenRecordingContent.faqs))}
			</script>
			<ScreenRecordingPage />
		</>
	);
}
