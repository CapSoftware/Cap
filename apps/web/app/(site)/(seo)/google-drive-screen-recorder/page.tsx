import type { Metadata } from "next";
import { GoogleDriveScreenRecorderPage } from "@/components/pages/seo/GoogleDriveScreenRecorderPage";
import { googleDriveScreenRecorderFaqs } from "@/components/pages/seo/google-drive-screen-recorder-faqs";
import {
	createFAQSchema,
	createSoftwareApplicationSchema,
} from "@/utils/web-schema";

export const metadata: Metadata = {
	title:
		"Google Drive Screen Recorder: Save Recordings to Your Own Drive | Cap",
	description:
		"Connect Google Drive to Cap and store every shareable screen recording in your own Drive. Works for individual users and entire organizations. Open source, instant share links, served from your Drive.",
	keywords: [
		"google drive screen recorder",
		"screen recording to google drive",
		"record screen to google drive",
		"save screen recordings to google drive",
		"google drive video hosting",
		"connect google drive to cap",
	],
	alternates: {
		canonical: "https://cap.so/google-drive-screen-recorder",
	},
	openGraph: {
		title:
			"Google Drive Screen Recorder: Save Recordings to Your Own Drive | Cap",
		description:
			"Connect Google Drive to Cap and store every shareable screen recording in your own Drive. For individuals and whole organizations. Open source, instant share links, served from your Drive.",
		url: "https://cap.so/google-drive-screen-recorder",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Google Drive Screen Recorder",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Google Drive Screen Recorder | Cap",
		description:
			"Connect Google Drive to Cap and store every shareable screen recording in your own Drive, for individuals or whole organizations.",
		images: ["https://cap.so/og.png"],
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(createFAQSchema(googleDriveScreenRecorderFaqs))}
			</script>
			<script type="application/ld+json">
				{JSON.stringify(createSoftwareApplicationSchema())}
			</script>
			<GoogleDriveScreenRecorderPage />
		</>
	);
}
