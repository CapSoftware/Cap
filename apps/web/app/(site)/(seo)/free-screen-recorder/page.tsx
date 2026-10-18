import type { Metadata } from "next";
import {
	FreeScreenRecorderPage,
	freeScreenRecorderContent,
} from "@/components/pages/seo/FreeScreenRecorderPage";
import { ogImageUrl } from "@/lib/og/url";
import { createFAQSchema } from "@/utils/web-schema";

const ogImage = ogImageUrl({
	title: "Free screen recorder, no watermarks",
	tag: "Screen Recorder",
});

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
				url: ogImage,
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
		images: [ogImage],
	},
	alternates: {
		canonical: "https://cap.so/free-screen-recorder",
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(createFAQSchema(freeScreenRecorderContent.faqs))}
			</script>
			<FreeScreenRecorderPage />
		</>
	);
}
