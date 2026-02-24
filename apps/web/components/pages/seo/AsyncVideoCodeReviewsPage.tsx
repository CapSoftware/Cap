"use client";

import { Code, MessageSquare } from "lucide-react";
import { SeoPageTemplate } from "../../seo/SeoPageTemplate";
import type { SeoPageContent } from "../../seo/types";

export const asyncVideoCodeReviewsContent: SeoPageContent = {
	title: "Async Video Code Reviews — Ship Faster Without the Meetings",
	description:
		"Record your screen, walk through pull requests and diffs, and share a timestamped video link your team can watch on their own schedule. Cap makes async code reviews faster, clearer, and calendar-free.",

	badge: "Code Reviews",

	featuresTitle: "Everything You Need for Async Video Code Reviews",
	featuresDescription:
		"Cap gives engineering teams a faster way to give and receive code feedback — no scheduled calls, no back-and-forth in PR comments",

	features: [
		{
			title: "Record Any PR or Diff Walkthrough",
			description:
				"Open your IDE, point your camera at the diff, and talk through your feedback in real time. Cap records your screen and webcam simultaneously so reviewers see exactly what you see — cursor movements, code highlights, and all. No more writing long PR comments that take longer to read than a 90-second video.",
		},
		{
			title: "Instant Shareable Link — No Upload Wait",
			description:
				"Stop recording and Cap generates a shareable link immediately. Paste it into your PR comment, Slack message, or Linear ticket. Reviewers click the link and the video plays in their browser — no app install, no login required on their end.",
		},
		{
			title: "Timestamped Comments and Threads",
			description:
				"Reviewers can leave comments at specific timestamps in the video, turning async code review recordings into threaded discussions. Replies, reactions, and resolved threads keep feedback organized without flooding your PR with comments.",
		},
		{
			title: "4K Recording at 60fps for Sharp Code Legibility",
			description:
				"Syntax highlighting, font rendering, and editor themes are captured at full fidelity. Cap records at up to 4K resolution and 60fps so reviewers can pause the video and read every line of code clearly — even on smaller screens.",
		},
		{
			title: "Studio Mode for Architecture Walkthroughs",
			description:
				"For longer code reviews — RFC feedback, architecture diagrams, or onboarding walkthroughs — <a href='/screen-recording-software'>Studio Mode</a> records screen and webcam as separate tracks with no time limits. Edit your recording before sharing if you want to trim the intro or add chapter markers.",
		},
		{
			title: "AI-Generated Captions for Accessibility",
			description:
				"Cap auto-generates captions for every recording using AI transcription. Team members who prefer to read, are in a noisy environment, or speak English as a second language can follow along without audio. Captions are searchable so reviewers can jump to the part they need.",
		},
		{
			title: "Password Protection and Expiry Links",
			description:
				"For sensitive code reviews involving proprietary algorithms, security patches, or unreleased features, add a password to your recording or set an expiry date. Only intended recipients can access the video.",
		},
		{
			title: "Works With GitHub, GitLab, Linear, and Jira",
			description:
				"Cap links are just URLs — paste them anywhere your team already works. Drop a Cap link in your GitHub PR description, GitLab MR comment, Linear issue, or Jira ticket. No integration setup, no webhooks, no OAuth.",
		},
	],

	recordingModes: {
		title: "Two Recording Modes for Every Code Review",
		description:
			"Choose the right recording workflow for the type of feedback you're giving",
		modes: [
			{
				icon: (
					<Code
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Instant Mode",
				description:
					"Perfect for quick PR reviews, bug reports, and daily code feedback. Record, stop, and share a link within seconds. Ideal when you want to give fast, focused feedback on a specific diff without spending more than a few minutes.",
			},
			{
				icon: (
					<MessageSquare
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Studio Mode",
				description:
					"Built for thorough architecture reviews, RFC walkthroughs, and technical onboarding sessions. No time limits — record as long as your review requires. Separate screen and webcam tracks give you more control over the final recording.",
			},
		],
	},

	comparisonTable: {
		title: "Cap vs Other Code Review Tools",
		headers: ["Feature", "Cap", "Loom", "GitHub PR Comments", "Zoom Recording"],
		rows: [
			[
				"Async video code reviews",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"Timestamped comments",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "No", status: "negative" },
			],
			[
				"4K resolution",
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "N/A", status: "neutral" },
				{ text: "No", status: "negative" },
			],
			[
				"Free unlimited recording",
				{ text: "Yes — Studio Mode", status: "positive" },
				{ text: "Limited", status: "warning" },
				{ text: "Free", status: "positive" },
				{ text: "Paid required", status: "warning" },
			],
			[
				"Instant share link",
				{ text: "Yes", status: "positive" },
				{ text: "Yes", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Delayed", status: "warning" },
			],
			[
				"AI captions",
				{ text: "Yes", status: "positive" },
				{ text: "Paid only", status: "warning" },
				{ text: "No", status: "negative" },
				{ text: "Paid only", status: "warning" },
			],
			[
				"Open source",
				{ text: "Yes — MIT", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "Open source (GitHub)", status: "positive" },
				{ text: "No", status: "negative" },
			],
			[
				"Self-hosted storage",
				{ text: "Yes — S3", status: "positive" },
				{ text: "No", status: "negative" },
				{ text: "N/A", status: "neutral" },
				{ text: "No", status: "negative" },
			],
		],
	},

	comparisonTitle: "Why Engineering Teams Choose Cap for Code Reviews",
	comparisonDescription:
		"Async video code reviews cut context-switching and make feedback more precise — here's how Cap compares",

	comparison: [
		{
			title: "Cap vs Loom for Code Reviews",
			description:
				"Loom is a capable async video tool but limits recording length and quality on its free plan, and stores all video on Loom's servers with no self-hosting option. Cap records at 4K with no recording-length limits in Studio Mode and supports <a href='/self-hosted-screen-recording'>self-hosted S3 storage</a> for teams with data residency requirements. Cap is also MIT-licensed and fully open source.",
		},
		{
			title: "Cap vs Written PR Comments",
			description:
				"Written PR comments are slow to compose and easy to misread. A 2-minute Cap recording replaces a wall of inline comments — reviewers see the exact context you're referring to, hear your tone, and understand intent without the ambiguity of text. Video feedback also reduces the back-and-forth clarification round trips that slow code review cycles.",
		},
		{
			title: "Cap vs Zoom or Google Meet for Code Reviews",
			description:
				"Synchronous video calls require scheduling across time zones, force reviewers to be present at a specific time, and produce recordings that aren't easily linked, timestamped, or commented on. Cap gives you the clarity of a face-to-face walkthrough with the flexibility of async — reviewers watch when it suits them and leave timestamped comments.",
		},
		{
			title: "Cap for Distributed Engineering Teams",
			description:
				"Teams spread across multiple time zones struggle to schedule live code reviews. Cap lets the author record a walkthrough asynchronously and share a link in the PR. Reviewers in any time zone watch the video at their own pace, leave timestamped comments, and the cycle continues without anyone waiting on a meeting invite. <a href='/solutions/remote-team-collaboration'>See how distributed teams use Cap</a>.",
		},
	],

	useCasesTitle: "How Engineering Teams Use Async Video Code Reviews",
	useCasesDescription:
		"From quick PR walkthroughs to deep architecture reviews, Cap fits into every stage of the engineering feedback cycle",

	useCases: [
		{
			title: "Pull Request Walkthroughs",
			description:
				"Record a 2-minute walkthrough of your PR before requesting review. Explain the approach, highlight the tricky parts, and flag anything the diff doesn't make obvious. Reviewers arrive informed and spend their review time on decisions, not re-reading context.",
		},
		{
			title: "Reviewer Feedback on Complex Diffs",
			description:
				"Instead of writing inline comments for every concern in a large PR, record a video walkthrough of your feedback. Point your cursor at the specific lines, explain the issue verbally, and suggest alternatives in context. Authors watch the recording and address feedback in bulk.",
		},
		{
			title: "Architecture and RFC Reviews",
			description:
				"Walk through architecture diagrams, ADRs, and RFC documents on screen while explaining your thinking. Stakeholders and tech leads can watch at their own pace, pause to think, and leave timestamped questions. No meeting required to gather input on design decisions.",
		},
		{
			title: "Security and Compliance Review Walkthroughs",
			description:
				"Security engineers can record walkthroughs of vulnerability findings, showing exactly which code paths are affected and why. Developers watch the video and understand the full context of a finding without a call. Password-protected recordings keep sensitive findings private.",
		},
		{
			title: "Junior Developer Mentoring and Code Feedback",
			description:
				"Senior engineers record detailed code review videos that junior developers can watch multiple times, pause at any point, and reference later. Written feedback is easy to skip; video feedback with cursor movement and explanation sticks. <a href='/solutions/employee-onboarding-platform'>See how Cap supports developer onboarding</a>.",
		},
		{
			title: "Cross-Team API and Integration Reviews",
			description:
				"When backend teams review frontend API usage or platform teams review integration patterns, async video bridges the gap between domain contexts. Record a walkthrough of the integration code, explain the expected contract, and share with the other team without interrupting their sprint.",
		},
	],

	migrationGuide: {
		title: "How to Start Doing Async Video Code Reviews with Cap",
		steps: [
			"Download Cap for Mac or Windows — setup takes under 2 minutes",
			"Open your IDE or GitHub/GitLab in your browser and pull up the diff you want to review",
			"Click the Cap icon in your menu bar and choose Instant Mode for quick reviews or Studio Mode for longer walkthroughs",
			"Start recording — Cap captures your screen and webcam simultaneously",
			"Talk through your feedback naturally as you scroll through the code",
			"Stop recording to get an instant shareable link",
			"Paste the Cap link into your PR comment, Slack message, or Linear ticket",
			"Reviewers click the link, watch the video in their browser, and leave timestamped comments",
		],
	},

	faqsTitle: "Frequently Asked Questions About Async Video Code Reviews",
	faqs: [
		{
			question: "What is an async video code review?",
			answer:
				"An async video code review is a screen recording walkthrough of a pull request, diff, or codebase where the reviewer (or PR author) explains their feedback on video instead of — or alongside — written comments. The recording is shared as a link that the recipient can watch on their own schedule without needing a live meeting.",
		},
		{
			question: "Why use video instead of written comments for code reviews?",
			answer:
				"Video code reviews communicate context, intent, and nuance that text comments often miss. Showing exactly which lines you're referring to while explaining your reasoning verbally reduces ambiguity and misinterpretation. A 2-minute video can replace 10+ inline comments and eliminates the back-and-forth that comes from unclear text feedback.",
		},
		{
			question: "How does Cap make code reviews faster?",
			answer:
				"Cap generates a shareable link the moment you stop recording — no upload wait, no file attachment, no third-party viewer required. Paste the link into your PR and reviewers can watch immediately. Timestamped comments let reviewers leave feedback at specific points in the video, keeping discussion organized without cluttering the PR comment thread.",
		},
		{
			question:
				"Does Cap work with GitHub, GitLab, Linear, and other developer tools?",
			answer:
				"Yes. Cap produces a standard URL that you can paste anywhere. Drop the link in a GitHub PR description or comment, a GitLab MR, a Linear issue, a Jira ticket, or a Slack message. No integration or webhook setup required — the link opens in any browser and the video plays without requiring the viewer to install Cap.",
		},
		{
			question: "Can I record code in 4K so reviewers can read it clearly?",
			answer:
				"Yes. Cap records at up to 4K resolution at 60fps, which means syntax highlighting, font rendering, and fine UI details are captured at full fidelity. Reviewers can pause the video and read any line of code clearly, even on high-DPI displays.",
		},
		{
			question: "How long can a Cap code review recording be?",
			answer:
				"In Instant Mode, recordings are optimized for quick async sharing. In Studio Mode, there is no recording time limit — you can record an entire architecture walkthrough, RFC review, or extended pair programming session without interruption. Studio Mode is completely free for personal use.",
		},
		{
			question:
				"Can I keep code review recordings private or password-protected?",
			answer:
				"Yes. Cap supports password protection on individual recordings and expiry dates on share links. For teams with stricter data requirements, Cap supports self-hosted S3 storage so recording files stay within your own infrastructure and never touch Cap's servers.",
		},
		{
			question: "What is the best tool for async video code reviews?",
			answer:
				"Cap is the best tool for async video code reviews for engineering teams that want 4K quality, instant shareable links, timestamped commenting, and the option to self-host recordings. It's free, open-source under the MIT license, and available for Mac and Windows. Unlike general async video tools, Cap's instant-mode and studio-mode workflows are optimized for the review cycle engineers actually use.",
		},
	],

	video: {
		url: "/videos/cap-demo.mp4",
		thumbnail: "/videos/cap-demo-thumbnail.png",
		alt: "Cap async video code review demo showing screen recording of a pull request walkthrough with timestamped comments",
	},

	cta: {
		title: "Start Doing Code Reviews with Async Video",
		buttonText: "Download Cap Free",
		secondaryButtonText: "View Pricing",
	},
};

export const AsyncVideoCodeReviewsPage = () => {
	return <SeoPageTemplate content={asyncVideoCodeReviewsContent} />;
};
