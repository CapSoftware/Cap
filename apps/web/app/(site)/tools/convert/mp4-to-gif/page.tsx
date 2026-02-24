import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";

export const metadata: Metadata = {
	title: "MP4 to GIF Converter | Free Online Animated GIF Maker | Cap",
	description:
		"Convert MP4 videos to animated GIF images directly in your browser. Create high-quality GIFs with our free online converter, no uploads needed.",
	openGraph: {
		title: "MP4 to GIF Converter | Free Online Animated GIF Maker",
		description:
			"Convert MP4 videos to animated GIF images directly in your browser. No uploads required, processing happens locally for maximum privacy.",
		images: [
			{
				url: "/og.png",
				width: 1200,
				height: 630,
				alt: "Cap MP4 to GIF Converter Tool",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "MP4 to GIF Converter | Free Online Animated GIF Maker",
		description:
			"Convert MP4 videos to animated GIF images directly in your browser. No uploads required, maximum privacy.",
		images: ["/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/mp4-to-gif",
	},
};

export default function MP4ToGIFPage() {
	const pageContent: ToolPageContent = {
		title: "MP4 to GIF Converter",
		description:
			"Convert MP4 videos to animated GIF images directly in your browser",
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
					"We use Remotion technology to create optimized GIFs from your videos.",
			},
		],
		faqs: [
			{
				question: "How does the MP4 to GIF converter work?",
				answer:
					"Our converter uses Remotion (remotion.dev) directly in your browser. When you upload an MP4 file, it gets processed locally on your device and converted to an animated GIF without ever being sent to a server.",
			},
			{
				question: "Is there a file size limit?",
				answer:
					"Yes, currently we limit file sizes to 500MB to ensure smooth performance in the browser. For larger files, you might need to use a desktop application.",
			},
			{
				question: "What quality settings are used for the GIF?",
				answer:
					"We use optimal settings for web-friendly GIFs with a frame rate of 10 FPS and appropriate resizing to balance quality and file size.",
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
		<ToolsPageTemplate
			content={pageContent}
			toolComponent={
				<MediaFormatConverter initialConversionPath="mp4-to-gif" />
			}
		/>
	);
}
