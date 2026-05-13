import type { Metadata } from "next";
import {
	MacScreenRecordingWithAudioPage,
	macScreenRecordingWithAudioContent,
} from "@/components/pages/seo/MacScreenRecordingWithAudioPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Mac Screen Recording with Audio — Capture System Sound & Mic | Cap",
	description:
		"Record your Mac screen with system audio and microphone using Cap. No BlackHole, no plugins required. Free, open-source, and available for macOS. Download Cap today.",
	alternates: {
		canonical: "https://cap.so/mac-screen-recording-with-audio",
	},
	openGraph: {
		title: "Mac Screen Recording with Audio — Capture System Sound & Mic | Cap",
		description:
			"Record your Mac screen with system audio and microphone using Cap. No BlackHole, no plugins required. Free and open-source for macOS.",
		url: "https://cap.so/mac-screen-recording-with-audio",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Mac Screen Recording with Audio",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Mac Screen Recording with Audio — Capture System Sound & Mic | Cap",
		description:
			"Record your Mac screen with system audio and microphone using Cap. No BlackHole, no plugins required. Free and open-source for macOS.",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(
					createFAQSchema(macScreenRecordingWithAudioContent.faqs),
				)}
			</script>
			<MacScreenRecordingWithAudioPage />
		</>
	);
}
