import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "AVI to MP4 Converter | Free Online Video Converter | Cap",
	description:
		"Convert AVI videos to MP4 format directly in your browser. Free online converter with no uploads needed for maximum privacy and security.",
	openGraph: {
		title: "AVI to MP4 Converter | Free Online Video Converter",
		description:
			"Convert outdated AVI videos to modern MP4 format. Process files locally in your browser with no uploads for maximum privacy.",
		images: [
			{
				url: "/og.png",
				width: 1200,
				height: 630,
				alt: "Cap AVI to MP4 Converter Tool",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "AVI to MP4 Converter | Free Online Video Converter",
		description:
			"Convert AVI videos to MP4 format for better compatibility. No uploads required, completely private and secure.",
		images: ["/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/avi-to-mp4",
	},
};

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "Tools", url: "https://cap.so/tools" },
	{ name: "Convert", url: "https://cap.so/tools/convert" },
	{
		name: "AVI to MP4 Converter",
		url: "https://cap.so/tools/convert/avi-to-mp4",
	},
]);

export default function AVIToMP4Page() {
	const pageContent: ToolPageContent = {
		title: "AVI to MP4 Converter",
		description: "Convert AVI videos to MP4 format directly in your browser",
		featuresTitle: "Features",
		featuresDescription:
			"Our free online converter offers several advantages over other conversion services:",
		features: [
			{
				title: "100% Private",
				description:
					"Your files never leave your device. All processing happens right in your browser.",
			},
			{
				title: "No Installation Required",
				description:
					"No need to download or install any software. Just open the page and start converting.",
			},
			{
				title: "High Quality Conversion",
				description:
					"We use browser technology to ensure high-quality and fast conversion results.",
			},
		],
		faqs: [
			{
				question: "How does the AVI to MP4 converter work?",
				answer:
					"Our converter uses Remotion (remotion.dev) directly in your browser. When you upload an AVI file, it gets processed locally on your device and converted to MP4 format without ever being sent to a server.",
			},
			{
				question: "Is there a file size limit?",
				answer:
					"Yes, currently we limit file sizes to 500MB to ensure smooth performance in the browser. For larger files, you might need to use a desktop application.",
			},
			{
				question: "Why convert AVI to MP4?",
				answer:
					"AVI is an older format with limited compatibility on modern devices. MP4 offers better compression, smaller file sizes, and widespread support on virtually all platforms and devices.",
			},
		],
		cta: {
			title: "Cap is the open source Loom alternative",
			description:
				"Record, edit, and share video messages with Cap. 100% open source and privacy focused.",
			buttonText: "Download Cap Free",
		},
	};

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(breadcrumbSchema),
				}}
			/>
			<ToolsPageTemplate
				content={pageContent}
				toolComponent={
					<MediaFormatConverter initialConversionPath="avi-to-mp4" />
				}
			/>
		</>
	);
}
