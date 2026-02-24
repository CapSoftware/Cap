import type { Metadata } from "next";
import Script from "next/script";
import {
	AsyncVideoCodeReviewsPage,
	asyncVideoCodeReviewsContent,
} from "@/components/pages/seo/AsyncVideoCodeReviewsPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Async Video Code Reviews — Ship Faster Without the Meetings | Cap",
	description:
		"Record screen walkthroughs of pull requests and share a timestamped link your team watches on their schedule. Cap makes async code reviews faster and calendar-free.",
	alternates: {
		canonical: "https://cap.so/async-video-code-reviews",
	},
	openGraph: {
		title: "Async Video Code Reviews — Ship Faster Without the Meetings | Cap",
		description:
			"Record screen walkthroughs of pull requests and share a timestamped link your team watches on their schedule. Cap makes async code reviews faster and calendar-free.",
		url: "https://cap.so/async-video-code-reviews",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Async Video Code Reviews",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Async Video Code Reviews — Ship Faster Without the Meetings | Cap",
		description:
			"Record PR walkthroughs and share instant links with timestamped comments. No meetings, no scheduling. Just faster code reviews.",
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
						createFAQSchema(asyncVideoCodeReviewsContent.faqs),
					),
				}}
			/>
			<AsyncVideoCodeReviewsPage />
		</>
	);
}
