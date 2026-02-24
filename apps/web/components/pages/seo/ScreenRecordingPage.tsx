"use client";

import { Clapperboard, Zap } from "lucide-react";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const screenRecordingContent: SeoPageContent = {
	title: "Screen Recording — Capture, Share & Collaborate Instantly with Cap",
	description:
		"Cap makes screen recording effortless. Record your screen in HD with audio and webcam overlay, then share instantly with a link. Free, open-source, and available on Mac and Windows.",

	featuresTitle: "Everything You Need for Professional Screen Recording",
	featuresDescription:
		"Cap delivers a complete screen recording experience from capture to sharing — no extra tools required",

	features: [
		{
			title: "HD Recording Up to 4K at 60fps",
			description:
				"Capture sharp, fluid screen recordings at resolutions up to 4K. Every click, scroll, and animation is reproduced with perfect clarity for tutorials, demos, and presentations.",
		},
		{
			title: "Instant Shareable Links",
			description:
				"Get a shareable link the moment you stop recording. No uploading, no waiting — paste the link anywhere and your recording is immediately accessible to viewers.",
		},
		{
			title: "Webcam and Screen Together",
			description:
				"Record your screen and webcam simultaneously with a picture-in-picture overlay. Add a personal touch to tutorials, walkthroughs, and video messages.",
		},
		{
			title: "System Audio and Microphone",
			description:
				"Capture both system audio and microphone input in your screen recordings. Narrate as you go or let the original audio play through — Cap records both tracks cleanly.",
		},
		{
			title: "AI-Powered Captions",
			description:
				"Automatically generate accurate captions from your screen recording audio. Make your content accessible and searchable without any manual effort.",
		},
		{
			title: "Open Source and Privacy-First",
			description:
				"Cap is fully open-source and lets you connect your own S3-compatible storage for complete data ownership. Your screen recordings stay under your control — always.",
		},
		{
			title: "Free with No Watermarks",
			description:
				"Cap's <a href='/free-screen-recorder'>free screen recorder</a> produces clean, professional recordings with no watermarks, no time limits in Studio Mode, and no hidden fees.",
		},
		{
			title: "Thread Comments on Recordings",
			description:
				"Viewers can leave timestamped comments directly on your screen recordings. Collect structured feedback without long email threads or meetings.",
		},
	],

	recordingModes: {
		title: "Two Recording Modes Built for Every Workflow",
		description:
			"Cap adapts to how you work — whether you need a quick share or a polished production",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Record and share your screen in seconds with a shareable link. Perfect for async updates, bug reports, and quick demos. Free plan includes up to 5-minute recordings with built-in thread commenting.",
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
					"Completely free for personal use. Records at top quality up to 4K with separate screen and webcam tracks for full editing control. Ideal for polished tutorials, product demos, and training content.",
			},
		],
	},

	comparisonTitle: "Screen Recording Tools Compared",
	comparisonDescription:
		"How Cap stacks up against the most popular screen recording options",

	comparison: [
		{
			title: "Cap vs Loom",
			description:
				"Cap is significantly more affordable than Loom, starting at $8.16/month compared to Loom's $18/month. Cap is also open-source, supports custom S3 storage, and offers Studio Mode on the free plan. <a href='/loom-alternative'>See the full Cap vs Loom comparison</a>.",
		},
		{
			title: "Cap vs OBS Studio",
			description:
				"OBS is a powerful open-source recorder built for streamers, but it requires significant configuration. Cap is designed for simplicity — start recording in seconds with instant sharing, cloud storage, and a clean interface that anyone can use.",
		},
		{
			title: "Cap vs macOS Built-in Recorder",
			description:
				"macOS Cmd+Shift+5 lacks system audio capture, webcam overlay, and instant sharing. Cap adds all of these natively with no extensions required. <a href='/screen-recorder-mac'>Learn more about screen recording on Mac</a>.",
		},
		{
			title: "Cap vs Windows Game Bar",
			description:
				"Xbox Game Bar only records the active window and cannot capture your full desktop. Cap records your entire screen, any window, or a custom region, with full audio support. <a href='/screen-recorder-windows'>Learn more about screen recording on Windows</a>.",
		},
	],

	useCasesTitle: "How Teams and Creators Use Screen Recording",
	useCasesDescription:
		"From quick async updates to polished training content — Cap fits every screen recording use case",

	useCases: [
		{
			title: "Async Team Updates",
			description:
				"Replace recurring status meetings with short screen recordings. Record a walkthrough, share the link in Slack or email, and let your team watch on their own schedule.",
		},
		{
			title: "Software Tutorials and Documentation",
			description:
				"Create step-by-step screen recording tutorials that walk users through your product. Capture every click with HD quality and narrate as you go for clear, reusable documentation.",
		},
		{
			title: "Bug Reports and QA",
			description:
				"Record exactly what went wrong and share the link with your engineering team. A screen recording communicates a bug faster and more clearly than any written description.",
		},
		{
			title: "Client Presentations and Demos",
			description:
				"Record product demos and polished walkthroughs for clients or prospects. Share instantly without scheduling a live call and collect feedback through Cap's thread commenting.",
		},
		{
			title: "Training and Onboarding",
			description:
				"Build a library of screen recording training videos that new hires can watch at their own pace. AI-powered captions make every video searchable and accessible.",
		},
		{
			title: "Educational Content",
			description:
				"Educators and course creators use Cap to produce high-quality lecture recordings and screen tutorials. <a href='/solutions/online-classroom-tools'>Learn how Cap supports online teaching</a>.",
		},
	],

	faqsTitle: "Frequently Asked Questions About Screen Recording",
	faqs: [
		{
			question: "What is screen recording?",
			answer:
				"Screen recording is the process of capturing the visual output of your computer display as a video file. Modern screen recording tools like Cap also capture audio — both system sounds and microphone input — alongside optional webcam footage. The result is a complete video that shows exactly what happened on screen, ideal for tutorials, demos, bug reports, and async communication.",
		},
		{
			question: "Is Cap's screen recording free?",
			answer:
				"Yes. Cap's Studio Mode is completely free for personal use with unlimited recording time and no watermarks. Instant Mode on the free plan supports recordings up to 5 minutes with shareable links and thread commenting. <a href='/free-screen-recorder'>Download Cap's free screen recorder</a> to get started today.",
		},
		{
			question: "Does screen recording capture audio?",
			answer:
				"Cap captures both system audio and microphone input simultaneously during screen recording. You can narrate your recording while system sounds play through, or record microphone-only for clean voiceovers. Both audio tracks are captured and synchronized automatically.",
		},
		{
			question: "Can I record my screen and webcam at the same time?",
			answer:
				"Yes. Cap records your screen and webcam simultaneously with a picture-in-picture overlay. In Studio Mode, screen and webcam are saved as separate tracks, giving you full editing control in post-production.",
		},
		{
			question: "What is the best screen recording software?",
			answer:
				"The best screen recording software depends on your needs. For simplicity and instant sharing, Cap is the top choice — it is free, open-source, and produces professional results without any setup. For advanced streaming, OBS is powerful but complex. For team sharing, Cap's built-in link sharing and thread comments make it the best option for async collaboration. <a href='/screen-recording-software'>See a full comparison of screen recording software</a>.",
		},
		{
			question: "How do I start screen recording on Mac?",
			answer:
				"To start screen recording on Mac with Cap, download the app, click the Cap icon in your menu bar, choose your recording region, and hit record. You can also use the macOS built-in recorder with Cmd+Shift+5, but it lacks system audio capture and instant sharing. <a href='/screen-recorder-mac'>Learn more about screen recording on Mac</a>.",
		},
		{
			question: "How do I start screen recording on Windows?",
			answer:
				"Download Cap for Windows and launch it from the system tray to start screen recording in seconds. Cap records your full screen, a specific window, or a custom region with audio. The built-in Windows Game Bar alternative only captures the active window. <a href='/screen-recorder-windows'>Learn more about screen recording on Windows</a>.",
		},
		{
			question: "Does Cap screen recording have a time limit?",
			answer:
				"Studio Mode in Cap has no time limit on recordings — record as long as you need. Instant Mode on the free plan supports recordings up to 5 minutes. Cap Pro removes this limit for Instant Mode recordings as well.",
		},
	],

	video: {
		url: "/videos/cap-demo.mp4",
		thumbnail: "/videos/cap-demo-thumbnail.png",
		alt: "Cap screen recording demo showing HD capture, webcam overlay, and instant sharing",
	},

	cta: {
		title: "Start Screen Recording for Free with Cap",
		buttonText: "Download Cap Free",
		secondaryButtonText: "Try Instant Mode in Browser",
	},
};

export const ScreenRecordingPage = () => {
	return <SeoPageTemplate content={screenRecordingContent} />;
};
