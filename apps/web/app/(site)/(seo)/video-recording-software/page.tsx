import type { Metadata } from "next";
import {
	VideoRecordingSoftwarePage,
	videoRecordingSoftwareContent,
} from "@/components/pages/seo/VideoRecordingSoftwarePage";
import { ogImageUrl } from "@/lib/og/url";
import { createFAQSchema } from "@/utils/web-schema";

const ogImage = ogImageUrl({
	title: "Video recording software for Mac & Windows",
	tag: "Screen Recorder",
});

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
				url: ogImage,
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
		images: [ogImage],
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(createFAQSchema(videoRecordingSoftwareContent.faqs))}
			</script>
			<VideoRecordingSoftwarePage />
		</>
	);
}
