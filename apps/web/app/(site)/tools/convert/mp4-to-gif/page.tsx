import type { Metadata } from "next";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title: "MP4 to GIF Converter — Free Online Animated GIF Maker | Cap",
	description:
		"Convert MP4 videos to animated GIF images directly in your browser. Free, private, no upload needed. Adjust FPS, quality, and dimensions for the perfect GIF.",
	openGraph: {
		title: "MP4 to GIF Converter — Free Online Animated GIF Maker | Cap",
		description:
			"Convert MP4 to animated GIF directly in your browser. No uploads, no installs, 100% private. Customize FPS, quality, and size.",
		url: "https://cap.so/tools/convert/mp4-to-gif",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap MP4 to GIF Converter — Free Online Animated GIF Maker",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "MP4 to GIF Converter — Free Online Animated GIF Maker | Cap",
		description:
			"Convert MP4 to animated GIF directly in your browser. No uploads, no installs, 100% private.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/convert/mp4-to-gif",
	},
};

const faqs = [
	{
		question: "How do I convert MP4 to GIF?",
		answer:
			"Open the Cap MP4 to GIF converter, drag and drop your MP4 file (or click to browse), adjust your settings if needed, then click Convert. The entire process runs in your browser — your file never leaves your device. Once complete, download the GIF instantly.",
	},
	{
		question: "Is the MP4 to GIF converter free?",
		answer:
			"Yes, completely free with no limits on the number of conversions. There are no watermarks, no sign-up required, and no hidden fees. The converter runs entirely in your browser at zero cost.",
	},
	{
		question: "What quality settings can I adjust?",
		answer:
			"You can customize the frame rate (5–30 FPS), quality level (1–20, where lower means smaller file size), maximum width (240–1280px), and toggle dithering on or off. Dithering improves color gradients in GIFs at the cost of a larger file size.",
	},
	{
		question: "Will the GIF be smaller than the original MP4?",
		answer:
			"Usually not. GIFs are often larger than MP4 videos because the GIF format supports a limited 256-color palette per frame and lacks modern compression. For smaller file sizes, lower the FPS, reduce the max width, or increase the quality number (which reduces quality but shrinks file size).",
	},
	{
		question: "What frame rate should I use for GIFs?",
		answer:
			"10–15 FPS is the standard for web GIFs and produces smooth-looking animations without excessive file size. For short, action-heavy clips you may want 20–30 FPS. For looping backgrounds or simple animations, 10 FPS or lower is usually sufficient.",
	},
	{
		question: "Is there a file size limit?",
		answer:
			"The converter supports MP4 files up to 500 MB. For smooth in-browser performance, keep source files short (under 30 seconds) since longer videos produce very large GIFs. For longer content, consider exporting a trimmed clip first.",
	},
	{
		question: "Does this converter work on mobile?",
		answer:
			"The converter works best on desktop browsers (Chrome, Edge, Brave). Mobile browser support for the underlying video decoding APIs is still limited, so desktop is recommended for reliable results.",
	},
	{
		question: "Do I need to install any software?",
		answer:
			"No. The converter runs entirely in your browser — no downloads, no plugins, no extensions required. Just open the page and start converting. All processing happens locally on your device for complete privacy.",
	},
];

const howToSteps = [
	{
		name: "Upload your MP4 file",
		text: "Open the Cap MP4 to GIF converter and drag and drop your MP4 file into the upload area, or click to browse your files.",
	},
	{
		name: "Adjust conversion settings",
		text: "Optionally customize the frame rate, quality, maximum width, and dithering to balance GIF quality and file size.",
	},
	{
		name: "Convert and download your GIF",
		text: "Click Convert. The file is processed entirely in your browser — nothing is uploaded to any server. Once done, click Download to save the animated GIF.",
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
	name: "How to Convert MP4 to GIF Online",
	description:
		"Convert MP4 video files to animated GIF format for free using Cap's browser-based converter. No upload required.",
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
		name: "MP4 to GIF Converter",
		url: "https://cap.so/tools/convert/mp4-to-gif",
	},
]);

export default function MP4ToGIFPage() {
	const pageContent: ToolPageContent = {
		title: "MP4 to GIF Converter",
		description:
			"Convert MP4 videos to animated GIF images directly in your browser — free, private, and no installation required",
		featuresTitle: "Why Use This MP4 to GIF Converter",
		featuresDescription:
			"A fast, free, and private way to turn MP4 videos into animated GIFs — entirely in your browser with full control over output settings.",
		features: [
			{
				title: "100% Browser-Based",
				description:
					"The entire conversion runs locally in your browser. No server uploads, no waiting for processing queues — your files stay on your device at all times.",
			},
			{
				title: "Customizable Output Settings",
				description:
					"Control frame rate (5–30 FPS), quality (1–20), max width (240–1280px), and dithering to fine-tune the balance between GIF quality and file size.",
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
					"Convert as many MP4 files to GIF as you need with no daily limits, no watermarks, and no hidden fees.",
			},
			{
				title: "Handles Any MP4 Content",
				description:
					"Works with screen recordings, gameplay clips, product demos, tutorials, and any other MP4 video. Supports H.264 and other common codecs.",
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
					<MediaFormatConverter initialConversionPath="mp4-to-gif" />
				}
			/>
		</>
	);
}
