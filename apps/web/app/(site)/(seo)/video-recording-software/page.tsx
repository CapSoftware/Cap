import type { Metadata } from "next";
import Script from "next/script";
import {
	VideoRecordingSoftwarePage,
	videoRecordingSoftwareContent,
} from "@/components/pages/seo/VideoRecordingSoftwarePage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Video Recording Software — Free HD Capture, Instant Sharing | Cap",
	description:
		"Cap is free video recording software for Mac and Windows. Record your screen, webcam, and audio in HD, then share instantly with a link. Open-source, no watermarks, no time limits in Studio Mode.",
	alternates: {
		canonical: "https://cap.so/video-recording-software",
	},
	openGraph: {
		title: "Video Recording Software — Free HD Capture, Instant Sharing | Cap",
		description:
			"Cap is free video recording software for Mac and Windows. Record in HD with audio and webcam, then share with a link instantly. Open-source, no watermarks.",
		url: "https://cap.so/video-recording-software",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Video Recording Software",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Video Recording Software — Free HD Capture, Instant Sharing | Cap",
		description:
			"Cap is free video recording software for Mac and Windows. Record in HD with audio and webcam, then share with a link instantly. Open-source, no watermarks.",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(
						createFAQSchema(videoRecordingSoftwareContent.faqs),
					),
				}}
			/>
			<VideoRecordingSoftwarePage />
		</>
	);
}
