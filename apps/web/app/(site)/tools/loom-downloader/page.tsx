import type { Metadata } from "next";
import { LoomDownloader } from "@/components/tools/LoomDownloader";
import { ToolsPageTemplate } from "@/components/tools/ToolsPageTemplate";
import type { ToolPageContent } from "@/components/tools/types";
import { createBreadcrumbSchema } from "@/utils/web-schema";

export const metadata: Metadata = {
	title:
		"Loom Video Downloader — Download Loom Videos Free + Migrate to Cap | Cap",
	description:
		"Download any Loom video for free with Cap's online Loom video downloader. Then migrate your entire Loom library to Cap — the open source Loom alternative — with 20% off using code MIGRATE20.",
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
		"loom to cap migration",
		"loom alternative",
		"switch from loom",
	],
	openGraph: {
		title: "Loom Video Downloader — Free Download + Migrate to Cap",
		description:
			"Download any Loom video for free. Then migrate your whole Loom library to Cap and save 20% with MIGRATE20. Built by Cap, the open source Loom alternative.",
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
		title: "Loom Video Downloader — Free Download + Migrate to Cap",
		description:
			"Download any Loom video for free — then migrate your whole library to Cap with 20% off using MIGRATE20.",
		images: ["/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/tools/loom-downloader",
	},
};

const pageContent: ToolPageContent = {
	title: "Loom Video Downloader",
	description:
		"Download any public Loom video as an MP4 — or skip the one-by-one downloads and migrate your whole Loom library to Cap with 20% off using code MIGRATE20.",
	featuresTitle: "Download Loom videos, then move your whole library to Cap",
	featuresDescription:
		"Cap's Loom downloader is free, fast, and requires zero setup. When you're ready to leave Loom for good, Cap Pro's built-in <a href=\"/loom-alternative\">Loom video importer</a> moves your entire workspace in one click.",
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
			title: "100% Free to Download",
			description:
				"Completely free with no limits on downloads. Save as many Loom videos as you need — then switch to Cap to stop paying Loom's $18/user/month.",
		},
		{
			title: "Import Your Whole Loom Library",
			description:
				'Cap Pro includes a built-in <a href="/loom-alternative">Loom video importer</a> that transfers every Loom video you\'ve recorded — titles, transcripts, and chapters included — without manual re-uploads.',
		},
		{
			title: "Half the Price of Loom",
			description:
				"Cap Pro starts from just $8.16/user/month vs Loom's $18/user/month. Use code <strong>MIGRATE20</strong> at checkout for an extra 20% off your first year.",
		},
		{
			title: "Open Source & Privacy-First",
			description:
				'Cap is the <a href="/">open source Loom alternative</a>. Bring your own S3 bucket, connect your own domain, and own 100% of your video data.',
		},
	],
	faqs: [
		{
			question: "How do I download a Loom video?",
			answer:
				'Paste the Loom video URL into the input above and click "Download Video". The MP4 file will start downloading automatically. You can find Loom URLs by clicking the share button on any Loom video.',
		},
		{
			question: "Is this Loom video downloader free?",
			answer:
				"Yes, 100% free with no limits. There's no signup required, no premium tier, and no cap on the number of videos you can download.",
		},
		{
			question: "What is MIGRATE20 and how do I use it?",
			answer:
				'<strong>MIGRATE20</strong> is a 20% discount code for new Cap Pro subscribers who are switching from Loom. Just apply it at <a href="/pricing">checkout on the pricing page</a> to take 20% off your first year of Cap Pro — including the built-in Loom video importer.',
		},
		{
			question: "Can I import all my Loom videos into Cap at once?",
			answer:
				'Yes. Cap Pro\'s built-in <a href="/loom-alternative">Loom video importer</a> connects to your Loom workspace and transfers every video in one go — titles, transcripts, chapters, and all — without you having to download and re-upload anything manually.',
		},
		{
			question: "Why migrate from Loom to Cap?",
			answer:
				"Cap is the open source Loom alternative built for teams that care about data ownership and price. You get unlimited cloud storage, instant shareable links, AI captions, custom domains, and your own S3 bucket — all from $8.16/user/month vs Loom's $18/user/month. Use MIGRATE20 for an additional 20% off.",
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
			question: "Do you store my downloaded videos?",
			answer:
				"No. We never store, cache, or process your videos. Our server simply fetches the direct download URL from Loom and passes it to your browser. The video downloads directly from Loom's servers to your device.",
		},
		{
			question: "What is Cap?",
			answer:
				'Cap is the <a href="/">open source alternative to Loom</a>. It\'s a privacy-focused screen recorder that lets you record, edit, and share videos instantly — with unlimited storage, custom domains, and a built-in Loom video importer. <a href="/download">Download Cap for free</a>.',
		},
	],
	cta: {
		title: "Ready to leave Loom for good?",
		description:
			"Skip the one-by-one downloads. Cap Pro imports your entire Loom library in one click — and costs half what Loom charges. Use MIGRATE20 at checkout for an extra 20% off your first year.",
		buttonText: "Migrate to Cap Pro — save 20%",
		buttonHref:
			"/pricing?promo=MIGRATE20&utm_source=loom-downloader&utm_campaign=migrate20",
		secondaryButtonText: "Download Cap free",
		secondaryButtonHref: "/download",
	},
};

const breadcrumbSchema = createBreadcrumbSchema([
	{ name: "Home", url: "https://cap.so" },
	{ name: "Tools", url: "https://cap.so/tools" },
	{
		name: "Loom Video Downloader",
		url: "https://cap.so/tools/loom-downloader",
	},
]);

export default function LoomDownloaderPage() {
	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(breadcrumbSchema),
				}}
			/>
			<ToolsPageTemplate
				content={pageContent}
				toolComponent={<LoomDownloader />}
			/>
		</>
	);
}
