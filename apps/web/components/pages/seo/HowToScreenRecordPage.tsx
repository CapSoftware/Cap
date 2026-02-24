"use client";

import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const howToScreenRecordContent: SeoPageContent = {
	title: "How to Screen Record on Mac, Windows & Chrome (2026 Guide)",
	description:
		"Learn how to screen record on any device with this step-by-step guide. Whether you need to screen record on Mac, Windows, or directly in your browser, this comprehensive guide covers every method with and without audio. Get started in minutes with Cap, the free open-source screen recorder.",

	featuresTitle: "How to Screen Record: Complete Platform Guides",
	featuresDescription:
		"Follow these step-by-step instructions to start screen recording on your platform of choice. Each guide covers how to screen record with audio enabled so you capture everything you need.",

	features: [
		{
			title: "How to Screen Record on Mac with Cap",
			description:
				"Getting started with screen recording on Mac is simple with Cap. Here is how to do a screen recording on Mac in just a few steps: First, download Cap from <a href='/download'>cap.so/download</a> and install it on your Mac. Once installed, open Cap and grant the necessary screen recording and microphone permissions when prompted. Click the record button to start capturing your entire screen or select a specific window. Cap records in high definition at up to 60fps, ensuring your Mac screen recordings look crisp and professional. When you are finished, click stop to end the recording. Cap will process your video and give you a shareable link instantly, or you can export the file locally. For Mac users who want a quick alternative, macOS includes a built-in screenshot toolbar. Press Cmd+Shift+5 to access it and select either Record Entire Screen or Record Selected Portion. However, the built-in tool lacks audio recording, webcam overlay, and instant sharing features that Cap provides.",
		},
		{
			title: "How to Screen Record with Audio on Mac",
			description:
				"One of the most common questions is how to screen record with audio on Mac. By default, the macOS built-in screen recorder does not capture internal system audio, which frustrates many users. Cap solves this problem completely. When you record with Cap on Mac, it captures both your microphone audio and system audio simultaneously without any extra configuration. Simply toggle the audio sources you want in Cap before you start recording. This makes Cap ideal for recording presentations with narration, capturing video calls, creating software tutorials with sound effects, or recording gameplay audio. If you need to screen record on Mac with internal audio using the built-in tool, you would need to install a third-party audio routing extension, which adds complexity. Cap eliminates this hassle entirely by handling audio capture natively on macOS.",
		},
		{
			title: "How to Screen Record on Windows with Cap",
			description:
				"Screen recording on Windows is straightforward with Cap. Download Cap from <a href='/download'>cap.so/download</a> and install it on your Windows PC. Launch Cap and grant the required permissions for screen and audio capture. Select whether you want to record your full screen, a specific window, or a custom region. Click record to begin capturing. Cap is optimized for Windows performance, delivering smooth recordings without impacting your system. Once finished, stop the recording and share it instantly via link or export it to your preferred format. Windows also includes a built-in option called the Xbox Game Bar. Press Win+G to open it and click the record button. However, Game Bar only records the active window, does not support full-screen desktop recording, and has limited export options compared to Cap.",
		},
		{
			title: "How to Screen Record on Windows 10 and 11 with Audio",
			description:
				"Recording your screen with audio on Windows 10 and Windows 11 is effortless with Cap. Cap automatically detects your audio devices and lets you record system audio, microphone audio, or both simultaneously. Before starting your recording, select your preferred audio input from the Cap interface. This works identically on Windows 10 and Windows 11 without any additional setup. If you are using the Xbox Game Bar on Windows, it does capture audio by default but only from the active application. It cannot capture audio from multiple sources or give you fine-grained control over audio levels. For full audio control and the best screen recording experience on Windows 10 or Windows 11, <a href='/screen-recorder-windows'>Cap is the recommended solution</a>.",
		},
		{
			title: "How to Screen Record in Your Browser",
			description:
				"Sometimes you need to record your screen without installing any software. Cap offers an Instant Mode that works directly in your browser. Visit <a href='https://cap.so'>cap.so</a> and click Record to start a browser-based recording session. Your browser will ask for permission to access your screen and microphone. Choose which screen, window, or browser tab to share, and Cap begins recording immediately. Instant Mode supports recordings up to 5 minutes on the free plan, with a shareable link generated automatically when you stop recording. This is perfect for quick demos, bug reports, or feedback videos when you do not have the desktop app installed. No downloads, no extensions, and no complicated setup. Just open your browser and start recording.",
		},
		{
			title: "How to Record a Specific Window or Region",
			description:
				"Whether you are on Mac or Windows, Cap lets you choose exactly what to capture. You can record your entire screen for full-context demos, select a specific application window to focus on one app, or draw a custom region to capture just the area you need. This flexibility is essential for creating clean, focused recordings. When recording a specific window with Cap, the recording automatically follows that window even if it moves or resizes. On macOS, you can also use Cmd+Shift+5 to select a portion of your screen, though this lacks the window-tracking feature that Cap provides.",
		},
	],

	comparisonTable: {
		title: "Best Screen Recording Software Comparison",
		headers: ["Feature", "Cap", "OBS Studio", "Loom", "Built-in Tools"],
		rows: [
			[
				"Price",
				{ text: "Free / from $8.16/mo", status: "positive" },
				{ text: "Free", status: "positive" },
				{ text: "From $18/mo", status: "warning" },
				{ text: "Free", status: "positive" },
			],
			[
				"Ease of Use",
				{ text: "Very Easy", status: "positive" },
				{ text: "Complex", status: "warning" },
				{ text: "Easy", status: "positive" },
				{ text: "Basic", status: "neutral" },
			],
			[
				"System Audio Capture",
				{ text: "Built-in", status: "positive" },
				{ text: "Requires Setup", status: "warning" },
				{ text: "Built-in", status: "positive" },
				{ text: "Limited/None", status: "negative" },
			],
			[
				"Instant Sharing",
				{ text: "One-click link", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"Open Source",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Recording Quality",
				{ text: "Up to 4K 60fps", status: "positive" },
				{ text: "Up to 4K 60fps", status: "positive" },
				{ text: "Up to 4K", status: "positive" },
				{ text: "Limited", status: "warning" },
			],
			[
				"Browser Recording",
				{ text: "Yes (Instant Mode)", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"Webcam Overlay",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"Custom Region Recording",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Limited", status: "warning" },
				{ text: "Partial", status: "warning" },
			],
			[
				"Data Ownership",
				{ text: "Own S3 storage", status: "positive" },
				{ text: "Local only", status: "neutral" },
				{ text: "Platform locked", status: "negative" },
				{ text: "Local only", status: "neutral" },
			],
		],
	},

	useCasesTitle: "When to Use Screen Recording",
	useCasesDescription:
		"Screen recording is an essential tool for professionals, educators, and creators. Here are the most popular ways people use screen recording every day.",

	useCases: [
		{
			title: "Software Tutorials and Walkthroughs",
			description:
				"Create clear, step-by-step guides showing exactly how to use an application. Screen recording with audio narration helps viewers follow along and learn at their own pace. <a href='/how-to-screen-record'>Learn how to screen record</a> with Cap to start creating professional tutorials today.",
		},
		{
			title: "Bug Reports and Technical Support",
			description:
				"Show exactly what went wrong by recording your screen instead of writing long descriptions. A quick screen recording with a shareable link saves time for both support teams and users.",
		},
		{
			title: "Remote Team Communication",
			description:
				"Replace long meetings with short recorded walkthroughs. Share updates, code reviews, design feedback, or project status asynchronously so your team can watch on their own schedule.",
		},
		{
			title: "Presentations and Demos",
			description:
				"Record polished product demos, sales presentations, or pitch decks with webcam overlay. Share them instantly with prospects, clients, or stakeholders via a simple link.",
		},
	],

	migrationGuide: {
		title: "Quick Start: How to Screen Record with Cap in 4 Steps",
		steps: [
			"Download Cap for free from cap.so/download for Mac or Windows, or use Instant Mode in your browser for quick recordings without any installation.",
			"Open Cap and select your recording source. Choose between full screen, specific window, or custom region capture. Toggle microphone and system audio on or off based on your needs.",
			"Click the record button to begin capturing your screen. Cap records in high definition with minimal system impact so you can present, demo, or teach without lag.",
			"Stop the recording when finished. Cap generates an instant shareable link, or you can export the video locally in your preferred format. Share your recording with anyone in seconds.",
		],
	},

	faqsTitle: "Screen Recording FAQ",
	faqs: [
		{
			question: "How do I screen record on my computer?",
			answer:
				"To screen record on your computer, download a screen recording app like <a href='/download'>Cap</a> for Mac or Windows. Open the app, select what you want to record (full screen, a window, or a custom area), and click record. Cap also offers browser-based recording through Instant Mode if you prefer not to install anything. On Mac, you can also press Cmd+Shift+5 for a basic built-in recorder. On Windows, press Win+G to open Xbox Game Bar. However, these built-in tools have limited features compared to dedicated <a href='/screen-recording-software'>screen recording software</a>.",
		},
		{
			question: "How to screen record with audio?",
			answer:
				"To screen record with audio, use a tool like Cap that supports both microphone and system audio capture. Before starting your recording, make sure the audio source toggle is enabled in Cap. You can record your microphone for narration, system audio for capturing sounds from applications, or both simultaneously. This is especially useful for creating tutorials, recording video calls, or capturing gameplay. Unlike many built-in screen recorders, Cap handles audio capture natively on both <a href='/screen-recorder-mac'>Mac</a> and <a href='/screen-recorder-windows'>Windows</a> without any extra plugins.",
		},
		{
			question: "Can I screen record for free?",
			answer:
				"Yes, you can screen record for free with Cap. Cap offers a generous <a href='/free-screen-recorder'>free screen recorder</a> plan that includes Studio Mode for personal use with unlimited local recording time and up to 4K resolution. Instant Mode lets you create shareable recordings up to 5 minutes for free, directly from your browser. Other free options include OBS Studio (open-source but complex), the built-in macOS screenshot toolbar, and Windows Xbox Game Bar. Cap provides the best balance of free features, ease of use, and recording quality.",
		},
		{
			question: "How to screen record on Mac with internal audio?",
			answer:
				"Recording screen with internal audio on Mac is one of the most frequently asked questions because macOS does not capture system audio by default. With Cap, internal audio recording on Mac works out of the box. Simply enable system audio in Cap before you start recording, and it will capture all sounds playing on your Mac alongside your screen recording. If you want to use the built-in macOS recorder (Cmd+Shift+5), you will need to install a third-party audio routing tool like BlackHole or Loopback, which adds significant complexity. Cap is the simplest way to <a href='/screen-recorder-mac'>screen record on Mac</a> with internal audio.",
		},
		{
			question: "How to turn on screen recording?",
			answer:
				"On Mac, go to System Settings, then Privacy and Security, then Screen Recording, and enable access for your recording app (like Cap). You may need to restart the app after granting permission. On Windows, no special permission is usually required for third-party apps like Cap. For Xbox Game Bar, make sure it is enabled in Settings under Gaming. On both platforms, when you first open Cap, it will prompt you to grant the necessary screen recording permissions automatically, making the setup process simple and quick.",
		},
		{
			question: "What is the best free screen recorder?",
			answer:
				"Cap is the best <a href='/free-screen-recorder'>free screen recorder</a> for most users. It offers HD quality recording, instant sharing, and works on both Mac and Windows. Unlike OBS, Cap is simple to use with no complex configuration needed. Unlike Loom, Cap is open-source and offers a more generous free plan. Cap's free tier includes Studio Mode for personal use with unlimited recording time, 4K resolution support, and Instant Mode for quick shareable recordings. For power users who need extreme customization, OBS Studio is another excellent free option, though it has a steeper learning curve.",
		},
		{
			question: "How to screen record on Windows without Game Bar?",
			answer:
				"To screen record on Windows without using Xbox Game Bar, download <a href='/download'>Cap</a> or another third-party screen recorder. Cap offers several advantages over Game Bar: it can record your full desktop (not just the active window), capture system and microphone audio simultaneously, record in up to 4K at 60fps, and generate instant shareable links. Simply install Cap, open it, select your recording area, and click record. It is a much more capable <a href='/screen-recorder-windows'>screen recorder for Windows</a> than the built-in Game Bar.",
		},
		{
			question: "Can I screen record a specific window?",
			answer:
				"Yes, Cap lets you screen record a specific window on both Mac and Windows. When you start a recording in Cap, you can choose to capture a single application window instead of your entire screen. This is ideal for focused tutorials, app demos, or recording specific workflows without showing your desktop or other private windows. Cap's window recording mode automatically follows the window even if it is moved or resized during the recording, ensuring a clean and professional result every time.",
		},
		{
			question: "How long can I screen record?",
			answer:
				"With Cap's desktop app, there are no time limits on screen recordings. You can record for as long as you need, whether it is a 30-second quick demo or a 2-hour training session. Cap's Instant Mode (browser-based) supports recordings up to 5 minutes on the free plan. For unlimited browser-based recording length, Cap Pro is available at an affordable monthly price. The macOS built-in recorder and Windows Game Bar also have no strict time limits, though they lack the sharing and editing features that Cap provides.",
		},
		{
			question: "What format do screen recordings save in?",
			answer:
				"Cap saves screen recordings in widely compatible formats that work across all devices and platforms. You can export your recordings as MP4 files, which are supported everywhere. When sharing via Cap's instant link feature, videos are automatically optimized for web playback. Cap also supports exporting to other formats based on your needs. If you need to <a href='/tools/mp4-to-gif-converter'>convert your recording to GIF</a>, Cap has tools for that as well.",
		},
	],

	video: {
		url: "/videos/cap-demo.mp4",
		thumbnail: "/videos/cap-demo-thumbnail.png",
		alt: "How to screen record with Cap on Mac and Windows",
	},

	cta: {
		title: "Start Screen Recording for Free with Cap",
		buttonText: "Download Cap Free",
		secondaryButtonText: "Try Instant Mode in Browser",
	},
};

export const HowToScreenRecordPage = () => {
	return <SeoPageTemplate content={howToScreenRecordContent} />;
};
