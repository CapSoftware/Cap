import type { Metadata } from "next";
import Script from "next/script";
import {
	FreeScreenRecorderPage,
	freeScreenRecorderContent,
} from "@/components/pages/seo/FreeScreenRecorderPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Free Screen Recorder: High-Quality Recording at No Cost",
	description:
		"Cap offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",
	openGraph: {
		title: "Free Screen Recorder: High-Quality Recording at No Cost",
		description:
			"Cap offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",
		url: "https://cap.so/free-screen-recorder",
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
		title: "Free Screen Recorder: High-Quality Recording at No Cost",
		description:
			"Cap offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",
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
						createFAQSchema(freeScreenRecorderContent.faqs),
					),
				}}
			/>
			<FreeScreenRecorderPage />
		</>
	);
}
