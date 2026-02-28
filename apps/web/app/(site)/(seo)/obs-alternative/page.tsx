import type { Metadata } from "next";
import Script from "next/script";
import {
	ObsAlternativePage,
	obsAlternativeContent,
} from "@/components/pages/seo/ObsAlternativePage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "OBS Alternative — Easier Screen Recording with Instant Sharing | Cap",
	description:
		"Cap is the modern OBS alternative for async screen sharing. Record in 4K, get a shareable link in seconds, and collaborate with timestamped comments. No configuration required.",
	alternates: {
		canonical: "https://cap.so/obs-alternative",
	},
	openGraph: {
		title:
			"OBS Alternative — Easier Screen Recording with Instant Sharing | Cap",
		description:
			"Cap is the modern OBS alternative for async screen sharing. Record in 4K, get a shareable link in seconds, and collaborate with timestamped comments. No configuration required.",
		url: "https://cap.so/obs-alternative",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: OBS Alternative for Async Screen Recording",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title:
			"OBS Alternative — Easier Screen Recording with Instant Sharing | Cap",
		description:
			"Cap is the modern OBS alternative for async screen sharing. Record in 4K, get a shareable link in seconds, and collaborate with timestamped comments. No configuration required.",
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
					__html: JSON.stringify(createFAQSchema(obsAlternativeContent.faqs)),
				}}
			/>
			<ObsAlternativePage />
		</>
	);
}
