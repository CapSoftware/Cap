import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";

export const metadata: Metadata = {
	title: "MP4 to MP3 Converter | Extract Audio from Video | Cap",
	description:
		"Extract audio from MP4 videos and save as MP3 files directly in your browser. No uploads required, completely private and secure.",
	openGraph: {
		title: "MP4 to MP3 Converter | Extract Audio from Video",
		description:
			"Extract audio from MP4 videos and save as MP3 files. Process videos locally in your browser with no uploads for maximum privacy.",
		images: [
			{
				url: "/og.png",
				width: 1200,
				height: 630,
				alt: "Cap MP4 to MP3 Converter Tool",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "MP4 to MP3 Converter | Extract Audio from Video",
		description:
			"Extract audio from MP4 videos and save as high-quality MP3 files. No uploads required, completely private and secure.",
		images: ["/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/mp4-to-mp3",
	},
};

export default function MP4ToMP3Page() {
	const pageContent: ToolPageContent = {
		title: "MP4 to MP3 Converter",
		description: "Extract audio from MP4 videos and save as MP3 files",
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
					"We use Remotion technology to ensure high-quality audio extraction.",
			},
		],
		faqs: [
			{
				question: "How does the MP4 to MP3 converter work?",
				answer:
					"Our converter uses Remotion (remotion.dev) directly in your browser. When you upload an MP4 file, it extracts the audio track locally on your device and saves it as an MP3 file without ever being sent to a server.",
			},
			{
				question: "Is there a file size limit?",
				answer:
					"Yes, currently we limit file sizes to 500MB to ensure smooth performance in the browser. For larger files, you might need to use a desktop application.",
			},
			{
				question: "Will this affect the audio quality?",
				answer:
					"Our converter extracts the audio at a high bitrate of 192kbps, which maintains excellent quality while keeping file sizes reasonable.",
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
				<MediaFormatConverter initialConversionPath="mp4-to-mp3" />
			}
		/>
	);
}
