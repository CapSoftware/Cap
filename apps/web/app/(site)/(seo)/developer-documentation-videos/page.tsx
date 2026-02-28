import type { Metadata } from "next";
import Script from "next/script";
import {
	DeveloperDocumentationVideosPage,
	developerDocumentationVideosContent,
} from "@/components/pages/seo/DeveloperDocumentationVideosPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title:
		"Developer Documentation Videos — Record API Demos and SDK Walkthroughs | Cap",
	description:
		"Create professional developer documentation videos with screen recording. Record API demos, SDK walkthroughs, and technical tutorials instantly. Cap is free, open-source, 4K quality, and built for developers.",
	alternates: {
		canonical: "https://cap.so/developer-documentation-videos",
	},
	openGraph: {
		title:
			"Developer Documentation Videos — Record API Demos and SDK Walkthroughs | Cap",
		description:
			"Create professional developer documentation videos with screen recording. Record API demos, SDK walkthroughs, and technical tutorials instantly. Free, open-source, and built for developers.",
		url: "https://cap.so/developer-documentation-videos",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Developer Documentation Videos",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title:
			"Developer Documentation Videos — Record API Demos and SDK Walkthroughs | Cap",
		description:
			"Record API demos, SDK walkthroughs, and changelog videos instantly. Share a link, embed in your docs, get AI transcripts. Free and open-source.",
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
						createFAQSchema(developerDocumentationVideosContent.faqs),
					),
				}}
			/>
			<DeveloperDocumentationVideosPage />
		</>
	);
}
