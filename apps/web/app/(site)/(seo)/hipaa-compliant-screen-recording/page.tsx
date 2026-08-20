import type { Metadata } from "next";
import {
	HipaaCompliantScreenRecordingPage,
	hipaaCompliantScreenRecordingContent,
} from "@/components/pages/seo/HipaaCompliantScreenRecordingPage";
import { ogImageUrl } from "@/lib/og/url";
import { createFAQSchema } from "@/utils/web-schema";

const ogImage = ogImageUrl({
	title: "HIPAA-compliant screen recording",
	tag: "Screen Recorder",
});

export const metadata: Metadata = {
	title:
		"HIPAA-Compliant Screen Recording — Secure Healthcare Recordings | Cap",
	description:
		"Cap is a HIPAA-compliant screen recorder for healthcare teams. Sign a BAA in minutes on the Pro plan, SOC 2 Type II and ISO 27001 certified, plus self-hosting to keep PHI on your own storage.",
	alternates: {
		canonical: "https://cap.so/hipaa-compliant-screen-recording",
	},
	openGraph: {
		title:
			"HIPAA-Compliant Screen Recording — Secure Healthcare Recordings | Cap",
		description:
			"Cap is a HIPAA-compliant screen recorder for healthcare teams. Sign a BAA in minutes on the Pro plan, SOC 2 Type II and ISO 27001 certified, plus self-hosting to keep PHI on your own storage.",
		url: "https://cap.so/hipaa-compliant-screen-recording",
		siteName: "Cap",
		images: [
			{
				url: ogImage,
				width: 1200,
				height: 630,
				alt: "Cap: HIPAA-Compliant Screen Recording for Healthcare",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title:
			"HIPAA-Compliant Screen Recording — Secure Healthcare Recordings | Cap",
		description:
			"Cap is a HIPAA-compliant screen recorder. Sign a BAA in minutes on the Pro plan, plus self-hosting to keep PHI on your own storage.",
		images: [ogImage],
	},
};

export default function Page() {
	return (
		<>
			<script type="application/ld+json">
				{JSON.stringify(
					createFAQSchema(hipaaCompliantScreenRecordingContent.faqs),
				)}
			</script>
			<HipaaCompliantScreenRecordingPage />
		</>
	);
}
