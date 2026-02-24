import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";

export const metadata: Metadata = {
	title: "MOV to MP4 Converter — Free Online Video Converter | Cap",
	description:
		"Convert Apple QuickTime MOV videos to MP4 format directly in your browser. Free, private, no upload needed. Works with iPhone recordings, screen captures, and any MOV file.",
	keywords: [
		"mov to mp4 converter",
		"convert mov to mp4 online",
		"free mov to mp4",
		"quicktime to mp4",
		"iphone video converter",
		"mov to mp4 no upload",
		"browser mov converter",
	],
	openGraph: {
		title: "MOV to MP4 Converter — Free Online Video Converter | Cap",
		description:
			"Convert MOV videos to the universally compatible MP4 format directly in your browser. No uploads, no installs, 100% private. Works with iPhone recordings and QuickTime files.",
		url: "https://cap.so/tools/convert/mov-to-mp4",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap MOV to MP4 Converter — Free Online Video Converter",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "MOV to MP4 Converter — Free Online Video Converter | Cap",
		description:
			"Convert MOV to MP4 directly in your browser. No uploads, no installs, 100% private.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/mov-to-mp4",
	},
};

const faqs = [
	{
		question: "How do I convert MOV to MP4 online?",
		answer:
			"Open Cap's MOV to MP4 converter, drag and drop your MOV file (or click to browse), then click Convert. The entire process runs in your browser — your file never leaves your device. Once complete, click Download to save the MP4 file.",
	},
	{
		question: "Is the MOV to MP4 converter free?",
		answer:
			"Yes, completely free with no limits on the number of conversions. There are no watermarks, no sign-up required, and no hidden fees. The converter runs entirely in your browser at zero cost.",
	},
	{
		question: "Why convert MOV to MP4?",
		answer:
			"MOV is Apple's proprietary QuickTime format and plays natively on macOS and iOS but often has limited support on Windows, Android, and smart TVs. MP4 (H.264) is the universal standard supported by virtually every device, platform, browser, and video hosting service. Converting to MP4 ensures your video plays anywhere without compatibility issues.",
	},
	{
		question: "Will converting MOV to MP4 reduce video quality?",
		answer:
			"Quality is preserved as closely as possible during conversion. The converter uses your browser's native video decoding and re-encodes to H.264 MP4, which is visually lossless at typical settings. For most use cases — sharing, uploading, or playing on other devices — the output quality will look identical to the original.",
	},
	{
		question: "Is there a file size limit?",
		answer:
			"The converter supports MOV files up to 500 MB. For smooth in-browser performance, files under 200 MB convert fastest. For very large MOV files, consider trimming the video first to keep only the section you need.",
	},
	{
		question: "Does this work with iPhone MOV files?",
		answer:
			"Yes. iPhones and iPads record video in the MOV (QuickTime) container using HEVC or H.264. Cap's converter handles both formats and outputs a widely compatible MP4 file you can share, upload, or play on any device.",
	},
	{
		question: "Does the converter work on mobile?",
		answer:
			"The converter works best on desktop browsers (Chrome, Edge, Brave). Mobile browser support for the underlying video processing APIs is still limited, so desktop is recommended for the most reliable results.",
	},
	{
		question: "Do I need to install any software?",
		answer:
			"No. The converter runs entirely in your browser — no downloads, no plugins, no extensions required. Just open the page and start converting. All processing happens locally on your device for complete privacy.",
	},
];

const howToSteps = [
	{
		name: "Upload your MOV file",
		text: "Open Cap's MOV to MP4 converter and drag and drop your MOV file into the upload area, or click to browse your files. Supports QuickTime MOV files up to 500 MB.",
	},
	{
		name: "Start the conversion",
		text: "Click Convert. The file is processed entirely in your browser using local compute — nothing is uploaded to any server. Conversion time depends on file size and your device speed.",
	},
	{
		name: "Download your MP4",
		text: "Once conversion is complete, click Download to save the MP4 file to your device. The output is a standard H.264 MP4 compatible with every device, platform, and video hosting service.",
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
	name: "How to Convert MOV to MP4 Online",
	description:
		"Convert Apple QuickTime MOV video files to MP4 format for free using Cap's browser-based converter. No upload required.",
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

export default function MOVToMP4Page() {
	const pageContent: ToolPageContent = {
		title: "MOV to MP4 Converter",
		description:
			"Convert Apple QuickTime MOV videos to the universally compatible MP4 format directly in your browser — free, private, and no installation required",
		featuresTitle: "Why Use This MOV to MP4 Converter",
		featuresDescription:
			"A fast, free, and private way to convert MOV files to MP4 — entirely in your browser with no uploads and no quality loss.",
		features: [
			{
				title: "100% Browser-Based",
				description:
					"The entire conversion runs locally in your browser. No server uploads, no processing queues — your files stay on your device at all times.",
			},
			{
				title: "Works with iPhone & Mac Recordings",
				description:
					"Convert MOV files from iPhones, iPads, and macOS screen recordings to universally compatible MP4. Supports both H.264 and HEVC QuickTime files.",
			},
			{
				title: "Universal MP4 Output",
				description:
					"The output is a standard H.264 MP4 file that plays on Windows, Android, smart TVs, and every video hosting platform including YouTube, Vimeo, and Google Drive.",
			},
			{
				title: "Complete Privacy",
				description:
					"Your video files never leave your device. Unlike other online converters that upload your content to remote servers, all processing happens client-side.",
			},
			{
				title: "No Sign-Up or Installation",
				description:
					"No software downloads, browser extensions, or accounts required. Just open the page and start converting — works instantly in Chrome, Edge, and Brave.",
			},
			{
				title: "Unlimited Free Conversions",
				description:
					"Convert as many MOV files to MP4 as you need with no daily limits, no watermarks, and no hidden fees.",
			},
		],
		faqs,
		cta: {
			title: "Cap is the open source Loom alternative",
			description:
				"Record, edit, and share video messages with Cap. 100% open source and privacy focused. Records directly to MP4 — no conversion needed.",
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
					<MediaFormatConverter initialConversionPath="mov-to-mp4" />
				}
			/>
		</>
	);
}
