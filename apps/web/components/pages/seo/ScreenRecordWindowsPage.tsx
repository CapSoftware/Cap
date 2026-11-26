"use client";

import { Clapperboard, Zap } from "lucide-react";
import Script from "next/script";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const screenRecordWindowsContent: SeoPageContent = {
	title:
		"Free Screen Recorder for Windows 10 & 11 — Record Your Screen Instantly",
	description:
		"Cap is an open source screen recorder with instant share links. Cap Desktop runs on 64-bit Windows 10 version 1903 or later, including Windows 11.",

	featuresTitle: "Why Cap Is the Best Screen Recorder for Windows",
	featuresDescription:
		"Instant Mode uploads while you record, so the share link is ready the moment you stop.",

	features: [
		{
			title: "HD Screen Recording on Windows",
			description:
				"Capture your entire screen, a single window, or a custom region in crystal-clear HD on Windows 10 and Windows 11. System audio and microphone are recorded in perfect sync so your tutorials and walkthroughs sound as good as they look. New to screen recording? Follow our <a href='/how-to-screen-record'>how to screen record guide</a> to get started.",
		},
		{
			title: "Webcam Overlay for Facecam Recordings",
			description:
				"Add a picture-in-picture webcam bubble to any screen recording. Resize and reposition the overlay anywhere on screen — perfect for product demos, presentations, and video messages where your audience needs to see you.",
		},
		{
			title: "Instant Link Sharing",
			description:
				"Finish recording and get a shareable link in seconds. No waiting for uploads or renders — Cap generates a link the moment you stop recording so you can paste it into Slack, email, or a support ticket immediately.",
		},
		{
			title: "Free with No Watermarks",
			description:
				"Cap is open source and completely free to use locally on Windows. There are no watermarks, no hidden paywalls, and no time limit on Studio Mode recordings. Looking for a <a href='/free-screen-recorder'>free screen recorder</a> that actually delivers? Cap is it.",
		},
		{
			title: "Lightweight & Fast on Any Windows PC",
			description:
				"Cap is built with native performance in mind. It uses minimal CPU and RAM so you can record smoothly even on older Windows 10 laptops. No lag, no dropped frames, no fan noise — just clean recordings every time.",
		},
		{
			title: "Built-In Studio Editor",
			description:
				"Trim, crop, and add backgrounds to your recordings without leaving Cap. The studio editor lets you polish your screen recordings before sharing — no need to export to a separate video editor.",
		},
		{
			title: "System Audio + Microphone Recording",
			description:
				"Record system audio, microphone input, or both simultaneously. Whether you are walking through a presentation with voiceover or capturing gameplay audio, Cap handles multi-track audio recording on Windows natively. Stuck without Stereo Mix on Windows 11? Our <a href='/blog/windows-11-record-screen-system-audio-no-stereo-mix'>Windows system audio guide</a> shows you how.",
		},
		{
			title: "Open Source & Privacy-First",
			description:
				"Cap is fully <a href='https://github.com/CapSoftware/Cap'>open source</a>. Your recordings stay on your machine unless you choose to share them. No telemetry, no tracking, no data harvesting — a transparent <a href='/loom-alternative'>Loom alternative</a> you can trust.",
		},
	],

	recordingModes: {
		title: "Two Ways to Record on Windows",
		description:
			"Cap gives you flexible recording options to match your workflow — whether you need a quick screen capture or a polished studio recording",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Click record and share your screen right away with an auto-generated link. Ideal for quick bug reports, async standups, and answering questions with a screencast instead of a wall of text. On the free plan, Instant Mode recordings run up to 5 minutes.",
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
					"Record locally with no time limit, then polish your video with the built-in editor before sharing. Add custom backgrounds, trim dead air, and produce professional-quality tutorials and demos — all free on Windows.",
			},
		],
	},

	useCasesTitle: "How Windows Users Record Their Screen with Cap",
	useCasesDescription:
		"From quick captures to polished productions, Cap covers every Windows screen recording use case",

	useCases: [
		{
			title: "Software Tutorials & How-To Guides",
			description:
				"Walk through any Windows application step by step. Record your screen with voiceover and a webcam overlay to create engaging tutorial videos your audience can follow along with.",
		},
		{
			title: "Product Demos & Sales Videos",
			description:
				"Show prospects exactly how your product works on their Windows PC. Cap lets you record polished demo videos with facecam and share them instantly — no editing software needed.",
		},
		{
			title: "Bug Reports & QA Feedback",
			description:
				"A 30-second screen recording is worth a thousand words in a bug report. Capture the issue, get a link, and paste it into your issue tracker. Your engineers will thank you.",
		},
		{
			title: "Remote Team Communication",
			description:
				"Replace long meetings with short, async screen recordings. Walk your team through code reviews, design feedback, or project updates — they can watch on their own time.",
		},
		{
			title: "Educational Lectures & Training",
			description:
				"Teachers and corporate trainers use Cap on Windows to record lectures, onboarding walkthroughs, and training modules that students and new hires can replay at their own pace.",
		},
		{
			title: "Client Presentations & Reports",
			description:
				"Record your slide deck with a facecam overlay and narration. Share the link with clients who missed the live meeting — they get the full experience without scheduling another call.",
		},
	],

	faqsTitle: "Windows Screen Recording FAQ",
	faqs: [
		{
			question: "How do I screen record on Windows 10?",
			answer:
				"Download Cap from cap.so/download, install it on your Windows 10 PC, and click the record button.",
		},
		{
			question: "How do I screen record on Windows 11?",
			answer:
				"Cap works identically on Windows 11. Download and install Cap, pick your capture area, enable audio sources, and record. Windows 11 users get the same HD quality, webcam overlay, and instant sharing features. Cap is fully optimized for Windows 11's latest APIs.",
		},
		{
			question: "Is Cap really a free screen recorder for Windows?",
			answer:
				"Yes. Cap is free to use locally on Windows with no watermarks, no feature gates, and no time limit on Studio Mode recordings. It is open source so you can inspect the code yourself. Cap Pro is available for teams that want cloud storage and advanced sharing, but the core <a href='/free-screen-recorder'>free screen recorder</a> is fully functional. (The free plan's instantly shareable Instant Mode links are capped at 5 minutes.)",
		},
		{
			question: "Can I record my screen with audio on Windows?",
			answer:
				"Absolutely. Cap records system audio (everything you hear through your speakers or headphones) and microphone input simultaneously. You can toggle each source independently before or during recording. This makes Cap ideal for tutorials, gameplay, and presentations where both audio tracks matter. If Windows 11 removed your Stereo Mix device, our <a href='/blog/windows-11-record-screen-system-audio-no-stereo-mix'>guide to recording Windows system audio</a> walks through it step by step.",
		},
		{
			question: "Can I record a specific window or region on Windows?",
			answer:
				"Yes. Cap supports three capture modes on Windows: full screen, single window, and custom region. Select your mode before recording, and Cap captures exactly what you need — nothing more, nothing less.",
		},
		{
			question: "Does Cap add a watermark to recordings?",
			answer:
				"No. Cap never adds watermarks to your recordings, even on the free plan. Your screen recordings are clean and professional, ready to share with clients, teammates, or your audience.",
		},
	],

	video: {},

	cta: {
		title: "Start Recording Your Windows Screen in Seconds",
		buttonText: "Download Cap Free for Windows",
	},
};

const createFaqStructuredData = () => {
	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: screenRecordWindowsContent.faqs.map((faq) => ({
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

const createSoftwareAppStructuredData = () => {
	const softwareApp = {
		"@context": "https://schema.org",
		"@type": "SoftwareApplication",
		name: "Cap",
		operatingSystem: "Windows 10, Windows 11",
		applicationCategory: "MultimediaApplication",
		offers: {
			"@type": "Offer",
			price: "0",
			priceCurrency: "USD",
		},
		description:
			"Free, open-source screen recorder for Windows with HD recording, webcam overlay, and instant link sharing.",
		url: "https://cap.so/screen-recorder-windows",
		downloadUrl: "https://cap.so/download",
	};

	return JSON.stringify(softwareApp);
};

export const ScreenRecordWindowsPage = () => {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>
			<Script
				id="software-app-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: createSoftwareAppStructuredData(),
				}}
			/>
			<SeoPageTemplate content={screenRecordWindowsContent} />
		</>
	);
};
