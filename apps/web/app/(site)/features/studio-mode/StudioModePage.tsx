"use client";

import { Clapperboard, Zap } from "lucide-react";
import { FeaturePage } from "@/components/features/FeaturePage";
import type { FeaturePageConfig } from "@/lib/features/types";

const studioModeConfig: FeaturePageConfig = {
	slug: "studio-mode",
	content: {
		hero: {
			title: "Studio Mode",
			subtitle: "Professional screen recording for creators",
			description:
				"Local recording with studio-quality output and precision editing tools. Perfect for content creators, educators, and professionals who need the highest quality recordings.",
			primaryCta: "Download Cap Free",
			secondaryCta: "Watch Demo",
			features: [
				"4K 60fps recording",
				"Local processing",
				"Professional editing tools",
			],
		},
		features: {
			title: "Studio-Quality Features for Professional Content",
			description:
				"Everything you need to create polished, professional recordings that engage your audience",
			items: [
				{
					title: "Ultra-High Quality Recording",
					description:
						"Record at up to 4K resolution and 60fps for crystal-clear videos that showcase every detail of your work.",
					icon: "video",
				},
				{
					title: "Local Processing & Privacy",
					description:
						"All recording and editing happens locally on your device. Your content never leaves your computer until you choose to share it.",
					icon: "shield",
				},
				{
					title: "Precision Timeline Editor",
					description:
						"Frame-perfect editing with a professional timeline interface. Cut, trim, and arrange your recordings with precision.",
					icon: "edit",
				},
				{
					title: "Multiple Camera Angles",
					description:
						"Record screen and webcam separately, then composite them in real-time or adjust layouts after recording in the editor.",
					icon: "camera",
				},
				{
					title: "Custom Backgrounds & Branding",
					description:
						"Add custom backgrounds and brand colors to create consistent, professional-looking content.",
					icon: "palette",
				},
				{
					title: "Advanced Audio Controls",
					description:
						"Control the audio levels of your microphone and system audio separately with individual level controls and noise reduction.",
					icon: "microphone",
				},
				{
					title: "Smart Auto-Zoom",
					description:
						"Automatically zoom in on important content areas during recording, or add zoom effects after recording in the editor.",
					icon: "zoom",
				},
				{
					title: "Export in Multiple Formats",
					description:
						"Create shareable links, export to MP4, or export to GIF. Choose the format that best matches your sharing needs.",
					icon: "download",
				},
			],
		},
		useCases: {
			title: "Perfect for Professional Content Creation",
			description:
				"Studio Mode empowers creators across industries to produce high-quality content",
			cases: [
				{
					title: "Software Tutorials & Demos",
					description:
						"Create comprehensive software tutorials with high-quality screen capture, clear audio, and professional presentation.",
					benefits: [
						"4K screen capture",
						"Multi-track audio",
						"Zoom effects",
						"Custom branding",
					],
				},
				{
					title: "Educational Content",
					description:
						"Develop engaging educational videos with multiple camera angles, custom backgrounds, and precise editing capabilities.",
					benefits: [
						"Picture-in-picture",
						"Background replacement",
						"Timeline editing",
						"Chapter markers",
					],
				},
				{
					title: "Product Demonstrations",
					description:
						"Showcase products with professional-quality recordings that highlight features and build trust with potential customers.",
					benefits: [
						"Professional polish",
						"Brand consistency",
						"High-quality output",
						"Custom layouts",
					],
				},
				{
					title: "Training & Onboarding",
					description:
						"Create comprehensive training materials that can be reused, updated, and distributed across your organization.",
					benefits: [
						"Reusable content",
						"Professional quality",
						"Easy updates",
						"Consistent branding",
					],
				},
				{
					title: "Content Creation",
					description:
						"Develop YouTube videos, online courses, and social media content with studio-quality production values.",
					benefits: [
						"Creator-focused tools",
						"High-quality output",
						"Professional editing",
						"Multiple formats",
					],
				},
				{
					title: "Documentation & Knowledge Sharing",
					description:
						"Build comprehensive video documentation that teams can reference and update as processes evolve.",
					benefits: [
						"Knowledge preservation",
						"Easy sharing",
						"Professional presentation",
						"Searchable content",
					],
				},
			],
		},
		comparison: {
			title: "Studio Mode vs Instant Mode",
			description: "Choose the right recording mode for your needs",
			modes: [
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
					isPrimary: true,
				},
				{
					name: "Instant Mode",
					description: "For quick sharing & collaboration",
					features: [
						"Instant shareable links",
						"Cloud processing",
						"Quick turnaround",
						"Automatic transcriptions",
						"Comment & feedback tools",
						"Team collaboration",
						"5-minute free recordings",
						"Browser-based viewing",
					],
					bestFor: "Quick updates, feedback, team communication",
					isPrimary: false,
				},
			],
		},
		workflow: {
			title: "Professional Workflow, Simplified",
			description:
				"From recording to final export, Studio Mode streamlines the entire content creation process",
			steps: [
				{
					title: "Set Up Your Recording",
					description:
						"Choose your recording area, camera position, and audio sources. Configure quality settings and branding elements.",
					icon: "settings",
				},
				{
					title: "Record with Confidence",
					description:
						"Everything records locally at the highest quality. No internet required, no file size limits, complete privacy.",
					icon: "record",
				},
				{
					title: "Edit with Precision",
					description:
						"Use the professional timeline editor to cut, trim, and enhance your recording. Add zoom effects and adjust layouts.",
					icon: "edit",
				},
				{
					title: "Export & Share",
					description:
						"Export in your preferred format and quality. Upload to your platform of choice or share locally with your team.",
					icon: "share",
				},
			],
		},
		faq: {
			title: "Frequently Asked Questions",
			items: [
				{
					question:
						"What's the difference between Studio Mode and Instant Mode?",
					answer:
						"Studio Mode records locally at the highest quality with professional editing tools, perfect for content creation. Instant Mode records to the cloud for immediate sharing, ideal for quick updates and collaboration.",
				},
				{
					question: "What quality can I record at in Studio Mode?",
					answer:
						"Studio Mode supports recording up to 4K resolution at 60fps, giving you the highest quality possible for professional content creation.",
				},
				{
					question: "Is there a recording length limit in Studio Mode?",
					answer:
						"No, Studio Mode has no recording length limits. Record for as long as you need - only limited by your device's storage space.",
				},
				{
					question: "Does Studio Mode require an internet connection?",
					answer:
						"No, Studio Mode works completely offline. All recording and editing happens locally on your device, so you can work anywhere without an internet connection.",
				},
				{
					question: "Can I use my own branding in Studio Mode?",
					answer:
						"Yes, Studio Mode includes comprehensive branding options. Add your logo, custom backgrounds, brand colors, and create consistent professional-looking content.",
				},
				{
					question: "What file formats can I export to?",
					answer:
						"Studio Mode supports creating shareable links, exporting to MP4, or exporting to GIF with quality settings to match your needs.",
				},
				{
					question: "Is Studio Mode available on both Mac and Windows?",
					answer:
						"Yes, Studio Mode is available as part of the Cap desktop application for both macOS (Intel and Apple Silicon) and Windows.",
				},
				{
					question: "How does pricing work for Studio Mode?",
					answer:
						"Studio Mode is completely free for personal usage. For commercial usage, you need the Desktop License, which is included with Cap Pro or can be purchased separately.",
				},
			],
		},
		video: {
			title: "See Studio Mode in Action",
			iframe: {
				src: "https://cap.so/embed/qk8gt56e1q1r735",
				title: "Studio Mode Demo - Cap Screen Recording",
			},
		},
		cta: {
			title: "Start Creating Professional Content Today",
			description:
				"Download Cap and experience the power of Studio Mode for yourself. Create stunning, professional-quality recordings that engage your audience.",
			primaryButton: "Download Cap Free",
			secondaryButton: "Upgrade to Cap Pro",
		},
	},
	customSections: {
		showVideo: true,
		showComparison: true,
		showWorkflow: true,
	},
};

const studioModeIcons = {
	"studio-mode": (
		<Clapperboard
			fill="var(--blue-9)"
			className="mb-4 size-8"
			strokeWidth={1.5}
		/>
	),
	"instant-mode": (
		<Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />
	),
};

export const StudioModePage = () => {
	return (
		<FeaturePage
			config={studioModeConfig}
			customIcons={studioModeIcons}
			showVideo={true}
		/>
	);
};
