import { Clapperboard, Zap } from "lucide-react";
import Script from "next/script";
import { SeoPageTemplate } from "@/components/seo/SeoPageTemplate";
import type { SeoPageContent } from "@/components/seo/types";

export const dailyStandupSoftwareContent: SeoPageContent = {
	title: "Daily Standup Software: Streamline Your Agile Meetings with Cap",
	description:
		"Looking for daily standup software? Discover how Cap helps remote or hybrid teams run async standups efficiently. No more timezone conflicts!",

	featuresTitle: "Why Cap is the Ideal Daily Standup Software",
	featuresDescription:
		"Cap provides everything Agile teams need for efficient, asynchronous daily standups",

	features: [
		{
			title: "Async Standup Recordings",
			description:
				"Eliminate timezone conflicts by letting team members record their updates when it's convenient. Watch standup videos on your own schedule, focusing only on what's relevant to you.",
		},
		{
			title: "Thread Commenting for Blockers",
			description:
				"Team members can discuss blockers or ask questions directly on specific moments in standup recordings, enabling asynchronous problem-solving without additional meetings.",
		},
		{
			title: "Security & Privacy",
			description:
				"Ensure sensitive project discussions remain confidential with Cap's open-source approach and custom S3 storage options for complete data ownership and NDA compliance.",
		},
		{
			title: "Time-Saving Daily Updates",
			description:
				"Teams save an average of 15-30 minutes daily by replacing synchronous standup meetings with concise, targeted video updates that can be watched at 1.5x or 2x speed.",
		},
		{
			title: "Permanent Standup Archive",
			description:
				"Create a searchable record of all daily standups that new team members can reference to quickly understand project history and ongoing work without disrupting the current team.",
		},
		{
			title: "Cross-Platform Accessibility",
			description:
				"Works seamlessly on both Mac and Windows, ensuring distributed teams can participate in daily standups regardless of their device preferences or location.",
		},
	],

	recordingModes: {
		title: "Two Recording Modes for Efficient Standups",
		description:
			"Cap adapts to your team's Agile workflow with flexible recording options",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode for Quick Daily Updates",
				description:
					"Perfect for the classic 'what I did yesterday, what I'm doing today, any blockers' format. Record and share in seconds with a simple link that team members can instantly access with built-in commenting for addressing blockers.",
			},
			{
				icon: (
					<Clapperboard
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Studio Mode for Sprint Reviews",
				description:
					"Ideal for more detailed sprint reviews or retrospectives. Create professional-quality standup videos with separate screen and webcam capture to demonstrate completed work or complex blockers that need visual context.",
			},
		],
	},

	useCasesTitle: "How Agile Teams Use Cap for Daily Standups",
	useCasesDescription: "Real solutions for common standup meeting challenges",

	useCases: [
		{
			title: "Globally Distributed Teams",
			description:
				"Team members across multiple time zones record their standups when convenient, eliminating the need to schedule calls at inconvenient hours while maintaining the personal touch of seeing and hearing colleagues.",
		},
		{
			title: "Hybrid Work Environments",
			description:
				"Remote and in-office team members enjoy the same standup experience, with recorded updates that can be watched by anyone regardless of their work location, creating an equitable experience for all.",
		},
		{
			title: "Cross-Functional Teams",
			description:
				"When multiple teams collaborate, members can focus on updates relevant to their work by watching only select recordings, rather than sitting through an entire synchronous standup with updates that don't affect them.",
		},
		{
			title: "Detailed Blocker Resolution",
			description:
				"Team members can demonstrate blockers visually by recording their screen, making it easier for others to understand the issue and provide solutions through timestamped comments.",
		},
	],

	faqsTitle: "Daily Standup Software FAQs",
	faqs: [
		{
			question: "Do async standups reduce team bonding?",
			answer:
				"Not at all! Video recordings maintain the personal element of standups by letting team members see and hear each other. Many teams find that async standups actually improve bonding by eliminating the frustration of inconvenient meeting times and focusing team synchronous time on more meaningful collaboration.",
		},
		{
			question: "How long should each standup recording be?",
			answer:
				"We recommend keeping recordings under 3 minutes per person, focusing on the classic standup format: what was accomplished, what's planned for today, and any blockers. Cap's Instant Mode is perfectly optimized for these quick updates, while Studio Mode offers more flexibility for complex situations.",
		},
		{
			question: "Can we integrate Cap with our project management tools?",
			answer:
				"Cap provides easy-to-share links that work seamlessly with all major project management and communication platforms including Jira, Trello, Slack, Microsoft Teams, and more. Simply copy the link to your standup recording and paste it into your team's preferred tools.",
		},
		{
			question: "What if someone misses recording their standup?",
			answer:
				"Cap's flexibility is perfect for occasional missed standups. Team members can record updates when they're available, and others can easily access the recording later. This is actually an advantage over traditional standups, where missing the meeting means missing the information completely.",
		},
		{
			question: "How do async standups help with meeting fatigue?",
			answer:
				"Async standups dramatically reduce meeting fatigue by eliminating one daily synchronous meeting from everyone's calendar. Team members can record and watch updates when it suits their focus time and energy levels, rather than being forced to context-switch for a scheduled meeting.",
		},
	],

	comparisonTable: {
		title: "Cap vs. Traditional Standup Methods",
		headers: ["Feature", "Cap", "Video Meetings", "Text-Based Standup Tools"],
		rows: [
			[
				"Time Zone Flexibility",
				{ text: "Complete async freedom", status: "positive" },
				{ text: "Requires coordination", status: "negative" },
				{ text: "Async but text-only", status: "positive" },
			],
			[
				"Visual Context",
				{ text: "Full screen & webcam capture", status: "positive" },
				{ text: "Live video", status: "positive" },
				{ text: "Text only with limited context", status: "negative" },
			],
			[
				"Meeting Fatigue",
				{ text: "Eliminated completely", status: "positive" },
				{ text: "Daily drain on focus", status: "negative" },
				{ text: "Reduced significantly", status: "positive" },
			],
			[
				"Information Retention",
				{ text: "Rewatchable, permanent record", status: "positive" },
				{ text: "Unless recorded (uncommon)", status: "warning" },
				{ text: "Searchable text history", status: "positive" },
			],
			[
				"Time Efficiency",
				{
					text: "Watch at 2x speed, skip irrelevant updates",
					status: "positive",
				},
				{ text: "Must attend entire meeting", status: "negative" },
				{ text: "Quick to scan but lacks detail", status: "positive" },
			],
			[
				"Blocker Resolution",
				{ text: "Visual demonstration + comments", status: "positive" },
				{ text: "Real-time discussion", status: "positive" },
				{ text: "Text description only", status: "warning" },
			],
			[
				"Privacy & Security",
				{ text: "Own your data with S3 integration", status: "positive" },
				{ text: "Varies by provider", status: "warning" },
				{ text: "Stored on vendor servers", status: "warning" },
			],
		],
	},

	migrationGuide: {
		title: "How to Implement Cap for Your Daily Standups",
		steps: [
			"Download Cap for all team members (available on Mac and Windows)",
			"Set up shared S3 storage (optional) for secure standup content",
			"Create standup guidelines (recommended length, format, etc.)",
			"Decide on a consistent time window for recording daily updates",
			"Share links to recordings in your team's communication channels",
			"Establish protocols for commenting and addressing blockers",
		],
	},

	video: {
		url: "/videos/daily-standup-demo.mp4",
		thumbnail: "/videos/daily-standup-thumbnail.png",
		alt: "Cap screen recorder demonstration for daily standup meetings",
	},

	cta: {
		title: "Ready to Transform Your Daily Standups?",
		buttonText: "Download Cap Free",
	},
};

const createFaqStructuredData = () => {
	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: dailyStandupSoftwareContent.faqs.map((faq) => ({
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

export const DailyStandupSoftwarePage = () => {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>
			<SeoPageTemplate content={dailyStandupSoftwareContent} />
		</>
	);
};
