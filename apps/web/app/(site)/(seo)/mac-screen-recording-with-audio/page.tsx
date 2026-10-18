import type { Metadata } from "next";
import {
	MacScreenRecordingWithAudioPage,
	macScreenRecordingWithAudioContent,
} from "@/components/pages/seo/MacScreenRecordingWithAudioPage";
import { ogImageUrl } from "@/lib/og/url";
import { createFAQSchema } from "@/utils/web-schema";

const ogImage = ogImageUrl({
	title: "Mac screen recording with system audio",
	tag: "Screen Recorder",
});

export const metadata: Metadata = {
	title:
		"Mac Screen Recording With Audio — Capture Internal System Sound + Mic | Cap",
	description:
		"Record your Mac screen with audio — system sound and microphone — using Cap. Native internal audio capture, no BlackHole and no plugins. Free, open-source, made for macOS.",
	alternates: {
		canonical: "https://cap.so/mac-screen-recording-with-audio",
	},
	openGraph: {
		title:
			"Mac Screen Recording With Audio — Capture Internal System Sound + Mic | Cap",
		description:
			"Record your Mac screen with system audio and microphone using Cap. Native internal audio capture — no BlackHole, no plugins. Free and open-source for macOS.",
		url: "https://cap.so/mac-screen-recording-with-audio",
		siteName: "Cap",
		images: [
			{
				url: ogImage,
				width: 1200,
				height: 630,
				alt: "Cap: Mac screen recorder with internal audio",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title:
			"Mac Screen Recording With Audio — Capture Internal System Sound + Mic | Cap",
		description:
			"Record your Mac screen with system audio and microphone using Cap. Native internal audio capture — no BlackHole, no plugins. Free and open-source for macOS.",
		images: [ogImage],
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
