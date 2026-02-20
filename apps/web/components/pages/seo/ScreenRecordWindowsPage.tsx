"use client";

import { Clapperboard, Zap } from "lucide-react";
import Script from "next/script";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const screenRecordWindowsContent: SeoPageContent = {
	title:
		"Free Screen Recorder for Windows 10 & 11 — Record Your Screen Instantly",
	description:
		"Cap is the best free screen recorder for Windows. Record your screen in HD with audio, webcam overlay, and instant sharing on Windows 10 and Windows 11. No watermarks, no time limits — a lightweight alternative to OBS and Windows Game Bar.",

	featuresTitle: "Why Cap Is the Best Screen Recorder for Windows",
	featuresDescription:
		"Everything Windows users need to record, edit, and share screen recordings — without the bloat of traditional screen recording software for PC",

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
			title: "100% Free with No Watermarks",
			description:
				"Cap is open source and completely free to use locally on Windows. There are no watermarks, no time limits, and no hidden paywalls. Looking for a <a href='/free-screen-recorder'>free screen recorder</a> that actually delivers? Cap is it.",
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
				"Record system audio, microphone input, or both simultaneously. Whether you are walking through a presentation with voiceover or capturing gameplay audio, Cap handles multi-track audio recording on Windows natively.",
		},
		{
			title: "Open Source & Privacy-First",
			description:
				"Cap is fully <a href='https://github.com/CapSoftware/Cap'>open source</a>. Your recordings stay on your machine unless you choose to share them. No telemetry, no tracking, no data harvesting — a transparent <a href='/loom-alternative'>Loom alternative</a> you can trust.",
		},
	],

	comparisonTitle: "Cap vs Windows Game Bar: Why Upgrade?",
	comparisonDescription:
		"Windows Game Bar (Win + G) ships with Windows 10 and 11, but it was designed for gaming clips — not professional screen recording. Here is how Cap compares",

	comparison: [
		{
			title: "Record Any Window or Region",
			description:
				"Windows Game Bar can only record a single application window and cannot capture the desktop or File Explorer. Cap lets you record your full screen, any window, or a custom-drawn region — perfect for multi-app workflows and tutorials.",
		},
		{
			title: "Webcam Overlay Built In",
			description:
				"Game Bar has no webcam overlay support. Cap adds a resizable facecam bubble so your viewers can see you while you present, explain, or demo on screen.",
		},
		{
			title: "Instant Shareable Links",
			description:
				"Game Bar saves an MP4 to your Videos folder and that is it. Cap generates a shareable link the moment you stop recording — no manual upload required.",
		},
		{
			title: "No Time Limits or File Size Caps",
			description:
				"Windows Game Bar limits recordings to 4 hours and stops automatically if you minimize the target window. Cap records for as long as you need with no restrictions.",
		},
	],

	comparisonTable: {
		title: "Feature Comparison: Cap vs Game Bar vs OBS",
		headers: ["Feature", "Cap", "Game Bar", "OBS"],
		rows: [
			[
				"Price",
				{ text: "Free & open source", status: "positive" },
				{ text: "Free (built-in)", status: "positive" },
				{ text: "Free & open source", status: "positive" },
			],
			[
				"Setup Time",
				{ text: "Under 2 minutes", status: "positive" },
				{ text: "Pre-installed", status: "positive" },
				{ text: "15-30 minutes", status: "warning" },
			],
			[
				"Full Screen Recording",
				{ text: "Yes", status: "positive" },
				{ text: "No — single app only", status: "negative" },
				{ text: "Yes", status: "positive" },
			],
			[
				"Custom Region Capture",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Yes", status: "positive" },
			],
			[
				"Webcam Overlay",
				{ text: "Built-in", status: "positive" },
				{ text: "Not available", status: "negative" },
				{ text: "Requires scene setup", status: "warning" },
			],
			[
				"System + Mic Audio",
				{ text: "One-click toggle", status: "positive" },
				{ text: "Limited controls", status: "warning" },
				{ text: "Advanced mixer", status: "positive" },
			],
			[
				"Instant Link Sharing",
				{ text: "Yes — auto-generated", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Learning Curve",
				{ text: "Minimal", status: "positive" },
				{ text: "Minimal", status: "positive" },
				{ text: "Steep", status: "negative" },
			],
			[
				"Recording Time Limit",
				{ text: "Unlimited", status: "positive" },
				{ text: "4 hours max", status: "warning" },
				{ text: "Unlimited", status: "positive" },
			],
			[
				"Built-In Editor",
				{ text: "Trim, crop, backgrounds", status: "positive" },
				{ text: "Basic trim only", status: "warning" },
				{ text: "None", status: "negative" },
			],
		],
	},

	recordingModes: {
		title: "Two Ways to Record on Windows",
		description:
			"Cap gives you flexible recording options to match your workflow — whether you need a quick screen capture or a polished studio recording",
		modes: [
			{
				icon: (
					<Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />
				),
				title: "Instant Mode",
				description:
					"Click record and share your screen right away with an auto-generated link. Ideal for quick bug reports, async standups, and answering questions with a screencast instead of a wall of text.",
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
					"Record locally, then polish your video with the built-in editor before sharing. Add custom backgrounds, trim dead air, and produce professional-quality tutorials and demos — all free on Windows.",
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
				"Download Cap from cap.so/download, install it on your Windows 10 PC, and click the record button. Choose full screen, a single window, or a custom region, toggle your microphone and system audio on or off, and hit start. When you are done, Cap gives you a shareable link instantly. It is the easiest way to screen record on Windows 10 without fiddling with Game Bar or OBS settings.",
		},
		{
			question: "How do I screen record on Windows 11?",
			answer:
				"Cap works identically on Windows 11. Download and install Cap, pick your capture area, enable audio sources, and record. Windows 11 users get the same HD quality, webcam overlay, and instant sharing features. Cap is fully optimized for Windows 11's latest APIs.",
		},
		{
			question: "Is Cap really a free screen recorder for Windows?",
			answer:
				"Yes. Cap is 100% free to use locally on Windows with no watermarks, no time limits, and no feature gates. It is open source so you can inspect the code yourself. Cap Pro is available for teams that want cloud storage and advanced sharing, but the core <a href='/free-screen-recorder'>free screen recorder</a> is fully functional.",
		},
		{
			question: "Can I record my screen with audio on Windows?",
			answer:
				"Absolutely. Cap records system audio (everything you hear through your speakers or headphones) and microphone input simultaneously. You can toggle each source independently before or during recording. This makes Cap ideal for tutorials, gameplay, and presentations where both audio tracks matter.",
		},
		{
			question:
				"What is the best free screen recording software for Windows?",
			answer:
				"Cap is the best free screen recording software for Windows if you want a balance of simplicity, quality, and sharing speed. Unlike OBS, Cap requires zero configuration. Unlike Windows Game Bar, Cap can record your full desktop, custom regions, and add a webcam overlay. And unlike Loom, Cap is fully <a href='/loom-alternative'>open source</a> with no per-seat pricing.",
		},
		{
			question: "How does Cap compare to OBS for Windows screen recording?",
			answer:
				"OBS is a powerful streaming and recording tool, but it is designed for broadcasters and has a steep learning curve. Cap is built for fast screen recording and sharing — you can go from zero to a shareable recording in under two minutes. If you need streaming overlays and multi-scene switching, use OBS. If you need quick, polished screen recordings with instant links, Cap is the better choice.",
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
		{
			question: "Can I use Cap for recording gameplay on Windows?",
			answer:
				"Yes. Cap can record full-screen applications including games. While Windows Game Bar is limited to a single app window and has a 4-hour cap, Cap records for as long as you want with system audio captured natively. For dedicated streamers, OBS may offer more broadcast features, but for quick gameplay clips and highlights, Cap is the simpler choice.",
		},
		{
			question: "Is Cap better than Windows Snipping Tool for screen recording?",
			answer:
				"Windows Snipping Tool (available on Windows 11) can record your screen but offers no audio recording, no webcam overlay, no editing, and no sharing features. Cap records with audio, adds facecam, includes a built-in editor, and generates instant share links — making it a far more complete <a href='/screen-recording-software'>screen recording solution</a> for Windows.",
		},
	],

	video: {
		url: "/videos/cap-windows-screen-recorder-demo.mp4",
		thumbnail: "/videos/cap-windows-screen-recorder-thumbnail.png",
		alt: "Cap screen recorder running on Windows 11 showing HD recording with webcam overlay",
	},

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
