"use client";

import { Clapperboard, Zap } from "lucide-react";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const obsAlternativeContent: SeoPageContent = {
	title: "OBS Alternative — Easier Screen Recording with Instant Sharing",
	description:
		"Cap is the modern OBS alternative built for async screen sharing, not live streaming. Record in 4K, get a shareable link in seconds, and collaborate with timestamped comments. No configuration required.",

	badge: "OBS Alternative",

	featuresTitle: "Why Teams Choose Cap Over OBS Studio",
	featuresDescription:
		"OBS is powerful for live streaming — but for everyday async recording and sharing, Cap is faster, simpler, and built for teams",

	features: [
		{
			title: "Zero Configuration",
			description:
				"OBS requires scene setup, audio routing, encoder tuning, and plugin management before you can record. Cap works out of the box — install it, click record, and your link is ready in seconds. No scenes, no profiles, no bitrate math.",
		},
		{
			title: "Instant Shareable Links",
			description:
				"Stop recording and Cap immediately generates a shareable link. Paste it into Slack, email, or a GitHub issue and your team can watch without downloading anything. OBS outputs local files that require manual upload to every platform you use.",
		},
		{
			title: "Built-In Async Collaboration",
			description:
				"Cap viewers can leave timestamped comments directly on your recording — no third-party platform needed. OBS has no built-in sharing or commenting. Teams using OBS end up uploading to YouTube, Loom, or Dropbox just to share a clip.",
		},
		{
			title: "Webcam Overlay Without Plugins",
			description:
				"Cap includes a polished picture-in-picture webcam overlay as a first-class feature. OBS supports webcam through source layers but requires manual positioning, cropping, and scene management every time you change setups.",
		},
		{
			title: "AI Captions Included",
			description:
				"Cap automatically generates accurate captions from your recordings using AI transcription. OBS has no transcription capability — you need separate software, manual uploads to YouTube, or a third-party service to add captions to OBS recordings.",
		},
		{
			title: "4K Recording at 60fps",
			description:
				"Cap captures your screen at up to 4K resolution and 60 frames per second with system audio and microphone. You get the same recording quality as OBS with a fraction of the setup time and none of the encoder configuration.",
		},
		{
			title: "Cloud Storage and Self-Hosting",
			description:
				"Cap uploads recordings automatically and generates links. For teams with data requirements, Cap supports any S3-compatible storage — AWS S3, Cloudflare R2, or your own MinIO instance. OBS saves locally by default with no cloud integration.",
		},
		{
			title: "Open Source Like OBS",
			description:
				"Cap is MIT-licensed and fully open source on GitHub, just like OBS. You can audit the code, contribute features, and self-host the entire platform. You get OBS's commitment to transparency with the usability of a modern sharing tool.",
		},
	],

	recordingModes: {
		title: "Two Recording Modes for Every Workflow",
		description:
			"Cap gives you two distinct modes so you always have the right tool — whether you need a quick update or a polished tutorial",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Record and share in one click. The moment you stop, Cap generates a shareable link and uploads your recording automatically. Perfect for bug reports, async standups, quick demos, and team updates. Free plan includes recordings up to 5 minutes.",
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
					"Completely free for personal use with no time limits. Records screen and webcam as separate tracks for post-production flexibility. Ideal for tutorials, product demos, and training content where you want full control — without the complexity of OBS scene management.",
			},
		],
	},

	comparisonTable: {
		title: "Cap vs OBS Studio — Feature Comparison",
		headers: ["Feature", "Cap", "OBS Studio", "Loom", "Camtasia"],
		rows: [
			[
				"Setup time",
				{ text: "Under 2 minutes", status: "positive" },
				{ text: "30–60 minutes", status: "negative" },
				{ text: "Under 5 minutes", status: "positive" },
				{ text: "Under 5 minutes", status: "positive" },
			],
			[
				"Instant share link",
				{ text: "Yes", status: "positive" },
				{ text: "No — local file only", status: "negative" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"Built-in commenting",
				{ text: "Yes — timestamped", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"AI captions",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Paid only", status: "warning" },
				{ text: "Paid only", status: "warning" },
			],
			[
				"Open source",
				{ text: "Yes — MIT licensed", status: "positive" },
				{ text: "Yes — GPL licensed", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Cloud storage",
				{ text: "Yes — auto upload", status: "positive" },
				{ text: "No — local only", status: "negative" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"Self-hostable storage",
				{ text: "Yes — any S3", status: "positive" },
				{ text: "N/A", status: "neutral" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"4K recording",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Yes (paid)", status: "warning" },
			],
			[
				"Free to use",
				{ text: "Yes — free plan + Studio Mode", status: "positive" },
				{ text: "Yes — fully free", status: "positive" },
				{ text: "Limited", status: "warning" },
				{ text: "$299.99 one-time", status: "negative" },
			],
			[
				"Live streaming",
				{ text: "No", status: "negative" },
				{ text: "Yes — primary use case", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
		],
	},

	comparisonTitle: "When to Use Cap vs OBS Studio",
	comparisonDescription:
		"OBS and Cap are both open source — but they solve completely different problems",

	comparison: [
		{
			title: "Cap vs OBS for Async Team Communication",
			description:
				"OBS has no sharing layer — it saves files locally and you handle the rest. Cap is built specifically for async communication: record, get a link, share, and receive comments. If you're recording to share with teammates, customers, or stakeholders, Cap is the right tool.",
		},
		{
			title: "Cap vs OBS for Tutorials and Product Demos",
			description:
				"OBS can record tutorials but requires exporting, uploading to a host, and sharing a third-party link. Cap handles all of this automatically — your tutorial is shareable the moment you stop recording. <a href='/open-source-screen-recorder'>See Cap's full open source approach</a>.",
		},
		{
			title: "Cap vs OBS for Live Streaming",
			description:
				"OBS is the industry standard for live streaming to Twitch, YouTube, and other platforms. Cap does not support live streaming. If your primary need is live broadcasting to an audience, OBS is the right choice and Cap is not a substitute.",
		},
		{
			title: "Cap vs Loom for Screen Sharing",
			description:
				"Both Cap and Loom are built for async screen sharing with instant links. Cap is open source, supports self-hosted storage, and starts at $9.99/month versus Loom's $18/month — with Studio Mode completely free. <a href='/loom-alternative'>See the full Cap vs Loom comparison</a>.",
		},
	],

	useCasesTitle: "Who Switches from OBS to Cap",
	useCasesDescription:
		"Cap is the right OBS alternative for teams and individuals who record to share, not to stream",

	useCases: [
		{
			title: "Software Developers",
			description:
				"Developers record bug reports, architecture walkthroughs, and code reviews with Cap. Shareable links drop into GitHub issues and pull requests in seconds. No more uploading OBS files or screen-sharing in Zoom to explain a problem.",
		},
		{
			title: "Product and Design Teams",
			description:
				"Product managers record feature walkthroughs and design feedback with Cap. Stakeholders leave timestamped comments directly on the recording — no scheduling calls, no writing long documents to explain what they saw.",
		},
		{
			title: "Customer Support Teams",
			description:
				"Support teams use Cap to create quick video responses for complex tickets. A 60-second Cap recording with a direct link resolves issues faster than a multi-paragraph text reply and requires far less setup than OBS.",
		},
		{
			title: "Remote and Distributed Teams",
			description:
				"Teams across time zones use Cap for async standups, sprint demos, and onboarding walkthroughs. Cap replaces OBS's manual file workflow with instant links that work in Slack, Notion, Linear, and every tool your team already uses.",
		},
		{
			title: "Educators and Course Creators",
			description:
				"Teachers record lessons and tutorials with Cap. Studio Mode is completely free with no time limits — a major advantage over OBS's manual upload workflow. <a href='/solutions/online-classroom-tools'>Learn how Cap supports online teaching</a>.",
		},
		{
			title: "Startups and Small Teams",
			description:
				"Early-stage teams need tools that work without a dedicated AV setup. Cap delivers professional async video for customer demos, investor updates, and team communication without the encoder configuration and plugin management that OBS requires.",
		},
	],

	migrationGuide: {
		title: "How to Switch from OBS to Cap",
		steps: [
			"Download Cap for Mac or Windows — installation takes under 2 minutes with no configuration required",
			"Open Cap and select your recording area: full screen, a specific window, or a custom region",
			"Toggle webcam and microphone on or off directly in the recording toolbar",
			"Click Record — Cap captures your screen at up to 4K with system audio and webcam overlay",
			"Stop recording and Cap automatically uploads and generates a shareable link",
			"Paste the link into Slack, email, GitHub, or any tool — your team can watch and comment immediately",
			"For self-hosted storage, connect Cap to your own S3-compatible bucket in settings",
		],
	},

	faqsTitle: "Frequently Asked Questions About OBS Alternatives",
	faqs: [
		{
			question: "Why would I use Cap instead of OBS Studio?",
			answer:
				"OBS Studio is the best tool for live streaming, but it's complex and saves files locally. Cap is designed for async screen sharing — you get a shareable link the moment you stop recording, with built-in commenting and AI captions. If you're recording to share with teammates or customers rather than to stream live, Cap is faster and simpler.",
		},
		{
			question: "Is Cap free like OBS?",
			answer:
				"Yes. Cap's Studio Mode is completely free for personal use with no time limits and no watermarks. Instant Mode on the free plan supports recordings up to 5 minutes. Cap Pro ($9.99/month) removes Instant Mode time limits and adds team features. The core software is open source and free to use, just like OBS.",
		},
		{
			question: "Is Cap open source like OBS?",
			answer:
				"Yes. Cap is fully open source and MIT-licensed on GitHub. You can inspect the complete codebase, contribute features, and self-host the entire platform. Both Cap and OBS are open source — but Cap uses the permissive MIT License while OBS uses the GPL.",
		},
		{
			question: "Can Cap do live streaming like OBS?",
			answer:
				"No. Cap is built for async screen recording and sharing, not live streaming. If you need to broadcast live to Twitch, YouTube, or other platforms, OBS Studio remains the best tool. Cap and OBS are complementary — use OBS for live streaming and Cap for async recording and team sharing.",
		},
		{
			question: "Does Cap support the same recording quality as OBS?",
			answer:
				"Yes. Cap records at up to 4K resolution and 60 frames per second with system audio and microphone. You get the same video quality as OBS without the encoder configuration. Cap handles bitrate, format, and compression automatically so you don't have to tune settings before every recording.",
		},
		{
			question: "What happens to my recordings after I stop recording in Cap?",
			answer:
				"Cap automatically uploads your recording and generates a shareable link in seconds. You can paste this link anywhere — Slack, email, GitHub, Notion — and viewers can watch without downloading any files. You can also configure Cap to store recordings in your own S3-compatible bucket for complete data control.",
		},
		{
			question: "Does Cap work on Mac and Windows like OBS?",
			answer:
				"Yes. Cap is available as a native desktop app for macOS and Windows, just like OBS. Both platforms are supported in the same open-source repository. <a href='/screen-recorder-mac'>Learn more about screen recording on Mac</a> or <a href='/screen-recorder-windows'>learn more about screen recording on Windows</a>.",
		},
		{
			question: "Can I self-host Cap like I can self-host OBS outputs?",
			answer:
				"Yes. Cap supports any S3-compatible storage provider, including AWS S3, Cloudflare R2, Backblaze B2, and self-hosted MinIO. Configure your own bucket in Cap's settings and your recordings are stored entirely within your infrastructure. For teams that need complete data sovereignty, Cap provides the same control as managing OBS output files locally.",
		},
	],

	video: {
		url: "/videos/cap-demo.mp4",
		thumbnail: "/videos/cap-demo-thumbnail.png",
		alt: "Cap OBS alternative demo showing instant recording and sharing",
	},

	cta: {
		title: "Switch to the Simpler OBS Alternative",
		buttonText: "Download Cap Free",
		secondaryButtonText: "View on GitHub",
	},
};

export const ObsAlternativePage = () => {
	return <SeoPageTemplate content={obsAlternativeContent} />;
};
