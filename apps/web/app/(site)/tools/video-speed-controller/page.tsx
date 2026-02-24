import type { Metadata } from "next";
import { SpeedController } from "@/components/tools/SpeedController";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title:
		"Video Speed Controller Online – Speed Up or Slow Down Videos Free | Cap",
	description:
		"Free online video speed controller. Adjust playback from 0.25× to 3× without quality loss — processed locally in your browser for complete privacy. No uploads required.",
	keywords: [
		"video speed controller",
		"speed up video online",
		"slow down video online",
		"change video playback speed",
		"adjust video speed in browser",
		"video speed changer free",
		"online video speed controller",
	],
	openGraph: {
		title:
			"Video Speed Controller Online – Speed Up or Slow Down Videos Free | Cap",
		description:
			"Adjust video playback speed from 0.25× to 3× directly in your browser. Free, private, no uploads — works with MP4, WebM, MOV, AVI and MKV.",
		url: "https://cap.so/tools/video-speed-controller",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap Video Speed Controller — Free Online Video Speed Changer",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title:
			"Video Speed Controller Online – Speed Up or Slow Down Videos Free | Cap",
		description:
			"Adjust video playback speed from 0.25× to 3× directly in your browser. Free, private, no uploads required.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/video-speed-controller",
	},
};

const faqs = [
	{
		question: "How do I change the speed of a video online?",
		answer:
			"Open Cap's Video Speed Controller, drag and drop your video file (or click to browse), select your target speed from 0.25× to 3×, then click Speed Up or Slow Down Video. The entire process runs in your browser — your file never leaves your device. Once processing is complete, preview and download the result.",
	},
	{
		question: "What video formats does the speed controller support?",
		answer:
			"MP4, WebM, MOV, AVI and MKV are all supported — essentially any video format modern browsers can decode. Chrome is recommended for the best compatibility and performance.",
	},
	{
		question: "Is the video speed controller free?",
		answer:
			"Yes, completely free with no limits on the number of videos you can process. There are no watermarks, no sign-up required, and no hidden fees. The tool runs entirely in your browser at zero cost.",
	},
	{
		question: "Will my video quality change when I adjust the speed?",
		answer:
			"No. The tool preserves your original resolution and bitrate — only the playback speed changes. There is no re-encoding that degrades visual quality. Audio pitch is also automatically corrected to stay natural at the new speed.",
	},
	{
		question: "Is there a file size limit?",
		answer:
			"Up to 500 MB for smooth in-browser performance. For larger files, consider trimming the video first to keep only the section you need, then adjusting the speed.",
	},
	{
		question: "Why is processing taking a long time?",
		answer:
			"Browser-based video processing relies on your device's hardware. Older CPUs or GPUs, throttled mobile devices, and very long or high-resolution videos will take longer. For fastest results, use Chrome on a modern desktop or laptop.",
	},
	{
		question: "Does this work on iPhone or Android?",
		answer:
			"Yes — modern Safari, Chrome, and Firefox on mobile are supported, though Chrome on desktop delivers the most reliable performance. If you encounter issues on mobile, try Chrome or Firefox instead of the default browser.",
	},
	{
		question: "Do I need to install any software?",
		answer:
			"No. The tool runs entirely in your browser — no downloads, no plugins, no extensions required. Just open the page and start adjusting your video speed. All processing happens locally on your device for complete privacy.",
	},
];

const howToSteps = [
	{
		name: "Upload your video file",
		text: "Open Cap's Video Speed Controller and drag and drop your video into the upload area, or click to browse your files. Supported formats include MP4, WebM, MOV, AVI, and MKV up to 500 MB.",
	},
	{
		name: "Select your target speed",
		text: "Choose a playback speed from the options: 0.25× (very slow) up to 3× (ultra fast). The tool shows an estimated output duration so you know exactly how long the processed video will be.",
	},
	{
		name: "Process and download your video",
		text: "Click Speed Up or Slow Down Video. Processing runs entirely in your browser — nothing is uploaded to any server. Once complete, preview the result and click Download to save the speed-adjusted video.",
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
	name: "How to Change Video Speed Online",
	description:
		"Adjust the playback speed of any video for free using Cap's browser-based speed controller. No upload required.",
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
	{
		name: "Video Speed Controller",
		url: "https://cap.so/tools/video-speed-controller",
	},
]);

export default function SpeedControllerPage() {
	const pageContent: ToolPageContent = {
		title: "Video Speed Controller (0.25×–3×)",
		description:
			"Speed up or slow down any video directly in your browser — free, private, and no installation required",
		featuresTitle: "Why Use This Online Video Speed Controller",
		featuresDescription:
			"A fast, free, and private way to adjust video speed — entirely in your browser with no uploads and no quality loss.",
		features: [
			{
				title: "100% Browser-Based",
				description:
					"All processing runs locally in your browser. No server uploads, no processing queues — your files stay on your device at all times.",
			},
			{
				title: "Wide Speed Range (0.25×–3×)",
				description:
					"Dial in super-slow 0.25× for step-by-step tutorials, or crank up to 3× for quick demos. Audio pitch is automatically corrected to stay natural at any speed.",
			},
			{
				title: "No Quality Loss",
				description:
					"The tool preserves your original resolution and bitrate. Only the playback speed changes — there is no re-encoding that degrades visual quality.",
			},
			{
				title: "Complete Privacy",
				description:
					"Your video files never leave your device. Unlike other online tools that upload your content to remote servers, all processing happens client-side.",
			},
			{
				title: "No Sign-Up or Installation",
				description:
					"No software downloads, browser extensions, or accounts required. Just open the page and start adjusting — works instantly in Chrome, Edge, and Brave.",
			},
			{
				title: "Supports All Common Formats",
				description:
					"Works with MP4, WebM, MOV, AVI, and MKV files up to 500 MB. Compatible with screen recordings, tutorials, product demos, and any other video content.",
			},
		],
		faqs,
		cta: {
			title: "Cap is the open source Loom alternative",
			description:
				"Record, edit, and share video messages with Cap. 100% open source and privacy focused. No speed adjustments needed — just hit record.",
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
				toolComponent={<SpeedController />}
			/>
		</>
	);
}
