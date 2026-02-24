import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "WebM to MP4 Converter — Free Online Video Converter | Cap",
	description:
		"Convert WebM videos to MP4 format directly in your browser. Free, private, no upload needed. Works with browser screen recordings, OBS exports, and any WebM video file.",
	keywords: [
		"webm to mp4 converter",
		"convert webm to mp4 online",
		"free webm to mp4",
		"webm to mp4 no upload",
		"browser webm converter",
		"webm to mp4 free online",
		"convert webm video online",
		"screen recording webm to mp4",
	],
	openGraph: {
		title: "WebM to MP4 Converter — Free Online Video Converter | Cap",
		description:
			"Convert WebM videos to the universally compatible MP4 format directly in your browser. No uploads, no installs, 100% private. Works with browser screen recordings and any WebM file.",
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
			"Convert WebM to MP4 directly in your browser. No uploads, no installs, 100% private.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/webm-to-mp4",
	},
};

const faqs = [
	{
		question: "How do I convert WebM to MP4 online?",
		answer:
			"Open Cap's WebM to MP4 converter, drag and drop your WebM file (or click to browse), then click Convert. The entire process runs in your browser — your file never leaves your device. Once complete, click Download to save the MP4 file.",
	},
	{
		question: "Is the WebM to MP4 converter free?",
		answer:
			"Yes, completely free with no limits on the number of conversions. There are no watermarks, no sign-up required, and no hidden fees. The converter runs entirely in your browser at zero cost.",
	},
	{
		question: "Why convert WebM to MP4?",
		answer:
			"WebM is an open-source format developed by Google using VP8 or VP9 video codecs — it's the default output of browser-based screen recorders, Chrome MediaRecorder, and many web-based tools. However, WebM files are not supported by iPhones, many Android video editors, Windows Media Player, or social platforms like Instagram and TikTok. MP4 (H.264) is the universal standard supported by virtually every device, platform, browser, and video hosting service. Converting to MP4 ensures your video plays anywhere without compatibility issues.",
	},
	{
		question: "Will converting WebM to MP4 reduce video quality?",
		answer:
			"Quality is preserved as closely as possible during conversion. The converter re-encodes to H.264 MP4 at high quality settings, which is visually lossless for most use cases. For sharing, uploading, or playing on other devices, the output quality will look identical to the original.",
	},
	{
		question: "Is there a file size limit?",
		answer:
			"The converter supports WebM files up to 500 MB. For smooth in-browser performance, files under 200 MB convert fastest. For very large WebM files, consider trimming the video first to keep only the section you need.",
	},
	{
		question: "Does this work with screen recording WebM files?",
		answer:
			"Yes. Browser-based screen recorders, Chrome extensions, and tools using the MediaRecorder API typically produce VP8 or VP9 WebM files. Cap's converter handles both VP8 and VP9 WebM files and outputs a universally compatible H.264 MP4.",
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
		name: "Upload your WebM file",
		text: "Open Cap's WebM to MP4 converter and drag and drop your WebM file into the upload area, or click to browse your files. Supports WebM files up to 500 MB, including VP8 and VP9 encoded files from screen recorders.",
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

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "Tools", url: "https://cap.so/tools" },
	{ name: "Convert", url: "https://cap.so/tools/convert" },
	{
		name: "WebM to MP4 Converter",
		url: "https://cap.so/tools/convert/webm-to-mp4",
	},
]);

export default function WebmToMp4Page() {
	const pageContent: ToolPageContent = {
		title: "WebM to MP4 Converter",
		description:
			"Convert WebM videos — including browser screen recordings and VP9 files — to the universally compatible MP4 format directly in your browser — free, private, and no installation required",
		featuresTitle: "Why Use This WebM to MP4 Converter",
		featuresDescription:
			"A fast, free, and private way to convert WebM videos to MP4 — entirely in your browser with no uploads and no quality loss.",
		features: [
			{
				title: "100% Browser-Based",
				description:
					"The entire conversion runs locally in your browser. No server uploads, no processing queues — your files stay on your device at all times.",
			},
			{
				title: "Works with Screen Recording Output",
				description:
					"Most browser-based screen recorders, Chrome extensions, and MediaRecorder tools output WebM files. Cap's converter handles VP8 and VP9 WebM files and turns them into shareable MP4s.",
			},
			{
				title: "Universal MP4 Output",
				description:
					"The output is a standard H.264 MP4 file that plays on iPhones, Android phones, smart TVs, and every video hosting platform including YouTube, Vimeo, and Google Drive.",
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
					"Convert as many WebM files to MP4 as you need with no daily limits, no watermarks, and no hidden fees.",
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
					__html: JSON.stringify(breadcrumbSchema),
				}}
			/>
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
