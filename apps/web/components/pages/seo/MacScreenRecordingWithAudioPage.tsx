"use client";

import { Clapperboard, Zap } from "lucide-react";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const macScreenRecordingWithAudioContent: SeoPageContent = {
	title: "Mac Screen Recording with Audio — Capture System Sound & Mic | Cap",
	description:
		"Record your Mac screen with both system audio and microphone using Cap. The free, open-source solution to macOS's missing internal audio recording. No plugins, no setup — just press record.",

	featuresTitle: "Everything You Need for Mac Screen Recording with Audio",
	featuresDescription:
		"Cap solves the biggest frustration with Mac screen recording — capturing internal audio — and adds professional features on top",

	features: [
		{
			title: "System Audio Capture Built In",
			description:
				"macOS does not capture internal audio by default. Cap solves this natively — no BlackHole, no Loopback, no virtual audio drivers required. Enable system audio in Cap's settings and it records app sounds, music, and notification audio alongside your screen without any extra configuration.",
		},
		{
			title: "Microphone and System Audio Simultaneously",
			description:
				"Cap records your microphone and system audio at the same time in a single recording. Narrate your screen while keeping all the original application sounds — perfect for software tutorials, walkthroughs, and presentation recordings on Mac.",
		},
		{
			title: "Up to 4K at 60fps on macOS",
			description:
				"Cap is natively optimized for macOS and records at resolutions up to 4K at 60 frames per second. Every screen recording is sharp, smooth, and professional — ideal for Retina displays on MacBook Pro and iMac.",
		},
		{
			title: "Webcam Overlay While Recording",
			description:
				"Add a picture-in-picture webcam overlay to any Mac screen recording with audio. Record your face alongside your screen for a more personal, engaging experience — great for tutorials, product demos, and async video messages.",
		},
		{
			title: "Instant Shareable Links",
			description:
				"Stop recording on your Mac and Cap generates a shareable link immediately. No uploading, no file transfers. Paste the link anywhere and your viewers get instant access to the full recording with audio.",
		},
		{
			title: "Free with No Watermarks",
			description:
				"Cap's Studio Mode is completely free for personal use on Mac with no watermarks, no time limits, and no hidden fees. <a href='/free-screen-recorder'>Download Cap's free screen recorder</a> to start recording with audio on Mac today.",
		},
		{
			title: "AI-Generated Captions from Your Audio",
			description:
				"Cap automatically transcribes your screen recording audio into accurate captions. Whether you are recording a tutorial narration or capturing a presentation, captions are generated automatically — no manual effort required.",
		},
		{
			title: "Open Source and Privacy-First",
			description:
				"Cap is fully open-source and supports your own S3-compatible storage for complete data ownership. Your Mac screen recordings with audio stay private and under your control — always. <a href='/open-source-screen-recorder'>Learn more about Cap as open-source software</a>.",
		},
	],

	recordingModes: {
		title: "Two Ways to Record Your Mac Screen with Audio",
		description:
			"Cap adapts to whether you need a quick share or a polished production",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Record your Mac screen with audio and get a shareable link the moment you stop. Perfect for quick demos, bug reports, and async team updates. Free plan includes recordings up to 5 minutes with built-in thread commenting.",
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
					"Completely free for personal use with no time limits. Records your Mac screen with audio at up to 4K quality with separate screen and webcam tracks for full editing control. Ideal for professional tutorials and polished product demos.",
			},
		],
	},

	comparisonTable: {
		title: "Mac Screen Recording with Audio: Tool Comparison",
		headers: [
			"Feature",
			"Cap",
			"macOS Cmd+Shift+5",
			"QuickTime Player",
			"OBS Studio",
		],
		rows: [
			[
				"Internal system audio",
				{ text: "Built-in, no plugins", status: "positive" },
				{ text: "Not supported", status: "negative" },
				{ text: "Not supported", status: "negative" },
				{ text: "Requires setup", status: "warning" },
			],
			[
				"Microphone recording",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
			],
			[
				"Mic + system audio together",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "Requires routing", status: "warning" },
			],
			[
				"Instant share link",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Webcam overlay",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "Yes", status: "positive" },
			],
			[
				"4K recording",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
			],
			[
				"No watermark",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
			],
			[
				"AI captions",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
		],
	},

	comparisonTitle: "Cap vs Built-in Mac Recorders for Audio",
	comparisonDescription:
		"Understand why the built-in macOS tools fall short for audio recording and how Cap fills the gap",

	comparison: [
		{
			title: "Cap vs macOS Cmd+Shift+5",
			description:
				"The macOS built-in screenshot toolbar (Cmd+Shift+5) can record your screen but cannot capture system audio. It records microphone only. Cap captures both system audio and microphone natively on macOS without any additional tools — making it the far superior choice for anyone who needs audio in their Mac screen recordings. <a href='/screen-recorder-mac'>See all reasons to use Cap on Mac</a>.",
		},
		{
			title: "Cap vs QuickTime Player",
			description:
				"QuickTime Player's screen recording feature also lacks internal audio capture on modern versions of macOS. Like Cmd+Shift+5, it can only record the microphone. Cap removes this limitation entirely, capturing system audio natively alongside microphone input in every recording.",
		},
		{
			title: "Cap vs OBS Studio for Mac",
			description:
				"OBS Studio can record Mac screen with audio, but it requires installing and configuring a virtual audio device like BlackHole to capture system sound — a multi-step process that is easy to get wrong. Cap handles all audio routing automatically with zero configuration. <a href='/screen-recording-software'>Compare all screen recording software</a>.",
		},
		{
			title: "Cap vs Loom on Mac",
			description:
				"Loom records Mac screen with audio and is a popular tool for async video, but it charges $18/month for professional use and adds watermarks on the free plan. Cap is significantly more affordable, fully open-source, and offers Studio Mode completely free with no watermarks. <a href='/loom-alternative'>See the full Cap vs Loom comparison</a>.",
		},
	],

	migrationGuide: {
		title: "How to Record Your Mac Screen with Audio Using Cap",
		steps: [
			"Download Cap for free from cap.so/download and install it on your Mac. Grant the required Screen Recording and Microphone permissions when prompted — these are needed to capture your display and audio.",
			"Open Cap from your menu bar. In the recording settings, toggle on Microphone and System Audio. You can enable one or both depending on whether you want narration, app sounds, or both in your recording.",
			"Choose your recording source — full screen, a specific window, or a custom region. Click the record button to begin capturing your Mac screen with audio immediately.",
			"When you are done, click Stop. Cap processes your recording and gives you a shareable link instantly, or you can export it as an MP4 file for use in editing software or local storage.",
		],
	},

	useCasesTitle: "Why People Record Mac Screen with Audio",
	useCasesDescription:
		"From tutorial creators to remote teams — here are the most common reasons Mac users need screen recording with audio",

	useCases: [
		{
			title: "Software Tutorials and Walkthroughs",
			description:
				"Create step-by-step tutorials where narration and application sounds both matter. Cap records your Mac screen with microphone and system audio so viewers hear exactly what you hear as you demonstrate software.",
		},
		{
			title: "Recording Video Calls and Presentations",
			description:
				"Capture Zoom calls, Google Meet sessions, or Keynote presentations in full — screen and audio together. Cap records system audio natively on Mac, so you never miss a word from participants or presenter.",
		},
		{
			title: "Bug Reports with Sound Context",
			description:
				"Some bugs involve audio — unexpected sounds, missing audio feedback, or broken voice responses. Recording Mac screen with audio gives your development team the full picture when you file a bug report.",
		},
		{
			title: "Async Team Communication",
			description:
				"Replace status meetings with short video updates recorded on your Mac. Share the link in Slack or email so your team can watch with full audio context on their own schedule. <a href='/solutions/remote-team-collaboration'>Learn how Cap supports remote teams</a>.",
		},
		{
			title: "Course and Educational Content",
			description:
				"Educators and course creators need Mac screen recordings with both narration and application audio for engaging lessons. Cap's Studio Mode is free for personal use with no time limits. <a href='/solutions/online-classroom-tools'>Learn how Cap supports educators</a>.",
		},
		{
			title: "Product Demos for Clients",
			description:
				"Record polished product walkthroughs with voiceover narration on your Mac and share them as links. Clients can watch with full audio and leave timestamped comments via Cap's built-in thread commenting.",
		},
	],

	faqsTitle: "Mac Screen Recording with Audio — FAQ",
	faqs: [
		{
			question: "Why doesn't macOS record internal audio by default?",
			answer:
				"Apple restricts internal audio capture on macOS for privacy and copyright protection reasons. The built-in recorder (Cmd+Shift+5) and QuickTime Player can only record your microphone — not sounds playing from apps or the system. To capture internal audio on Mac, you either need a third-party audio routing tool like BlackHole or an app like Cap that handles system audio capture natively without any extra configuration.",
		},
		{
			question: "How do I record my Mac screen with internal audio?",
			answer:
				"The easiest way to record your Mac screen with internal audio is to use Cap. Download the app, enable System Audio in the recording settings, and click record. Cap captures all sounds playing on your Mac alongside your screen recording without requiring any audio routing extensions or virtual sound cards. The macOS built-in tools cannot capture internal audio, so a dedicated app like Cap is the practical solution.",
		},
		{
			question:
				"Can I record Mac screen with both microphone and system audio?",
			answer:
				"Yes — with Cap you can record both microphone and system audio simultaneously on Mac. Before starting a recording, enable both audio sources in Cap's settings. Cap mixes or captures both tracks and includes them in your recording. This is ideal for tutorials where you narrate while application sounds play, or for recording video calls where you want to capture all participants.",
		},
		{
			question: "Does Cap require BlackHole or Loopback for audio on Mac?",
			answer:
				"No. Cap handles Mac system audio capture natively without requiring BlackHole, Loopback, or any virtual audio driver. This is one of the key advantages of Cap over OBS Studio and other screen recorders that depend on third-party audio routing tools on macOS.",
		},
		{
			question: "Is there a free way to record Mac screen with audio?",
			answer:
				"Yes. Cap is completely free for Mac screen recording with audio. Studio Mode has no time limits, no watermarks, and no fees. Instant Mode on the free plan supports recordings up to 5 minutes with shareable links. <a href='/free-screen-recorder'>Download Cap free</a> and start recording your Mac with audio today.",
		},
		{
			question: "Does Cap record Mac screen with audio in 4K?",
			answer:
				"Yes. Cap records your Mac screen at up to 4K resolution at 60fps while simultaneously capturing system audio and microphone input. This makes it suitable for professional tutorial creation, high-quality demos, and content production on Retina-display Macs.",
		},
		{
			question: "How do I share a Mac screen recording with audio?",
			answer:
				"With Cap, sharing is automatic. When you stop recording, Cap processes your Mac screen recording with audio and generates a shareable link in seconds. Copy the link and paste it anywhere — Slack, email, Notion, or a browser. Viewers get instant access without needing to download anything.",
		},
		{
			question: "Can I record a specific app window with audio on Mac?",
			answer:
				"Yes. Cap lets you record a specific application window on Mac while capturing that app's system audio along with your microphone. This is perfect for recording a single app's behavior without showing your full desktop, while still including all the relevant audio from that application.",
		},
	],

	video: {
		url: "/videos/cap-demo.mp4",
		thumbnail: "/videos/cap-demo-thumbnail.png",
		alt: "Cap recording Mac screen with system audio and microphone simultaneously",
	},

	cta: {
		title: "Record Your Mac Screen with Audio — Free",
		buttonText: "Download Cap Free for Mac",
		secondaryButtonText: "Try Instant Mode in Browser",
	},
};

export const MacScreenRecordingWithAudioPage = () => {
	return <SeoPageTemplate content={macScreenRecordingWithAudioContent} />;
};
