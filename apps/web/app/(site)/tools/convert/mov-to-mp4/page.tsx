import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";

export const metadata: Metadata = {
	title: "MOV to MP4 Converter | Free Online Video Converter | Cap",
	description:
		"Convert Apple QuickTime MOV videos to MP4 format directly in your browser. Free online converter with no uploads needed for maximum privacy.",
	openGraph: {
		title: "MOV to MP4 Converter | Free Online Video Converter",
		description:
			"Convert Apple QuickTime MOV videos to the widely compatible MP4 format right in your browser. No uploads, no installation required.",
		images: [
			{
				url: "/og.png",
				width: 1200,
				height: 630,
				alt: "Cap MOV to MP4 Converter Tool",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "MOV to MP4 Converter | Free Online Video Converter",
		description:
			"Convert Apple QuickTime MOV videos to MP4 format directly in your browser. No uploads required for maximum privacy.",
		images: ["/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/mov-to-mp4",
	},
};

export default function MOVToMP4Page() {
	const pageContent: ToolPageContent = {
		title: "MOV to MP4 Converter",
		description: "Convert MOV videos to MP4 format directly in your browser",
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
				question: "How does the MOV to MP4 converter work?",
				answer:
					"Our converter uses Remotion (remotion.dev) directly in your browser. When you upload a MOV file, it gets processed locally on your device and converted to MP4 format without ever being sent to a server.",
			},
			{
				question: "Is there a file size limit?",
				answer:
					"Yes, currently we limit file sizes to 500MB to ensure smooth performance in the browser. For larger files, you might need to use a desktop application.",
			},
			{
				question: "Why convert MOV to MP4?",
				answer:
					"MP4 offers much better compatibility across devices and platforms than MOV, which is primarily used on Apple devices. Converting to MP4 ensures your videos can be viewed anywhere.",
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
				<MediaFormatConverter initialConversionPath="mov-to-mp4" />
			}
		/>
	);
}
