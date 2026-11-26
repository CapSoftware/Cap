import type { Metadata } from "next";
import {
	GoogleChromeScreenRecorderPage,
	googleChromeScreenRecorderContent,
} from "@/components/pages/seo/GoogleChromeScreenRecorderPage";
import { ogImageUrl } from "@/lib/og/url";
import {
	createFAQSchema,
	createSoftwareApplicationSchema,
} from "@/utils/web-schema";

const ogImage = ogImageUrl({
	title: "Screen recorder for Google Chrome",
	tag: "Screen Recorder",
});

export const metadata: Metadata = {
	title: "Google Chrome Screen Recorder: Record & Share Free | Cap",
	description:
		"Cap is a free, open source screen recorder for Google Chrome. Add the extension from the Chrome Web Store and record a tab, a window, the full screen, or your camera.",
	keywords: [
		"google chrome screen recorder",
		"chrome screen recorder",
		"screen recorder for chrome",
		"chrome extension screen recorder",
		"record screen on chrome",
		"browser screen recorder",
	],
	alternates: {
		canonical: "https://cap.so/google-chrome-screen-recorder",
	},
	openGraph: {
		title: "Google Chrome Screen Recorder: Record & Share Free | Cap",
		description:
			"Record a browser tab, a window, the full screen, or your camera from Google Chrome with Cap, the open source screen recorder.",
		url: "https://cap.so/google-chrome-screen-recorder",
		siteName: "Cap",
		images: [
			{
				url: ogImage,
				width: 1200,
				height: 630,
				alt: "Cap: Google Chrome Screen Recorder",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Google Chrome Screen Recorder | Cap",
		description:
			"Record a browser tab, a window, the full screen, or your camera from Google Chrome with Cap, the open source screen recorder.",
		images: [ogImage],
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(
					createFAQSchema(googleChromeScreenRecorderContent.faqs),
				)}
			</script>
			<script type="application/ld+json">
				{JSON.stringify(createSoftwareApplicationSchema())}
			</script>
			<GoogleChromeScreenRecorderPage />
		</>
	);
}
