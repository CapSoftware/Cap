"use client";

import { Clapperboard, Zap } from "lucide-react";
import { FeaturePage } from "@/components/features/FeaturePage";
import type { FeaturePageConfig } from "@/lib/features/types";

const instantModeConfig: FeaturePageConfig = {
	slug: "instant-mode",
	content: {
		hero: {
			title: "Instant Mode",
			subtitle: "Record, share, collaborate in seconds",
			description:
				"Cloud-powered screen recording for instant sharing and team collaboration. Perfect for quick updates, feedback sessions, and async communication that keeps teams moving fast.",
			primaryCta: "Download for Free",
			secondaryCta: "Upgrade to Cap Pro",
			features: [
				"Instant shareable links",
				"Upload during recording",
				"Real-time collaboration",
			],
		},
		features: {
			title: "Built for Speed and Collaboration",
			description:
				"Everything you need to record, share, and get feedback instantly",
			items: [
				{
					title: "Instant Shareable Links",
					description:
						"Share your recording immediately with a link. Your audience can watch instantly in any browser.",
					icon: "share",
				},
				{
					title: "Upload During Recording",
					description:
						"Your recording uploads in the background while you record, so there's no export time when you finish. Get your shareable link instantly.",
					icon: "upload",
				},
				{
					title: "Automatic Transcriptions",
					description:
						"Every recording gets accurate AI-generated transcriptions for accessibility, searchability, and easy reference.",
					icon: "transcript",
				},
				{
					title: "Collaborative Comments",
					description:
						"Get contextual feedback with timestamp-linked comments. Create threaded discussions around specific moments in your recording.",
					icon: "comments",
				},
				{
					title: "Team Workspaces",
					description:
						"Organize recordings by project, team, or client. Share access with team members and maintain organized collaboration spaces.",
					icon: "workspace",
				},
				{
					title: "Real-time Notifications",
					description:
						"Get notified instantly when someone views, comments, or interacts with your recordings. Stay in the loop without checking back.",
					icon: "bell",
				},
				{
					title: "Browser-Based Viewing",
					description:
						"No downloads required for viewers. Recordings play instantly in any modern browser with adaptive streaming for any connection.",
					icon: "browser",
				},
				{
					title: "Quick Recording Setup",
					description:
						"Start recording in one click. No complex settings or configuration - just click record and Cap handles the rest automatically.",
					icon: "record",
				},
			],
		},
		useCases: {
			title: "Perfect for Fast-Moving Teams",
			description:
				"Instant Mode powers quick communication and rapid feedback cycles",
			cases: [
				{
					title: "Bug Reports & Support",
					description:
						"Show instead of tell. Record the issue, share instantly, and get faster resolutions with visual context.",
					benefits: [
						"Visual bug documentation",
						"Instant sharing with support",
						"Collaborative troubleshooting",
						"Faster resolution times",
					],
				},
				{
					title: "Quick Updates & Standups",
					description:
						"Replace long meetings with quick video updates. Share progress, blockers, and next steps asynchronously.",
					benefits: [
						"Async communication",
						"Visual progress updates",
						"Time zone friendly",
						"Searchable history",
					],
				},
				{
					title: "Design & Product Feedback",
					description:
						"Get specific feedback on designs, prototypes, and product features with contextual comments and timestamps.",
					benefits: [
						"Timestamp comments",
						"Design collaboration",
						"Version tracking",
						"Stakeholder reviews",
					],
				},
				{
					title: "Client Communication",
					description:
						"Keep clients in the loop with quick progress videos and gather feedback without scheduling meetings.",
					benefits: [
						"Client transparency",
						"Visual progress reports",
						"Easy feedback collection",
						"Professional presentation",
					],
				},
				{
					title: "Knowledge Sharing",
					description:
						"Quickly document processes, share knowledge, and create searchable video libraries for your team.",
					benefits: [
						"Quick documentation",
						"Searchable content",
						"Team knowledge base",
						"Easy onboarding",
					],
				},
				{
					title: "Code Reviews & Demos",
					description:
						"Walk through code changes, demo features, and explain complex logic with screen recordings and live feedback.",
					benefits: [
						"Visual code walkthroughs",
						"Feature demonstrations",
						"Live feedback loops",
						"Async reviews",
					],
				},
			],
		},
		comparison: {
			title: "Instant Mode vs Studio Mode",
			description: "Choose the right recording mode for your workflow",
			modes: [
				{
					name: "Instant Mode",
					description: "For quick sharing & collaboration",
					features: [
						"Instant shareable links",
						"Upload during recording",
						"Quick turnaround",
						"Automatic transcriptions",
						"Comment & feedback tools",
						"Team collaboration",
						"5-minute free recordings*",
						"Browser-based viewing",
					],
					bestFor: "Quick updates, feedback, team communication",
					isPrimary: true,
				},
				{
					name: "Studio Mode",
					description: "For professional content creation",
					features: [
						"Local recording & processing",
						"4K 60fps quality",
						"Professional timeline editor",
						"Custom backgrounds & branding",
						"MP4, GIF, and link exports",
						"Advanced audio controls",
						"Unlimited recording length",
						"Complete privacy control",
					],
					bestFor: "Tutorials, courses, product demos, professional content",
					isPrimary: false,
				},
			],
		},
		workflow: {
			title: "From Recording to Feedback in Seconds",
			description:
				"Instant Mode is designed for speed - get from idea to feedback as fast as possible",
			steps: [
				{
					title: "One-Click Recording",
					description:
						"Open Cap, click record, and start capturing your screen instantly. No setup, no configuration required.",
					icon: "play",
				},
				{
					title: "Background Upload",
					description:
						"While you record, Cap uploads your video in the background. Transcriptions and sharing links are generated automatically.",
					icon: "upload",
				},
				{
					title: "Instant Sharing",
					description:
						"Get a shareable link immediately when recording stops. Copy, paste, and your team can watch instantly in any browser.",
					icon: "link",
				},
				{
					title: "Real-time Collaboration",
					description:
						"Receive comments, feedback, and notifications in real-time. Keep the conversation moving with timestamp-linked discussions.",
					icon: "comments",
				},
			],
		},
		faq: {
			title: "Frequently Asked Questions",
			items: [
				{
					question:
						"What's the difference between Instant Mode and Studio Mode?",
					answer:
						"Instant Mode is cloud-powered for quick sharing and collaboration, while Studio Mode records locally for professional editing. Choose Instant Mode for fast team communication and Studio Mode for polished content creation.",
				},
				{
					question: "How long can I record for free in Instant Mode?",
					answer:
						"Free accounts can record up to 5 minutes per recording in Instant Mode. Upgrade to Cap Pro for unlimited recording length, unlimited storage, and advanced collaboration features.",
				},
				{
					question: "Are my recordings secure in Instant Mode?",
					answer:
						"Yes, all recordings are encrypted in transit and at rest. You control who has access to your recordings, and you can delete them anytime. Cap Pro includes additional security features like password protection.",
				},
				{
					question: "Can viewers download my recordings?",
					answer:
						"By default, viewers can only watch recordings in the browser. Cap Pro allows you to control download permissions and add password protection for sensitive content.",
				},
				{
					question: "How fast are recordings processed?",
					answer:
						"Most recordings are processed and ready to share within seconds of stopping the recording. Processing time depends on recording length and current system load.",
				},
				{
					question: "Can I use Instant Mode offline?",
					answer:
						"Instant Mode requires an internet connection for cloud processing and sharing. For offline recording, use Studio Mode which works completely locally.",
				},
				{
					question: "What happens to my recordings if I upgrade to Cap Pro?",
					answer:
						"All existing recordings remain accessible, and you unlock unlimited recording length, advanced collaboration features, team workspaces, viewer analytics, and priority support.",
				},
				{
					question: "Can I edit recordings made in Instant Mode?",
					answer:
						"Basic editing like trimming is available for all recordings. Cap Pro includes advanced editing features and the ability to download recordings for external editing.",
				},
			],
		},
		video: {
			iframe: {
				src: "https://cap.so/embed/8cq21vmz12tm1zf",
				title: "See Instant Mode in Action - Cap Screen Recording",
			},
		},
		cta: {
			title: "Start Recording and Sharing Instantly",
			description:
				"Join thousands of teams using Cap Instant Mode for faster communication and better collaboration. Get started free, upgrade for unlimited features.",
			primaryButton: "Download for Free",
			secondaryButton: "Upgrade to Cap Pro",
		},
	},
	customSections: {
		showVideo: true,
		showComparison: true,
		showWorkflow: true,
	},
};

const instantModeIcons = {
	"instant-mode": (
		<Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />
	),
	"studio-mode": (
		<Clapperboard
			fill="var(--blue-9)"
			className="mb-4 size-8"
			strokeWidth={1.5}
		/>
	),
};

export const InstantModePage = () => {
	return (
		<FeaturePage
			config={instantModeConfig}
			customIcons={instantModeIcons}
			showVideo={true}
		/>
	);
};
