import type { Metadata } from "next";
import { LoomDownloader } from "@/components/tools/LoomDownloader";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";

export const metadata: Metadata = {
	title: "Loom Video Downloader — Download Loom Videos Free Online | Cap",
	description:
		"Download any Loom video for free with Cap's online Loom video downloader. No signup, no software needed — just paste your Loom link and save the MP4 instantly.",
	keywords: [
		"loom video downloader",
		"download loom video",
		"loom downloader",
		"save loom video",
		"loom video download free",
		"loom to mp4",
		"download loom recording",
		"loom video saver",
		"free loom downloader",
		"loom download tool",
		"import loom videos",
		"loom video importer",
		"migrate from loom",
	],
	openGraph: {
		title: "Loom Video Downloader — Download Loom Videos Free | Cap",
		description:
			"Download any Loom video for free. Paste the link, get the MP4. No signup required. Built by Cap, the open source Loom alternative.",
		url: "https://cap.so/tools/loom-downloader",
		siteName: "Cap",
		type: "website",
		images: [
			{
				url: "/og.png",
				width: 1200,
				height: 630,
				alt: "Cap — Free Loom Video Downloader",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "Loom Video Downloader — Download Loom Videos Free | Cap",
		description:
			"Download any Loom video for free. Paste the link, get the MP4. No signup required.",
		images: ["/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/loom-downloader",
	},
};

const pageContent: ToolPageContent = {
	title: "Loom Video Downloader",
	description:
		"Download any public Loom video as an MP4 file. Just paste the link — no account, no installs, completely free.",
	featuresTitle: "Why Use Cap's Loom Video Downloader?",
	featuresDescription:
		'Cap\'s Loom downloader is fast, free, and requires zero setup. Built by the team behind <a href="/">Cap — the open source Loom alternative</a>.',
	features: [
		{
			title: "Instant Downloads",
			description:
				"Paste a Loom link and get your MP4 in seconds. No waiting, no queues, no processing delays.",
		},
		{
			title: "No Account Required",
			description:
				"No signup, no login, no email. Just paste your Loom URL and download the video immediately.",
		},
		{
			title: "100% Free",
			description:
				"Completely free to use with no limits. Download as many Loom videos as you need, whenever you need them.",
		},
		{
			title: "Works with Any Public Loom Video",
			description:
				"Supports all public Loom video links including share links, embed links, and direct URLs.",
		},
		{
			title: "Nothing Stored on Our Servers",
			description:
				"We only fetch the download URL from Loom's servers. Your videos are never uploaded to or stored on Cap.",
		},
		{
			title: "MP4 Format",
			description:
				"Videos are downloaded in MP4 format — the most widely supported video format across all devices and platforms.",
		},
	],
	faqs: [
		{
			question: "How do I download a Loom video?",
			answer:
				'Simply paste the Loom video URL into the input field above and click "Download Video". The MP4 file will start downloading automatically. You can find Loom URLs by clicking the share button on any Loom video.',
		},
		{
			question: "Is this Loom video downloader free?",
			answer:
				"Yes, 100% free with no limits. There's no signup required, no premium tier, and no restrictions on the number of downloads.",
		},
		{
			question: "Can I download private Loom videos?",
			answer:
				"No, this tool only works with publicly accessible Loom videos. If a video requires a password or is set to private, you'll need to ask the video creator to make it public or share the download directly.",
		},
		{
			question: "What video format are downloads in?",
			answer:
				"All Loom videos are downloaded in MP4 format, which is compatible with virtually every device, media player, and video editor.",
		},
		{
			question: "Is there a file size limit?",
			answer:
				"There's no file size limit on our end. The download size depends on the length and quality of the original Loom recording.",
		},
		{
			question: "Why can't I download a specific Loom video?",
			answer:
				"Some Loom videos may be restricted by the creator (private, password-protected, or expired links). Make sure the video is publicly accessible. If you see an error, double-check that the URL is correct and the video hasn't been deleted.",
		},
		{
			question: "Do you store my downloaded videos?",
			answer:
				"No. We never store, cache, or process your videos. Our server simply fetches the direct download URL from Loom and passes it to your browser. The video downloads directly from Loom's servers to your device.",
		},
		{
			question:
				"Can I import my Loom videos into Cap instead of downloading them?",
			answer:
				'Yes! Cap Pro includes a built-in <a href="/loom-alternative">Loom video importer</a> that lets you transfer your Loom recordings directly into your Cap library. It\'s the easiest way to migrate from Loom without manually downloading and re-uploading each video.',
		},
		{
			question: "What is Cap?",
			answer:
				'Cap is the <a href="/">open source alternative to Loom</a>. It\'s a lightweight, privacy-focused screen recorder that lets you record, edit, and share videos instantly. If you\'re looking for a Loom replacement, <a href="/download">download Cap for free</a>.',
		},
	],
	cta: {
		title: "Looking for a Loom alternative?",
		description:
			"Cap is the open source screen recorder that gives you full control. Record, edit, and share — all for free. Plus, import your existing Loom videos directly into Cap with our built-in Loom video importer.",
		buttonText: "Download Cap Free",
	},
};

export default function LoomDownloaderPage() {
	return (
		<ToolsPageTemplate
			content={pageContent}
			toolComponent={<LoomDownloader />}
		/>
	);
}
