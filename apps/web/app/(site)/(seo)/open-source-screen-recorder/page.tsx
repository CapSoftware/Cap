import type { Metadata } from "next";
import Script from "next/script";
import {
	OpenSourceScreenRecorderPage,
	openSourceScreenRecorderContent,
} from "@/components/pages/seo/OpenSourceScreenRecorderPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Open Source Screen Recorder — Free, Private, Self-Hostable | Cap",
	description:
		"Cap is the leading open-source screen recorder for Mac and Windows. Audit the code, self-host your recordings, and own your data. MIT-licensed, 4K quality, no watermarks.",
	alternates: {
		canonical: "https://cap.so/open-source-screen-recorder",
	},
	openGraph: {
		title: "Open Source Screen Recorder — Free, Private, Self-Hostable | Cap",
		description:
			"Cap is the leading open-source screen recorder for Mac and Windows. MIT-licensed, 4K quality, instant sharing, self-hostable storage. No watermarks, no vendor lock-in.",
		url: "https://cap.so/open-source-screen-recorder",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Open Source Screen Recorder",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Open Source Screen Recorder — Free, Private, Self-Hostable | Cap",
		description:
			"Cap is the leading open-source screen recorder for Mac and Windows. MIT-licensed, 4K quality, instant sharing, self-hostable storage. No watermarks, no vendor lock-in.",
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
						createFAQSchema(openSourceScreenRecorderContent.faqs),
					),
				}}
			/>
			<OpenSourceScreenRecorderPage />
		</>
	);
}
