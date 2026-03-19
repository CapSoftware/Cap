import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "AVI to MP4 Converter — Free Online Video Converter | Cap",
	description:
		"Convert AVI videos to MP4 format directly in your browser. Free, private, no upload needed. Works with old camcorder footage, downloaded files, and any AVI video.",
	keywords: [
		"avi to mp4 converter",
		"convert avi to mp4 online",
		"free avi to mp4",
		"avi to mp4 no upload",
		"browser avi converter",
		"avi to mp4 free online",
		"convert avi video online",
	],
	openGraph: {
		title: "AVI to MP4 Converter — Free Online Video Converter | Cap",
		description:
			"Convert AVI videos to the universally compatible MP4 format directly in your browser. No uploads, no installs, 100% private. Works with camcorder footage and any AVI file.",
		url: "https://cap.so/tools/convert/avi-to-mp4",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap AVI to MP4 Converter — Free Online Video Converter",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "AVI to MP4 Converter — Free Online Video Converter | Cap",
		description:
			"Convert AVI to MP4 directly in your browser. No uploads, no installs, 100% private.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/avi-to-mp4",
	},
};

const faqs = [
	{
		question: "How do I convert AVI to MP4 online?",
		answer:
			"Open Cap's AVI to MP4 converter, drag and drop your AVI file (or click to browse), then click Convert. The entire process runs in your browser — your file never leaves your device. Once complete, click Download to save the MP4 file.",
	},
	{
		question: "Is the AVI to MP4 converter free?",
		answer:
			"Yes, completely free with no limits on the number of conversions. There are no watermarks, no sign-up required, and no hidden fees. The converter runs entirely in your browser at zero cost.",
	},
	{
		question: "Why convert AVI to MP4?",
		answer:
			"AVI (Audio Video Interleave) is a legacy Microsoft format from 1992 with limited support on modern devices. iPhones, iPads, Android phones, and smart TVs often cannot play AVI files. MP4 (H.264) is the universal standard supported by virtually every device, platform, browser, and video hosting service. Converting to MP4 ensures your video plays anywhere without compatibility issues.",
	},
	{
		question: "Will converting AVI to MP4 reduce video quality?",
		answer:
			"Quality is preserved as closely as possible during conversion. The converter re-encodes to H.264 MP4 at high quality settings, which is visually lossless for most use cases. For sharing, uploading, or playing on other devices, the output quality will look identical to the original.",
	},
	{
		question: "Is there a file size limit?",
		answer:
			"The converter supports AVI files up to 500 MB. For smooth in-browser performance, files under 200 MB convert fastest. For very large AVI files, consider trimming the video first to keep only the section you need.",
	},
	{
		question: "Does this work with old camcorder AVI files?",
		answer:
			"Yes. AVI files from older camcorders, digital cameras, and screen recording software are all supported. The converter handles the most common AVI video codecs including DivX, Xvid, and uncompressed formats.",
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
		name: "Upload your AVI file",
		text: "Open Cap's AVI to MP4 converter and drag and drop your AVI file into the upload area, or click to browse your files. Supports AVI files up to 500 MB.",
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
	name: "How to Convert AVI to MP4 Online",
	description:
		"Convert AVI video files to MP4 format for free using Cap's browser-based converter. No upload required.",
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
		name: "AVI to MP4 Converter",
		url: "https://cap.so/tools/convert/avi-to-mp4",
	},
]);

export default function AVIToMP4Page() {
	const pageContent: ToolPageContent = {
		title: "AVI to MP4 Converter",
		description:
			"Convert legacy AVI videos to the universally compatible MP4 format directly in your browser — free, private, and no installation required",
		featuresTitle: "Why Use This AVI to MP4 Converter",
		featuresDescription:
			"A fast, free, and private way to convert AVI files to MP4 — entirely in your browser with no uploads and no quality loss.",
		features: [
			{
				title: "100% Browser-Based",
				description:
					"The entire conversion runs locally in your browser. No server uploads, no processing queues — your files stay on your device at all times.",
			},
			{
				title: "Works with Old Camcorder & Downloaded Files",
				description:
					"Convert AVI files from old camcorders, downloaded movies, and legacy screen recordings to modern MP4. Supports DivX, Xvid, and uncompressed AVI formats.",
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
					"Convert as many AVI files to MP4 as you need with no daily limits, no watermarks, and no hidden fees.",
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
					<MediaFormatConverter initialConversionPath="avi-to-mp4" />
				}
			/>
		</>
	);
}
