import { Clapperboard, Zap } from "lucide-react";
import Script from "next/script";
import { SeoPageTemplate } from "@/components/seo/SeoPageTemplate";
import type { SeoPageContent } from "@/components/seo/types";

export const remoteTeamCollaborationContent: SeoPageContent = {
	title:
		"Remote Team Collaboration Software: Asynchronous Screen Recording for Distributed Teams",
	description:
		"Enhance your remote team collaboration with Cap's secure, open-source screen recording platform. Save time, improve clarity, and boost productivity across time zones.",

	featuresTitle: "Why Cap is Perfect for Remote Team Collaboration",
	featuresDescription:
		"Cap provides everything distributed teams need for seamless async communication and collaboration",

	features: [
		{
			title: "Async Communication Across Time Zones",
			description:
				"Eliminate scheduling conflicts with instant sharable recordings that teammates can watch and respond to on their own schedule. Perfect for global teams working across different time zones.",
		},
		{
			title: "Secure & Private by Design",
			description:
				"Share sensitive information with confidence. Cap's open-source nature and custom S3 storage options ensure your team's communications remain private and secure at all times.",
		},
		{
			title: "Simple Onboarding for Remote Teams",
			description:
				"Get your entire team up and running in minutes with an intuitive interface that requires minimal training. New team members can start collaborating immediately.",
		},
		{
			title: "Built-in Feedback System",
			description:
				"Thread comments directly on recordings allow team members to provide contextual feedback without switching between tools, streamlining the collaboration process.",
		},
		{
			title: "Save 30+ Minutes Per Team Member Daily",
			description:
				"Replace lengthy meetings with concise visual explanations. Studies show teams save over 30 minutes per person daily by switching to asynchronous video communication.",
		},
		{
			title: "Cross-Platform for Every Team Member",
			description:
				"Works seamlessly on both Mac and Windows, ensuring your entire team can collaborate regardless of their operating system preferences.",
		},
	],

	recordingModes: {
		title: "Two Ways to Record with Cap",
		description:
			"Cap gives you flexible recording options to match your workflow needs, with both modes available in the free plan",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode",
				description:
					"Share your screen right away with a simple link—no waiting, just record and share in seconds. Record up to 5-minute shareable links for free, perfect for quick demos and explanations. Includes built-in thread commenting for easy collaboration.",
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
					"Available completely free for personal use! Records at top quality up to 4K. Captures both your screen and webcam separately so you can edit them later, giving you professional-level production control.",
			},
		],
	},
	useCasesTitle: "How Remote Teams Use Cap",
	useCasesDescription:
		"Real solutions for common remote collaboration challenges",

	useCases: [
		{
			title: "Daily Async Standups",
			description:
				"Team members record quick updates about their progress, blockers, and plans for the day. Everyone can watch these on their own schedule, eliminating the need to coordinate across time zones.",
		},
		{
			title: "Project Walkthroughs & Reviews",
			description:
				"Share detailed explanations of new features, designs, or code changes with visual context that text alone can't provide. Reviewers can leave timestamped comments exactly where they're relevant.",
		},
		{
			title: "Remote Onboarding & Training",
			description:
				"Create reusable screen recordings for common processes and tools, allowing new team members to learn at their own pace while reducing repetitive training sessions for managers.",
		},
		{
			title: "Bug Reporting & Troubleshooting",
			description:
				"Capture bugs in action with screen recordings that show exactly what's happening, eliminating confusion and speeding up resolution times for your development team.",
		},
	],

	faqsTitle: "Remote Team Collaboration FAQs",
	faqs: [
		{
			question: "How does Cap help remote teams collaborate more effectively?",
			answer:
				"Cap enables asynchronous visual communication that eliminates time zone constraints. Team members can record detailed screen captures with webcam overlay, share them instantly, and collect feedback through threaded comments—all without scheduling meetings. This typically saves teams 30+ minutes per person daily and improves information clarity.",
		},
		{
			question:
				"Can my entire remote team use Cap on different operating systems?",
			answer:
				"Yes, Cap works seamlessly across both Mac and Windows, ensuring your entire distributed team can collaborate regardless of their device preferences. The experience remains consistent across platforms with the same features available to everyone.",
		},
		{
			question:
				"How secure are the recordings for sensitive company information?",
			answer:
				"Cap prioritizes security and privacy with its open-source approach, allowing for complete transparency about how your data is handled. You can connect your own S3 storage and custom domain for complete data ownership, ensuring sensitive company information remains under your control.",
		},
		{
			question: "Does Cap integrate with other remote collaboration tools?",
			answer:
				"Cap provides easy-to-share links that work with all major communication platforms like Slack, Microsoft Teams, Notion, Trello, and more. Simply copy the link to your recording and paste it into your team's preferred tools for seamless workflow integration.",
		},
		{
			question: "Can I track who has viewed my team's recordings?",
			answer:
				"Yes, Cap's paid plans include view tracking and analytics, allowing team leads to see who has watched each recording and for how long. This helps ensure important information is reaching all team members and identifies content that may need follow-up.",
		},
	],

	comparisonTable: {
		title: "Cap vs. Traditional Remote Collaboration Methods",
		headers: ["Feature", "Cap", "Video Meetings", "Text-Based Communication"],
		rows: [
			[
				"Time Zone Flexibility",
				{ text: "Complete async freedom", status: "positive" },
				{ text: "Requires coordination", status: "negative" },
				{ text: "Async but limited context", status: "positive" },
			],
			[
				"Visual Context",
				{ text: "Full screen & webcam capture", status: "positive" },
				{ text: "Live video", status: "positive" },
				{ text: "Text only or static images", status: "negative" },
			],
			[
				"Reusability",
				{ text: "Persistent, rewatch anytime", status: "positive" },
				{ text: "Recordings often unwieldy", status: "warning" },
				{ text: "Searchable archives", status: "positive" },
			],
			[
				"Information Density",
				{ text: "High (visual + audio)", status: "positive" },
				{ text: "High but with overhead", status: "positive" },
				{ text: "Medium to low", status: "warning" },
			],
			[
				"Time Efficiency",
				{ text: "Watch at 2x speed, skip sections", status: "positive" },
				{ text: "Full real-time commitment", status: "negative" },
				{ text: "Quick to scan", status: "positive" },
			],
			[
				"Feedback System",
				{ text: "Built-in threaded comments", status: "positive" },
				{ text: "Live discussion", status: "positive" },
				{ text: "Separate threads", status: "warning" },
			],
			[
				"Privacy & Security",
				{ text: "Own your data with S3 integration", status: "positive" },
				{ text: "Varies by provider", status: "warning" },
				{ text: "Varies by provider", status: "warning" },
			],
		],
	},

	migrationGuide: {
		title: "How to Implement Cap for Your Remote Team",
		steps: [
			"Download Cap for all team members' operating systems (Mac and Windows)",
			"Set up shared S3 storage (optional) for complete data ownership",
			"Create a quick getting-started recording to onboard your team",
			"Establish guidelines for when to use Instant vs. Studio recording modes",
			"Integrate Cap links into your existing workflow tools (Slack, Teams, etc.)",
			"Start replacing some synchronous meetings with async recordings",
		],
	},

	video: {
		url: "/videos/remote-team-collaboration-demo.mp4",
		thumbnail: "/videos/remote-team-collaboration-thumbnail.png",
		alt: "Cap screen recorder demonstration for remote team collaboration",
	},

	cta: {
		title: "Ready to Transform Your Remote Team Communication?",
		buttonText: "Download Cap Free",
	},
};

// Create FAQ structured data for SEO
const createFaqStructuredData = () => {
	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: remoteTeamCollaborationContent.faqs.map((faq) => ({
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

export const RemoteTeamCollaborationPage = () => {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>
			<SeoPageTemplate content={remoteTeamCollaborationContent} />
		</>
	);
};
