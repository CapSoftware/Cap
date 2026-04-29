import type { Metadata } from "next";
import Script from "next/script";
import {
	BestScreenRecorderPage,
	bestScreenRecorderContent,
} from "@/components/pages/seo/BestScreenRecorderPage";
import { createFAQSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "Best Screen Recorder in 2026 — Free, No Watermark, 4K Quality | Cap",
	description:
		"Cap is the best screen recorder for Mac and Windows. Record in 4K with audio and webcam overlay, then share instantly. 100% free with no watermarks, no time limits in Studio Mode.",
	alternates: {
		canonical: "https://cap.so/best-screen-recorder",
	},
	openGraph: {
		title:
			"Best Screen Recorder in 2026 — Free, No Watermark, 4K Quality | Cap",
		description:
			"Cap is the best screen recorder for Mac and Windows. Record in 4K with audio and webcam overlay, then share instantly. Free, open-source, no watermarks.",
		url: "https://cap.so/best-screen-recorder",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Best Screen Recorder for Mac and Windows",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title:
			"Best Screen Recorder in 2026 — Free, No Watermark, 4K Quality | Cap",
		description:
			"Cap is the best screen recorder for Mac and Windows. Record in 4K with audio and webcam overlay, then share instantly. Free, open-source, no watermarks.",
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
						createFAQSchema(bestScreenRecorderContent.faqs),
					),
				}}
			/>
			<BestScreenRecorderPage />
		</>
	);
}
