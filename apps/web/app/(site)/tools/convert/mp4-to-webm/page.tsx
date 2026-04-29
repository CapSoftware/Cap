import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "MP4 to WebM Converter | Free Online Video Converter | Cap",
	description:
		"Convert MP4 videos to WebM format for better web compatibility directly in your browser. Free online tool with no uploads required.",
	openGraph: {
		title: "MP4 to WebM Converter | Free Online Video Converter",
		description:
			"Convert MP4 videos to WebM format for better web compatibility. Process videos locally in your browser with no uploads required.",
		images: [
			{
				url: "/og.png",
				width: 1200,
				height: 630,
				alt: "Cap MP4 to WebM Converter Tool",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "MP4 to WebM Converter | Free Online Video Converter",
		description:
			"Convert MP4 videos to WebM format for better web compatibility. Process locally with no uploads for maximum privacy.",
		images: ["/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/mp4-to-webm",
	},
};

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "Tools", url: "https://cap.so/tools" },
	{ name: "Convert", url: "https://cap.so/tools/convert" },
	{
		name: "MP4 to WebM Converter",
		url: "https://cap.so/tools/convert/mp4-to-webm",
	},
]);

export default function MP4ToWebMPage() {
	const pageContent: ToolPageContent = {
		title: "MP4 to WebM Converter",
		description: "Convert MP4 videos to WebM format directly in your browser",
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
				question: "How does the MP4 to WebM converter work?",
				answer:
					"Our converter uses Remotion (remotion.dev) directly in your browser. When you upload an MP4 file, it gets processed locally on your device and converted to WebM format without ever being sent to a server.",
			},
			{
				question: "Is there a file size limit?",
				answer:
					"Yes, currently we limit file sizes to 500MB to ensure smooth performance in the browser. For larger files, you might need to use a desktop application.",
			},
			{
				question: "Why convert to WebM format?",
				answer:
					"WebM is an excellent format for web videos, offering good compression with high quality. It's well-supported by modern browsers and uses less bandwidth than many other formats.",
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
					<MediaFormatConverter initialConversionPath="mp4-to-webm" />
				}
			/>
		</>
	);
}
