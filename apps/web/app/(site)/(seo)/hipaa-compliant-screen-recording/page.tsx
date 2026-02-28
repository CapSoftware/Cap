import type { Metadata } from "next";
import Script from "next/script";
import {
	HipaaCompliantScreenRecordingPage,
	hipaaCompliantScreenRecordingContent,
} from "@/components/pages/seo/HipaaCompliantScreenRecordingPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title:
		"HIPAA-Compliant Screen Recording — Secure Healthcare Recordings | Cap",
	description:
		"Cap enables HIPAA-compliant screen recording for healthcare teams. Self-host recordings on your own AWS S3 bucket, keep PHI off third-party servers, and audit every line of open-source code.",
	alternates: {
		canonical: "https://cap.so/hipaa-compliant-screen-recording",
	},
	openGraph: {
		title:
			"HIPAA-Compliant Screen Recording — Secure Healthcare Recordings | Cap",
		description:
			"Cap enables HIPAA-compliant screen recording for healthcare teams. Self-host recordings on your own AWS S3 bucket, keep PHI off third-party servers, and audit every line of open-source code.",
		url: "https://cap.so/hipaa-compliant-screen-recording",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
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
			"Cap enables HIPAA-compliant screen recording for healthcare teams. Self-host recordings on your own AWS S3 bucket, keep PHI off third-party servers.",
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
						createFAQSchema(hipaaCompliantScreenRecordingContent.faqs),
					),
				}}
			/>
			<HipaaCompliantScreenRecordingPage />
		</>
	);
}
