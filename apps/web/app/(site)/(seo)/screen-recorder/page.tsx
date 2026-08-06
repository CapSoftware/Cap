import type { Metadata } from "next";
import {
	ScreenRecorderPage,
	screenRecorderContent,
} from "@/components/pages/seo/ScreenRecorderPage";
import { ogImageUrl } from "@/lib/og/url";
import { createFAQSchema } from "@/utils/web-schema";

const ogImage = ogImageUrl({
	title: "Screen recorder for Mac & Windows",
	tag: "Screen Recorder",
});

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
		title:
			"Screen Recorder: High-Quality, User-Friendly, and 100% Free Locally",
		description:
			"Cap is a powerful, user-friendly screen recorder and is 100% free locally with no usage limits.",
		images: [ogImage],
	},
	alternates: {
		canonical: "https://cap.so/screen-recorder",
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(createFAQSchema(screenRecorderContent.faqs))}
			</script>
			<ScreenRecorderPage />
		</>
	);
}
