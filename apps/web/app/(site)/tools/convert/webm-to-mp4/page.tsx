import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";

export const metadata: Metadata = {
	title: "WebM to MP4 Converter — Free Online Video Converter | Cap",
	description:
		"Convert WebM to MP4 online free — no upload, no install, 100% in-browser. Fast, private WebM to MP4 conversion with quality preservation.",
	openGraph: {
		title: "WebM to MP4 Converter — Free Online Video Converter | Cap",
		description:
			"Convert WebM to MP4 directly in your browser. No uploads, no installs, no quality loss. Free and private.",
		url: "https://cap.so/tools/convert/webm-to-mp4",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap WebM to MP4 Converter — Free Online Video Converter",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "WebM to MP4 Converter — Free Online Video Converter | Cap",
		description:
			"Convert WebM to MP4 directly in your browser. No uploads, no installs, no quality loss. Free and private.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/webm-to-mp4",
	},
};

const faqs = [
	{
		question: "How do I convert WebM to MP4?",
		answer:
			"Open the Cap WebM to MP4 converter, drag and drop your WebM file (or click to browse), then hit Convert. The entire process runs in your browser using WebCodecs — your file never leaves your device. Once complete, download the MP4 instantly.",
	},
	{
		question: "Is WebM to MP4 conversion free?",
		answer:
			"Yes, completely free with no limits on the number of conversions. There are no watermarks, no sign-up required, and no hidden fees. The converter runs entirely in your browser at zero cost.",
	},
	{
		question: "Can I convert WebM to MP4 without losing quality?",
		answer:
			"Yes. The converter uses browser-native WebCodecs to re-encode the video, preserving the original resolution, frame rate, and audio quality. The output MP4 uses the widely supported H.264 codec for maximum compatibility.",
	},
	{
		question: "What is the difference between WebM and MP4?",
		answer:
			"WebM is an open-source format developed by Google, primarily used for web video with VP8/VP9 codecs. MP4 is the most universally supported video format, using H.264/H.265 codecs. While WebM offers good compression for the web, MP4 is compatible with virtually every device, media player, and social media platform.",
	},
	{
		question: "Why convert WebM to MP4?",
		answer:
			"WebM files are not supported by many devices, video editors, and social media platforms. Converting to MP4 ensures your video plays on iPhones, Android phones, Windows, macOS, smart TVs, and can be uploaded to platforms like Instagram, TikTok, and WhatsApp without issues.",
	},
	{
		question: "Is there a file size limit?",
		answer:
			"The converter supports files up to 500 MB to ensure smooth in-browser performance. For larger files, consider using a desktop application like Cap for screen recording and exporting directly to MP4.",
	},
	{
		question: "Does this converter work on mobile?",
		answer:
			"The converter works best on desktop browsers (Chrome, Edge, Brave) that support WebCodecs. Mobile browser support for WebCodecs is still limited, so desktop is recommended for reliable conversions.",
	},
	{
		question: "Do I need to install any software?",
		answer:
			"No. The converter runs entirely in your browser — no downloads, no plugins, no extensions. Just open the page and start converting. Your files are processed locally on your device for maximum privacy.",
	},
];

const howToSteps = [
	{
		name: "Upload your WebM file",
		text: "Open the Cap WebM to MP4 converter and drag and drop your WebM file into the upload area, or click to browse your files.",
	},
	{
		name: "Start the conversion",
		text: "Click the Convert button. The file is processed entirely in your browser using WebCodecs — nothing is uploaded to any server.",
	},
	{
		name: "Download your MP4",
		text: "Once the conversion finishes, click Download to save the MP4 file to your device. The output preserves the original video quality.",
	},
];

const faqStructuredData = {
	"@context": "https://schema.org",
	"@type": "FAQPage",
	mainEntity: faqs.map((faq) => ({
		"@type": "Question",
		name: faq.question,
		acceptedAnswer: {
			"@type": "Answer",
			text: faq.answer,
		},
	})),
};

const howToStructuredData = {
	"@context": "https://schema.org",
	"@type": "HowTo",
	name: "How to Convert WebM to MP4 Online",
	description:
		"Convert WebM video files to MP4 format for free using Cap's browser-based converter. No upload required.",
	step: howToSteps.map((step, index) => ({
		"@type": "HowToStep",
		position: index + 1,
		name: step.name,
		text: step.text,
	})),
	tool: {
		"@type": "HowToTool",
		name: "A modern web browser (Chrome, Edge, or Brave recommended)",
	},
};

export default function WebmToMp4Page() {
	const pageContent: ToolPageContent = {
		title: "WebM to MP4 Converter",
		description:
			"Convert WebM to MP4 directly in your browser — free, private, and no installation required",
		featuresTitle: "Why Use This WebM to MP4 Converter",
		featuresDescription:
			"A fast, free, and private way to convert WebM videos to MP4 format — entirely in your browser.",
		features: [
			{
				title: "100% Browser-Based",
				description:
					"The entire conversion runs locally in your browser using WebCodecs. No server uploads, no waiting for processing queues — just instant conversion on your device.",
			},
			{
				title: "Complete Privacy",
				description:
					"Your files never leave your device. Unlike other online converters that upload your video to their servers, this tool processes everything client-side for maximum privacy and security.",
			},
			{
				title: "Quality Preservation",
				description:
					"The converter maintains the original resolution, frame rate, and audio quality of your WebM file. The output uses H.264 encoding for broad compatibility without sacrificing clarity.",
			},
			{
				title: "No Installation Needed",
				description:
					"No software downloads, browser extensions, or plugins required. Just open the page and start converting — works instantly on Chrome, Edge, and Brave.",
			},
			{
				title: "Universal Compatibility",
				description:
					"MP4 with H.264 is the most widely supported video format. Your converted file will play on iPhones, Android, Windows, macOS, smart TVs, and every major social media platform.",
			},
			{
				title: "Fast Conversion Speed",
				description:
					"Leverages hardware-accelerated WebCodecs for fast encoding. Most files convert in seconds, not minutes — without the bottleneck of uploading and downloading from a server.",
			},
		],
		faqs,
		cta: {
			title: "Cap is the open source Loom alternative",
			description:
				"Record, edit, and share video messages with Cap. 100% open source and privacy focused. Export directly to MP4 — no conversion needed.",
			buttonText: "Download Cap Free",
		},
	};

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(faqStructuredData),
				}}
			/>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(howToStructuredData),
				}}
			/>
			<ToolsPageTemplate
				content={pageContent}
				toolComponent={
					<MediaFormatConverter initialConversionPath="webm-to-mp4" />
				}
			/>
		</>
	);
}
