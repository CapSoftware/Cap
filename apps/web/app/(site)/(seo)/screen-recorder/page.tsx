import type { Metadata } from "next";
import Script from "next/script";
import {
	ScreenRecorderPage,
	screenRecorderContent,
} from "@/components/pages/seo/ScreenRecorderPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Screen Recorder: High-Quality, User-Friendly, and 100% Free Locally",
	description:
		"Cap is a powerful, user-friendly screen recorder and is 100% free locally with no usage limits. Perfect for team collaboration, creating tutorials, or recording professional presentations.",
	openGraph: {
		title:
			"Screen Recorder: High-Quality, User-Friendly, and 100% Free Locally",
		description:
			"Cap is a powerful, user-friendly screen recorder and is 100% free locally with no usage limits.",
		url: "https://cap.so/screen-recorder",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Free Screen Recorder",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title:
			"Screen Recorder: High-Quality, User-Friendly, and 100% Free Locally",
		description:
			"Cap is a powerful, user-friendly screen recorder and is 100% free locally with no usage limits.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/screen-recorder",
	},
};

export default function Page() {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(createFAQSchema(screenRecorderContent.faqs)),
				}}
			/>
			<ScreenRecorderPage />
		</>
	);
}
