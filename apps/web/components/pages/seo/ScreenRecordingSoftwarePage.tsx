"use client";

import { Clapperboard, Zap } from "lucide-react";
import Script from "next/script";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const screenRecordingSoftwareContent: SeoPageContent = {
	title: "Screen Recording Software — Free HD Screen Capture for Mac & Windows",
	description:
		"Cap is free, open-source screen recording software that captures HD video with audio on Mac and Windows. Record your screen, share instantly with a link, and keep full ownership of your data.",

	featuresTitle: "Why Cap is the Best Screen Recording Software",
	featuresDescription:
		"Powerful screen capture software with everything you need to record, edit, and share professional videos",

	features: [
		{
			title: "Professional-Grade Quality",
			description:
				"Capture crystal-clear video up to 4K at 60fps with perfectly synchronized audio. Cap delivers professional results whether you are recording a quick demo or a full-length tutorial. Try our <a href='/free-screen-recorder'>free screen recorder</a> today.",
		},
		{
			title: "User-Friendly Interface",
			description:
				"Start recording in seconds with Cap's intuitive design. No complicated settings or technical knowledge required — just click record and go.",
		},
		{
			title: "Free Access to Full Features",
			description:
				"Enjoy professional screen recording software without subscription fees or hidden costs. Studio Mode is completely free for personal use with unlimited recording time.",
		},
		{
			title: "Multi-Platform Support",
			description:
				"Cap works seamlessly on both <a href='/screen-recorder-mac'>Mac</a> and <a href='/screen-recorder-windows'>Windows</a>, delivering consistent performance across all major platforms.",
		},
		{
			title: "Unlimited Recording and Cloud Storage",
			description:
				"Record as long as you need with no time limits. Store and share your recordings with unlimited cloud storage on Cap Pro.",
		},
		{
			title: "Instant Sharing with Links",
			description:
				"Generate a shareable link the moment you stop recording. Share with teammates, clients, or students without uploading to a third-party platform.",
		},
		{
			title: "Open Source and Transparent",
			description:
				"Cap is fully open-source on <a href='https://github.com/CapSoftware/Cap'>GitHub</a>, giving you complete transparency into how your screen recording software works. Community-driven development means features are shaped by real users.",
		},
		{
			title: "AI-Powered Captions",
			description:
				"Automatically generate accurate captions for your screen recordings. Cap's built-in transcription makes your videos accessible and searchable without any extra steps.",
		},
	],

	recordingModes: {
		title: "Flexible Screen Recording Modes",
		description:
			"Cap adapts to your workflow with multiple recording modes, both available in the free plan",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Record and share your screen instantly with a simple link. Perfect for quick demos, bug reports, and async updates. Record up to 5-minute shareable links for free with built-in thread commenting for collaboration.",
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
					"Completely free for personal use. Records at top quality up to 4K with separate screen and webcam tracks for professional editing control. Ideal for polished tutorials, presentations, and educational content.",
			},
		],
	},

	comparisonTitle: "How Cap Compares to Other Screen Recording Software",
	comparisonDescription:
		"See how Cap stacks up against popular screen recording tools on the features that matter most",

	comparison: [
		{
			title: "Cap vs Loom",
			description:
				"Cap starts at $8.16/month compared to Loom's $18/month. Cap is open-source, lets you connect your own S3 storage for full data ownership, and offers a more generous free plan with Studio Mode included. <a href='/loom-alternative'>See the full Cap vs Loom comparison</a>.",
		},
		{
			title: "Cap vs OBS Studio",
			description:
				"OBS is powerful but complex. Cap delivers a simpler experience with instant sharing links, cloud storage, and a clean interface — no configuration needed. Both are open-source and free, but Cap is built for sharing, not just recording.",
		},
		{
			title: "Cap vs Windows Built-in (Xbox Game Bar)",
			description:
				"Xbox Game Bar only records the active window and cannot capture full-screen desktop recordings. Cap records your entire screen, specific windows, or custom regions with system and microphone audio. <a href='/screen-recorder-windows'>Learn more about screen recording on Windows</a>.",
		},
		{
			title: "Cap vs Mac Built-in (Cmd+Shift+5)",
			description:
				"The macOS built-in recorder lacks system audio capture, webcam overlay, and instant sharing. Cap handles all of these natively with no extra plugins or extensions required. <a href='/screen-recorder-mac'>Learn more about screen recording on Mac</a>.",
		},
	],

	useCasesTitle: "Popular Uses for Screen Recording Software",
	useCasesDescription:
		"Explore how professionals, educators, and teams use Cap's screen recording software every day",

	useCases: [
		{
			title: "Creating Tutorials and Walkthroughs",
			description:
				"Develop high-quality tutorials with Cap's seamless <a href='/screen-recorder'>screen recording</a> tools. Capture step-by-step workflows with audio narration and webcam overlay for engaging instructional content.",
		},
		{
			title: "Professional Presentations and Demos",
			description:
				"Record polished product demos and presentations to share with clients, prospects, or stakeholders. Cap's instant sharing makes it easy to distribute recordings without scheduling a meeting.",
		},
		{
			title: "Educational Content and Training",
			description:
				"Produce training videos, lectures, and educational materials with ease. AI-powered captions make your content accessible to all learners. Learn <a href='/how-to-screen-record'>how to screen record</a> with Cap to get started.",
		},
		{
			title: "Remote Team Collaboration",
			description:
				"Replace long meetings with short recorded walkthroughs. Share updates, code reviews, design feedback, and project status asynchronously so your team can watch on their own schedule.",
		},
	],

	faqsTitle: "Frequently Asked Questions About Screen Recording Software",
	faqs: [
		{
			question: "Is Cap truly free screen recording software?",
			answer:
				"Yes, Cap provides a completely free version with professional-grade features. Studio Mode is free for personal use with unlimited recording time and up to 4K resolution. Our <a href='/free-screen-recorder'>free screen recorder</a> includes everything you need to get started without paying a cent.",
		},
		{
			question:
				"Can I use Cap's screen recording software on multiple platforms?",
			answer:
				"Yes, Cap is available for <a href='/screen-recorder-windows'>Windows</a> and <a href='/screen-recorder-mac'>Mac</a>, offering seamless performance across all major platforms. Your recordings sync through the cloud so you can access them from any device.",
		},
		{
			question: "Does Cap offer unlimited recording time?",
			answer:
				"Absolutely. Cap's desktop app allows unlimited recording time with no restrictions, ideal for extended presentations, training sessions, or full-length tutorials. Instant Mode supports recordings up to 5 minutes on the free plan.",
		},
		{
			question: "Can I share recordings with others?",
			answer:
				"Yes, Cap generates instant shareable links the moment you stop recording. Share with colleagues, clients, or students in seconds. Cap Pro includes built-in thread commenting so recipients can leave feedback directly on your videos.",
		},
		{
			question: "How does Cap compare to other screen recording software?",
			answer:
				"Cap is the only screen recording software that is open-source, offers instant sharing, and lets you own your data with custom S3 storage. It is more affordable than <a href='/loom-alternative'>Loom</a>, simpler than OBS, and more powerful than built-in OS tools.",
		},
		{
			question: "What is the best screen recording software in 2026?",
			answer:
				"Cap is the best screen recording software for users who want a balance of quality, simplicity, and value. It records in up to 4K at 60fps, shares instantly via link, is open-source, and offers a generous free plan. For teams, Cap Pro adds cloud storage, thread commenting, and custom domains at a fraction of competitors' prices.",
		},
		{
			question: "How does screen recording software work?",
			answer:
				"Screen recording software captures the visual output of your display and encodes it into a video file in real time. Cap captures your screen at up to 60 frames per second alongside system audio and microphone input, then encodes the result into a shareable video. The process runs efficiently in the background with minimal impact on system performance.",
		},
		{
			question: "Is there free screen recording software without watermarks?",
			answer:
				"Yes, Cap is completely free screen recording software with no watermarks, no time limits, and no hidden branding. Your recordings look clean and professional from the start. <a href='/free-screen-recorder'>Download Cap's free screen recorder</a> to start recording without watermarks today.",
		},
	],

	video: {
		url: "/videos/cap-screen-recording-software-demo.mp4",
		thumbnail: "/videos/cap-screen-recording-software-thumbnail.png",
		alt: "Cap screen recording software demo showing HD capture and instant sharing",
	},

	cta: {
		title: "Get Started with Cap — Free Screen Recording Software",
		buttonText: "Download Cap Free",
		secondaryButtonText: "Try Instant Mode in Browser",
	},
};

const createFaqStructuredData = () => {
	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: screenRecordingSoftwareContent.faqs.map((faq) => ({
			"@type": "Question",
			name: faq.question,
			acceptedAnswer: {
				"@type": "Answer",
				text: faq.answer.replace(/<\/?[^>]+(>|$)/g, ""),
			},
		})),
	};

	return JSON.stringify(faqStructuredData);
};

export const ScreenRecordingSoftwarePage = () => {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>
			<SeoPageTemplate content={screenRecordingSoftwareContent} />
		</>
	);
};
