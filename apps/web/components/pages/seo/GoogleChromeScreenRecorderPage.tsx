import Image from "next/image";
import { CAP_CHROME_EXTENSION_URL } from "@/lib/chrome-extension";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const googleChromeScreenRecorderContent: SeoPageContent = {
	title:
		"Google Chrome Screen Recorder: Record Your Screen Right From the Browser",
	description:
		"Cap is a free, open-source screen recorder for Google Chrome. Add the extension, click record, and get an instant shareable link — no downloads, no watermarks, no sign-up required.",

	featuresTitle: "Why Cap Is the Best Chrome Screen Recorder",
	featuresDescription:
		"Professional screen recording built right into Google Chrome — lightweight, private, and 100% free locally.",

	features: [
		{
			title: "One-Click Recording in Chrome",
			description:
				"Pin the Cap extension, click the icon, and start capturing your screen in seconds. No app install or setup needed to record a quick video.",
		},
		{
			title: "Instant Shareable Links",
			description:
				"The moment you stop recording, Cap gives you a link you can paste into Slack, email, or a ticket. Viewers watch in their browser — no extension required on their end.",
		},
		{
			title: "Record Tab, Window, or Full Screen",
			description:
				"Capture a single Chrome tab, a specific application window, or your entire desktop. Perfect for focused demos or full walkthroughs.",
		},
		{
			title: "Webcam + Screen Together",
			description:
				"Add your webcam to put a face to your recording. Great for async updates, feedback, and onboarding videos that feel personal.",
		},
		{
			title: "No Watermarks, No Time Limits",
			description:
				"Unlike most browser recorders, Cap never stamps a watermark on your video and never cuts you off. Record as long as you need, for free.",
		},
		{
			title: "Free & Open Source",
			description:
				"Cap is fully <a href='/open-source-screen-recorder'>open source</a>. Your recordings stay yours — keep them local, use your own storage, or self-host.",
		},
	],

	video: {
		title: "See the Cap Chrome Extension in Action",
	},

	comparisonTitle: "Does Chrome Have a Built-In Screen Recorder?",
	comparisonDescription:
		"Google Chrome has no native screen recorder. You can capture screenshots and share your screen on a call, but to <a href='/record-screen'>record and save a video</a> you need an extension. Here's how Cap stacks up.",
	comparison: [
		{
			title: "Built Into Your Browser",
			description:
				"Cap lives in your Chrome toolbar, so recording is always one click away — no switching apps, no juggling windows.",
		},
		{
			title: "Own Your Recordings",
			description:
				"Most Chrome recorders lock your videos behind their cloud. Cap lets you keep recordings local, connect your own storage, or share with a link on your terms.",
		},
	],

	comparisonTable: {
		title: "Cap vs. Other Chrome Screen Recorders",
		headers: ["Feature", "Cap", "Loom", "Screencastify"],
		rows: [
			[
				"Free with no watermark",
				{ text: "Yes", status: "positive" },
				{ text: "Watermark on free", status: "negative" },
				{ text: "Watermark on free", status: "negative" },
			],
			[
				"Recording length (free)",
				{ text: "Unlimited (with desktop app)", status: "positive" },
				{ text: "5 minutes", status: "warning" },
				{ text: "5 minutes", status: "warning" },
			],
			[
				"Instant shareable link",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
			],
			[
				"Recording quality",
				{ text: "Up to 4K", status: "positive" },
				{ text: "1080p", status: "warning" },
				{ text: "1080p", status: "warning" },
			],
			[
				"Desktop app for studio editing",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"Open source",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Own your data / self-host",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
		],
	},

	useCasesTitle: "What People Record With Cap on Chrome",
	useCasesDescription:
		"From quick bug reports to polished demos, Cap fits how teams work in the browser.",

	useCases: [
		{
			title: "Bug Reports & QA",
			description:
				"Reproduce a bug on screen and share the link instead of writing paragraphs. Engineers see exactly what happened, faster.",
		},
		{
			title: "Async Standups & Updates",
			description:
				"Skip the meeting. Record a two-minute update with your screen and webcam, drop the link in your team channel, and move on.",
		},
		{
			title: "Customer Support & Onboarding",
			description:
				"Walk a customer through a workflow with a short recording they can rewatch anytime — far clearer than a wall of text.",
		},
		{
			title: "Tutorials & Demos",
			description:
				"Show your product, design, or web app in action. Cap makes <a href='/screen-recorder'>screen recordings</a> look polished without any editing.",
		},
	],

	faqsTitle: "Frequently Asked Questions",
	faqs: [
		{
			question: "Does Google Chrome have a built-in screen recorder?",
			answer:
				"No. Chrome can take screenshots and share your screen during a video call, but it has no native tool to record and save a screen video. To record your screen in Chrome you need an extension like Cap, which adds one-click recording and instant shareable links to your browser.",
		},
		{
			question: "How do I record my screen on Google Chrome?",
			answer:
				"Add the Cap extension from the Chrome Web Store, pin it to your toolbar, then click the Cap icon and choose what to record — a tab, a window, or your full screen. Click stop when you're done and Cap instantly generates a shareable link.",
		},
		{
			question: "Is the Cap Chrome extension free?",
			answer:
				"Yes. Cap's Chrome extension is free to use with no watermarks and no recording time limits. Cap Pro is available if you want custom domains, longer cloud sharing, and advanced collaboration features, but recording and sharing work without it.",
		},
		{
			question: "Can I record a single tab instead of my whole screen?",
			answer:
				"Yes. Cap lets you choose a specific Chrome tab, an individual application window, or your entire desktop before you start recording, so you only capture what you want to show.",
		},
		{
			question: "Do viewers need the extension to watch my recording?",
			answer:
				"No. Recordings play in any browser through the link you share — your viewers don't need to install anything. They just click the link and watch.",
		},
		{
			question: "Can I record my webcam and screen at the same time?",
			answer:
				"Yes. Cap can capture your webcam alongside your screen, so you can add a personal face-to-camera layer to demos, updates, and onboarding videos.",
		},
		{
			question:
				"Does it work on Edge, Brave, Arc, and other Chromium browsers?",
			answer:
				"Yes. Because Cap is a Chromium extension, it installs and runs on Chrome and other Chromium-based browsers including Microsoft Edge, Brave, Arc, Opera, and Vivaldi. Prefer a native app? Cap also has a free desktop app for Mac and Windows.",
		},
	],

	cta: {
		title: "Start Recording in Chrome — Free",
		subtitle:
			"Add Cap to Chrome and capture your first recording in seconds. No account required.",
		buttonText: "Add to Chrome",
		buttonHref: CAP_CHROME_EXTENSION_URL,
		buttonTarget: "_blank",
		buttonIcon: (
			<Image
				src="/logos/browsers/google-chrome.svg"
				width={20}
				height={20}
				alt=""
				className="mr-2 size-5 shrink-0"
			/>
		),
		secondaryButtonText: "Download Desktop App",
		secondaryButtonHref: "/download",
	},
};

export const GoogleChromeScreenRecorderPage = () => {
	return <SeoPageTemplate content={googleChromeScreenRecorderContent} />;
};
