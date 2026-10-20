import type { Metadata } from "next";
import {
	AsyncVideoCodeReviewsPage,
	asyncVideoCodeReviewsContent,
} from "@/components/pages/seo/AsyncVideoCodeReviewsPage";
import { ogImageUrl } from "@/lib/og/url";
import { createFAQSchema } from "@/utils/web-schema";

const ogImage = ogImageUrl({
	title: "Async video code reviews",
	tag: "Solutions",
});

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
				url: ogImage,
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
		images: [ogImage],
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(createFAQSchema(asyncVideoCodeReviewsContent.faqs))}
			</script>
			<AsyncVideoCodeReviewsPage />
		</>
	);
}
