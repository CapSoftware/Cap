"use client";

import { BookOpen, Video } from "lucide-react";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const developerDocumentationVideosContent: SeoPageContent = {
	title:
		"Developer Documentation Videos — Record API Demos and SDK Walkthroughs",
	description:
		"Create professional developer documentation videos with screen recording. Record API demos, SDK walkthroughs, CLI tutorials, and changelog videos in seconds. Cap is free, open-source, and built for developers who ship documentation alongside code.",

	badge: "Developer Docs",

	featuresTitle: "Everything You Need to Create Developer Documentation Videos",
	featuresDescription:
		"Cap gives developers a fast, high-quality way to record and share technical documentation — without a video team or complex setup",

	features: [
		{
			title: "Record API Demos and SDK Walkthroughs",
			description:
				"Open your terminal, IDE, or browser and start recording. Cap captures your screen and webcam simultaneously so viewers see exactly what you see — code execution, API responses, SDK method calls, and all. Narrate as you go and produce a complete API demo in minutes, not days.",
		},
		{
			title: "4K Resolution for Readable Code and Terminal Output",
			description:
				"Cap records at up to 4K resolution at 60fps, which means syntax highlighting, terminal text, JSON responses, and font rendering are captured at full fidelity. Developers watching your documentation can pause and read every line of code clearly — even dense stack traces and config files.",
		},
		{
			title: "Instant Shareable Link — Embed in Docs Anywhere",
			description:
				"Stop recording and Cap generates a shareable link immediately. Paste it into your README, Notion doc, Confluence page, GitHub wiki, or Docusaurus site. Viewers watch the video in their browser without installing anything. Use the embed code to inline videos directly in documentation pages.",
		},
		{
			title: "AI-Generated Transcripts for Documentation Search",
			description:
				"Cap auto-generates accurate captions and transcripts for every recording using AI transcription. Developers who prefer to read, are in loud environments, or need searchable content get a full text version alongside the video. Transcripts make your documentation more accessible and easier to index.",
		},
		{
			title: "Studio Mode for Long-Form Technical Docs",
			description:
				"For comprehensive documentation — full API references, end-to-end SDK tutorials, architecture overviews — <a href='/screen-recording-software'>Studio Mode</a> records screen and webcam as separate tracks with no time limits. Trim the intro, cut awkward pauses, and publish a polished technical video without a production team.",
		},
		{
			title: "Changelog and Release Walkthrough Videos",
			description:
				"Ship a short Cap recording with every major release. Walk through new API endpoints, breaking changes, and migration steps on screen. Developers reading your changelog get the context they need without parsing dense release notes. Link the video in your GitHub release, Slack announcement, or newsletter.",
		},
		{
			title: "Password Protection for Private Internal Documentation",
			description:
				"For internal runbooks, proprietary SDK documentation, or pre-release API previews, add a password to your recording or set an expiry date on the share link. Only developers with the link and password can access the video — no account required for viewers.",
		},
		{
			title: "Self-Hosted Storage for Compliance and Data Residency",
			description:
				"Organizations with documentation stored on internal infrastructure can <a href='/self-hosted-screen-recording'>configure Cap to upload recordings directly to their own S3-compatible bucket</a>. AWS S3, Cloudflare R2, and MinIO are all supported. Video files never touch Cap's servers.",
		},
	],

	recordingModes: {
		title: "Two Recording Modes for Every Documentation Workflow",
		description:
			"Choose the right workflow for the type of documentation video you're creating",
		modes: [
			{
				icon: (
					<Video
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Instant Mode",
				description:
					"Perfect for quick API demos, bug reproduction videos, and changelog walkthroughs. Record, stop, and share a link within seconds. Ideal when you need to document a new endpoint or explain a breaking change without spending more than a few minutes.",
			},
			{
				icon: (
					<BookOpen
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Studio Mode",
				description:
					"Built for comprehensive SDK tutorials, end-to-end API walkthroughs, and developer onboarding videos. No time limits — record as long as your documentation requires. Separate screen and webcam tracks give you editing flexibility before publishing.",
			},
		],
	},

	comparisonTable: {
		title: "Cap vs Other Developer Documentation Video Tools",
		headers: ["Feature", "Cap", "Loom", "Scribe", "Confluence Recorder"],
		rows: [
			[
				"Screen + webcam recording",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Limited", status: "warning" },
			],
			[
				"4K resolution",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "N/A", status: "neutral" },
				{ text: "No", status: "negative" },
			],
			[
				"Instant shareable link",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Delayed", status: "warning" },
			],
			[
				"AI transcripts",
				{ text: "Yes", status: "positive" },
				{ text: "Paid only", status: "warning" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Self-hosted storage",
				{ text: "Yes — S3", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "Confluence only", status: "warning" },
			],
			[
				"Open source",
				{ text: "Yes — MIT", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"No time limits",
				{ text: "Yes — Studio Mode", status: "positive" },
				{ text: "Limited free", status: "warning" },
				{ text: "N/A", status: "neutral" },
				{ text: "Limited", status: "warning" },
			],
			[
				"Timestamped comments",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
		],
	},

	comparisonTitle: "Why Developers Choose Cap for Documentation Videos",
	comparisonDescription:
		"Developer documentation videos reduce support tickets and accelerate onboarding — here's how Cap compares to other tools",

	comparison: [
		{
			title: "Cap vs Loom for Developer Documentation",
			description:
				"Loom is a capable async video tool but limits recording quality and length on its free plan, and has no self-hosting option for teams with data residency requirements. Cap records at 4K with no recording-length limits in Studio Mode and supports <a href='/self-hosted-screen-recording'>self-hosted S3 storage</a>. Cap is also fully open source under the MIT license — developers can audit the code, contribute features, and trust the tool they're using to document their own products.",
		},
		{
			title: "Cap vs Written Documentation",
			description:
				"Written docs are valuable but struggle to convey dynamic processes — API authentication flows, SDK initialization sequences, CLI command outputs. A 3-minute Cap recording showing an end-to-end API integration replaces a multi-page written guide that developers have to parse and mentally simulate. Video documentation reduces support questions and accelerates integration time for your users.",
		},
		{
			title: "Cap vs Scribe for Technical Walkthroughs",
			description:
				"Scribe generates step-by-step screenshot guides automatically, which works well for UI workflows but struggles with code, terminal output, and API responses. Cap records continuous video with audio narration, capturing the full context of a technical process — not just screenshots of discrete clicks. For developer documentation, video plus voice explains the why, not just the what.",
		},
		{
			title: "Cap for Open Source Project Documentation",
			description:
				"Open source maintainers can record quick demo videos and link them directly in their README, contributing guides, and release notes. Viewers see exactly how to install the library, run the examples, and use the main APIs — without a dedicated docs team. <a href='/open-source-screen-recorder'>Cap is itself open source</a>, so it's the natural choice for developers documenting open source projects.",
		},
	],

	useCasesTitle: "How Developers Use Cap for Documentation Videos",
	useCasesDescription:
		"From API demos to internal runbooks, Cap fits every technical documentation workflow",

	useCases: [
		{
			title: "API Reference and Endpoint Demos",
			description:
				"Record a walkthrough of each key API endpoint — show the request format, authentication headers, response structure, and error handling. Embed the video in your API reference docs so developers see a working example before they write a single line of code. One video per endpoint dramatically reduces integration support tickets.",
		},
		{
			title: "SDK Getting-Started Tutorials",
			description:
				"Record a terminal session from package install through a working integration. Show npm install, SDK initialization, the first successful API call, and how to handle common errors. New developers watching the tutorial can follow along step-by-step without guessing which commands to run or how to interpret the output.",
		},
		{
			title: "Changelog and Migration Guides",
			description:
				"For every major release, record a short Cap video showing what changed. Walk through new features, demonstrate API changes, and show exactly what developers need to update in their integration. Link the video in your GitHub release notes and developer newsletter so your users understand changes without reading a wall of text.",
		},
		{
			title: "Internal Technical Runbooks",
			description:
				"Record runbook videos for complex operational procedures — database migrations, deployment pipelines, incident response workflows. Engineers on call can watch the video during an incident instead of trying to parse written steps under pressure. Password-protect runbooks containing sensitive infrastructure details.",
		},
		{
			title: "Open Source Project README and Contributing Guides",
			description:
				"Add a Cap demo video to your project README showing the library in action. Record a contributing guide showing how to set up the development environment, run the test suite, and submit a pull request. Lower the barrier to first contribution and accelerate new contributor onboarding without writing additional documentation.",
		},
		{
			title: "Developer Onboarding and Internal Tooling Docs",
			description:
				"Record walkthroughs of internal tools, deployment systems, and development workflows for new engineers joining the team. A library of video recordings replaces the traditional onboarding buddy pairing for standard procedures. New hires can watch, pause, and rewatch at their own pace. <a href='/solutions/employee-onboarding-platform'>See how Cap supports developer onboarding</a>.",
		},
	],

	migrationGuide: {
		title: "How to Start Creating Developer Documentation Videos with Cap",
		steps: [
			"Download Cap for Mac or Windows — setup takes under 2 minutes",
			"Open your IDE, terminal, browser, or API client with the flow you want to document",
			"Click the Cap icon in your menu bar and choose Instant Mode for quick demos or Studio Mode for comprehensive tutorials",
			"Start recording — Cap captures your screen and webcam simultaneously in up to 4K",
			"Narrate the documentation as you demonstrate — explain what you're doing and why",
			"Stop recording to get an instant shareable link",
			"Paste the Cap link into your README, docs site, Notion, Confluence, or GitHub wiki",
			"Optionally embed the video directly in your documentation page using the embed code",
		],
	},

	faqsTitle: "Frequently Asked Questions About Developer Documentation Videos",
	faqs: [
		{
			question: "What is a developer documentation video?",
			answer:
				"A developer documentation video is a screen recording that demonstrates how to use an API, SDK, CLI tool, or technical workflow. Instead of relying solely on written guides, developer documentation videos show code execution, API responses, and terminal output in real time with narration — making it faster for developers to understand and integrate technical products.",
		},
		{
			question: "How do I embed a Cap video in my documentation?",
			answer:
				"Cap generates a shareable link the moment you stop recording. You can paste this URL directly into Notion, Confluence, Docusaurus, GitBook, or any documentation platform that supports link unfurling. For direct embedding, use the embed code provided on the Cap sharing page — it works in any site that supports iframes, including GitHub wikis, custom docs sites, and developer portals.",
		},
		{
			question: "Can I record my terminal and IDE output in 4K?",
			answer:
				"Yes. Cap records at up to 4K resolution at 60fps, capturing terminal text, code editors, browser DevTools, and API client responses at full fidelity. Developers watching your documentation can pause the video and read every line of output, including stack traces, JSON responses, and syntax-highlighted code — even on high-DPI displays.",
		},
		{
			question: "Does Cap auto-generate transcripts for documentation?",
			answer:
				"Yes. Cap auto-generates captions and transcripts for every recording using AI transcription. The transcript appears alongside the video on the Cap sharing page, making documentation more accessible to developers who prefer to read, are in noisy environments, or need searchable text content. Transcripts can also be copied for use in written documentation alongside the video.",
		},
		{
			question: "How do I share a documentation video with my team or users?",
			answer:
				"Cap generates a shareable link immediately when you stop recording — no upload wait, no file attachment. Paste the link into your GitHub repository, Slack channel, documentation site, or email. Viewers click the link and the video plays in their browser without any account or app install required. For embedding, use the provided embed code to inline the video directly in your docs page.",
		},
		{
			question: "Can I record videos for private internal documentation?",
			answer:
				"Yes. Cap supports password protection on individual recordings and expiry dates on share links. For teams with stricter requirements, Cap supports self-hosted S3 storage — recordings upload directly to your own infrastructure (AWS S3, Cloudflare R2, MinIO) and never touch Cap's servers. This makes Cap suitable for internal runbooks, pre-release API docs, and proprietary SDK documentation.",
		},
		{
			question: "What is the best screen recorder for developer documentation?",
			answer:
				"Cap is the best screen recorder for developer documentation because it combines 4K recording quality, instant shareable links, AI-generated transcripts, and self-hosted storage in a single free, open-source tool. Unlike general-purpose video tools, Cap is optimized for the async sharing workflows developers actually use — paste a link in a README, embed in a docs site, or share in a PR comment. It's free, MIT-licensed, and available for Mac and Windows.",
		},
		{
			question: "Does Cap work for recording API demos and SDK walkthroughs?",
			answer:
				"Yes. Cap is designed exactly for this use case. Record your terminal, IDE, browser, API client (Postman, Insomnia, curl), or any combination of windows. The screen capture renders at 4K resolution so all text and code is readable. Narrate as you demonstrate, stop recording when you're done, and share the link immediately. The entire workflow — from starting the recording to sharing the link — takes under 5 minutes.",
		},
	],

	video: {
		url: "/videos/cap-demo.mp4",
		thumbnail: "/videos/cap-demo-thumbnail.png",
		alt: "Cap developer documentation video demo showing screen recording of an API walkthrough with narration and instant share link",
	},

	cta: {
		title: "Start Recording Developer Documentation Videos",
		buttonText: "Download Cap Free",
		secondaryButtonText: "View Pricing",
	},
};

export const DeveloperDocumentationVideosPage = () => {
	return <SeoPageTemplate content={developerDocumentationVideosContent} />;
};
