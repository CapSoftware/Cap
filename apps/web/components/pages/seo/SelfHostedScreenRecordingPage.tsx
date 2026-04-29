"use client";

import { Clapperboard, Zap } from "lucide-react";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const selfHostedScreenRecordingContent: SeoPageContent = {
	title:
		"Self-Hosted Screen Recording — Own Your Data, Own Your Infrastructure",
	description:
		"Cap lets you self-host screen recordings on your own S3-compatible storage. Connect AWS S3, Cloudflare R2, MinIO, or Backblaze and every recording goes directly to your infrastructure. Open source, no vendor lock-in, full data sovereignty.",

	badge: "Self-Hosting",

	featuresTitle: "Everything You Need in a Self-Hosted Screen Recorder",
	featuresDescription:
		"Cap gives teams complete control over where recordings are stored, without sacrificing the instant sharing experience",

	features: [
		{
			title: "Connect Any S3-Compatible Storage",
			description:
				"Cap supports AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi, and any other S3-compatible object storage. Configure your bucket credentials once in Cap's settings and every recording uploads directly to your infrastructure — not Cap's cloud.",
		},
		{
			title: "Recordings Never Touch Third-Party Servers",
			description:
				"With self-hosted storage configured, video files travel from the Cap desktop app directly to your storage bucket. No recording data passes through Cap's servers. You maintain full custody and chain of possession for every file.",
		},
		{
			title: "Self-Host the Entire Cap Platform",
			description:
				"Go beyond storage — deploy the complete Cap web platform on your own infrastructure. The dashboard, sharing layer, API, and all services run within your network perimeter. Full control over the entire recording and sharing pipeline.",
		},
		{
			title: "Open Source and Auditable",
			description:
				"Cap is MIT-licensed and fully open source on GitHub. Your security team can audit every line of code that handles recording, uploading, and sharing. No black-box behavior, no undisclosed data flows — complete transparency for enterprise security reviews.",
		},
		{
			title: "Instant Shareable Links from Your Own Storage",
			description:
				"Self-hosted storage doesn't mean sacrificing the instant sharing experience. Stop recording, get a shareable link immediately — but the video is served from your S3 bucket, not Cap's CDN. Your infrastructure, your links, Cap's instant-share UX.",
		},
		{
			title: "Password-Protected Sharing",
			description:
				"Add a password to any shared recording. Combined with self-hosted storage, you control both where the video is stored and who can access it. Perfect for internal teams, client deliverables, or any content requiring restricted access.",
		},
		{
			title: "4K Recording at 60fps",
			description:
				"Self-hosting doesn't mean downgrading quality. Cap records your screen at up to 4K resolution and 60 frames per second with system audio and webcam overlay. High-quality recordings stored exactly where you want them.",
		},
		{
			title: "Custom Domain Support",
			description:
				"Serve Cap's sharing pages from your own custom domain. Combined with self-hosted storage, recordings are fully within your brand and infrastructure — from the video file in your S3 bucket to the sharing link your viewers click.",
		},
	],

	recordingModes: {
		title: "Two Self-Hostable Recording Modes",
		description:
			"Both Cap recording modes work fully with self-hosted storage — choose the right workflow for your team",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Record and get a shareable link the moment you stop. With self-hosted storage, that link points to video in your S3 bucket. Ideal for quick team updates, bug reports, and async communication where speed matters and data residency is required.",
			},
			{
				icon: (
					<Clapperboard
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Studio Mode",
				description:
					"Record screen and webcam as separate tracks with no time limits. Completely free for personal use. Studio Mode recordings upload to your configured S3 bucket, giving you separate video files for post-production editing and full control over storage lifecycle.",
			},
		],
	},

	comparisonTable: {
		title: "Self-Hosted Cap vs Other Screen Recorders",
		headers: ["Feature", "Cap (Self-Hosted)", "Loom", "Vidyard", "Panopto"],
		rows: [
			[
				"Self-hosted storage",
				{ text: "Yes — any S3", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "On-premise only", status: "warning" },
			],
			[
				"Self-hostable platform",
				{ text: "Yes — full stack", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "Yes (enterprise)", status: "warning" },
			],
			[
				"Open source",
				{ text: "Yes — MIT", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Instant share links",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
			],
			[
				"4K recording",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "Yes", status: "positive" },
			],
			[
				"AI captions",
				{ text: "Yes (optional)", status: "positive" },
				{ text: "Paid only", status: "warning" },
				{ text: "Paid only", status: "warning" },
				{ text: "Paid only", status: "warning" },
			],
			[
				"Free tier",
				{ text: "Yes — Studio Mode", status: "positive" },
				{ text: "Limited", status: "warning" },
				{ text: "Limited", status: "warning" },
				{ text: "No", status: "negative" },
			],
			[
				"Auditable code",
				{ text: "Yes — full codebase", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
		],
	},

	comparisonTitle: "Why Self-Host Your Screen Recordings with Cap",
	comparisonDescription:
		"Most screen recorders lock your data to their cloud — Cap is built from the ground up to run entirely on your own infrastructure",

	comparison: [
		{
			title: "Cap vs Loom for Self-Hosting",
			description:
				"Loom offers no self-hosting option. Every recording is stored on Loom's servers, and if Loom changes pricing or shuts down, your video library is at risk. Cap supports custom S3 storage so your recordings live in your bucket forever, regardless of what happens to Cap's cloud offering. <a href='/loom-alternative'>See the full Cap vs Loom comparison</a>.",
		},
		{
			title: "Cap vs Panopto for Self-Hosting",
			description:
				"Panopto offers on-premise deployment for enterprise customers at significant cost. Cap's self-hosting is available to any team — configure your S3 bucket in minutes, or deploy the full platform from the open-source repository. No enterprise contract required.",
		},
		{
			title: "Cap vs OBS for Self-Hosted Recording",
			description:
				"OBS records locally but lacks any sharing or collaboration layer. Cap gives you OBS-level data control — recordings stay on your infrastructure — combined with async sharing links, thread commenting, and a web dashboard your team can actually use.",
		},
		{
			title: "Cap for Regulated Industries",
			description:
				"Healthcare, finance, legal, and government teams face strict data residency requirements. Cap with self-hosted S3 storage keeps recordings within your regulated environment. Combined with open-source auditability, Cap satisfies the compliance requirements that closed-source SaaS tools can't meet. <a href='/hipaa-compliant-screen-recording'>Learn about HIPAA-compliant recording with Cap</a>.",
		},
	],

	useCasesTitle: "Who Uses Self-Hosted Screen Recording",
	useCasesDescription:
		"Teams across industries choose Cap's self-hosted storage when data residency, compliance, or cost control matters",

	useCases: [
		{
			title: "Enterprise IT and Security Teams",
			description:
				"Organizations with strict data governance policies use Cap with self-hosted S3 to ensure recording content never leaves their cloud environment. Security teams can audit Cap's open-source codebase to verify exactly what data is transmitted and where it goes.",
		},
		{
			title: "Healthcare Organizations",
			description:
				"Cap with AWS S3 self-hosting keeps recorded content within HIPAA-eligible infrastructure. Clinical training videos, EHR walkthroughs, and patient education recordings stay on your AWS account — covered by your existing BAA. <a href='/hipaa-compliant-screen-recording'>Learn more about HIPAA-compliant recording</a>.",
		},
		{
			title: "Financial Services and Legal Teams",
			description:
				"Banks, law firms, and financial institutions with data residency or jurisdiction requirements deploy Cap with S3-compatible storage in their approved regions. Recordings never traverse unapproved infrastructure, satisfying regulatory and legal hold requirements.",
		},
		{
			title: "Developer and Engineering Teams",
			description:
				"Engineers who want to verify what software does with their data run Cap with self-hosted storage. Record bug reports, architecture walkthroughs, and code reviews — all stored in your team's S3 bucket. Open-source code means the data handling is verifiable, not just promised.",
		},
		{
			title: "Agencies and Client Services Teams",
			description:
				"Agencies handling client work use Cap with self-hosted storage to keep client recording content isolated per project or client bucket. No client data commingles with other customers on a shared SaaS platform.",
		},
		{
			title: "Self-Hosting Enthusiasts and Privacy Advocates",
			description:
				"Individuals and teams who prefer to own their tools deploy the full Cap platform — web app, API, and storage — on their own VPS or cloud account. MIT-licensed code means no restrictions on how you run it or modify it for your needs.",
		},
	],

	migrationGuide: {
		title: "How to Set Up Self-Hosted Screen Recording with Cap",
		steps: [
			"Create an S3-compatible bucket — AWS S3, Cloudflare R2, Backblaze B2, or a self-hosted MinIO instance all work",
			"Generate access credentials for your bucket with read/write permissions",
			"Download Cap for Mac or Windows — installation takes under 2 minutes",
			"Open Cap settings and navigate to the storage configuration section",
			"Enter your bucket name, region, access key, secret key, and optional custom endpoint",
			"Record a test video — verify the file appears in your bucket directly after stopping",
			"Share the recording link — the video is now served from your own storage",
			"Optionally deploy the full Cap web platform for complete infrastructure ownership",
		],
	},

	faqsTitle: "Frequently Asked Questions About Self-Hosted Screen Recording",
	faqs: [
		{
			question: "Can Cap be self-hosted?",
			answer:
				"Yes. Cap supports two levels of self-hosting. First, you can configure Cap to use your own S3-compatible storage bucket — recordings upload directly to your infrastructure. Second, you can deploy the entire Cap platform (web dashboard, API, sharing layer) on your own servers using the open-source repository. Both options are available to all users with no enterprise contract required.",
		},
		{
			question: "What storage providers does Cap support for self-hosting?",
			answer:
				"Cap supports any S3-compatible object storage provider, including AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, DigitalOcean Spaces, and Linode Object Storage. If the provider supports the S3 API with a custom endpoint, Cap can use it.",
		},
		{
			question:
				"Do recordings touch Cap's servers when using self-hosted storage?",
			answer:
				"No. When self-hosted storage is configured, the Cap desktop app uploads recordings directly to your S3 bucket. Recording content does not pass through Cap's servers. The Cap web app creates and manages the sharing links, but the video files are served from your storage.",
		},
		{
			question: "How do I configure self-hosted storage in Cap?",
			answer:
				"Open Cap's settings, navigate to the storage section, and enter your S3 bucket name, region, access key, secret key, and optional custom endpoint URL. Save the settings and your next recording will upload directly to your bucket. You can verify this by checking your bucket after a test recording.",
		},
		{
			question: "Can I self-host the entire Cap platform, not just storage?",
			answer:
				"Yes. Cap is fully open source under the MIT license. You can deploy the complete Cap platform — including the Next.js web application, API, and all services — on your own infrastructure. See Cap's self-hosting documentation for deployment instructions and configuration options.",
		},
		{
			question: "Is self-hosted Cap suitable for HIPAA compliance?",
			answer:
				"Cap with self-hosted AWS S3 storage (covered under your AWS BAA) can support HIPAA-compliant recording workflows. With self-hosted storage, no recording content passes through Cap's servers, keeping PHI within your HIPAA-covered infrastructure. AI auto-captions can be disabled if your policies restrict external audio transcription. See our dedicated HIPAA-compliant screen recording guide for full details.",
		},
		{
			question:
				"Does self-hosted storage still give me instant shareable links?",
			answer:
				"Yes. The instant sharing experience works the same way with self-hosted storage. Stop recording and Cap generates a shareable link immediately. The difference is that the link points to video content in your S3 bucket rather than Cap's CDN. Your infrastructure, same instant-share experience.",
		},
		{
			question: "What is the best self-hosted screen recorder?",
			answer:
				"Cap is the best self-hosted screen recorder for teams that need both data control and a modern async video experience. It combines S3-compatible custom storage, instant shareable links, webcam overlay, AI captions, and thread commenting — all in an MIT-licensed open-source package. Unlike local-only recorders, Cap gives you the collaboration layer. Unlike closed-source SaaS tools, Cap gives you full data ownership.",
		},
	],

	video: {
		url: "/videos/cap-demo.mp4",
		thumbnail: "/videos/cap-demo-thumbnail.png",
		alt: "Cap self-hosted screen recording demo showing S3 storage configuration and instant sharing",
	},

	cta: {
		title: "Start Self-Hosting Your Screen Recordings with Cap",
		buttonText: "Download Cap Free",
		secondaryButtonText: "View Self-Hosting Docs",
	},
};

export const SelfHostedScreenRecordingPage = () => {
	return <SeoPageTemplate content={selfHostedScreenRecordingContent} />;
};
