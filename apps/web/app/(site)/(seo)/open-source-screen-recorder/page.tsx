import type { Metadata } from "next";
import {
	OpenSourceScreenRecorderPage,
	openSourceScreenRecorderContent,
} from "@/components/pages/seo/OpenSourceScreenRecorderPage";
import { ogImageUrl } from "@/lib/og/url";
import { createFAQSchema } from "@/utils/web-schema";

const ogImage = ogImageUrl({
	title: "The open source screen recorder",
	tag: "Screen Recorder",
});

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
				url: ogImage,
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
		images: [ogImage],
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(createFAQSchema(openSourceScreenRecorderContent.faqs))}
			</script>
			<OpenSourceScreenRecorderPage />
		</>
	);
}
