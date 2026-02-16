"use client";

import { Button } from "@cap/ui";
import {
	faBolt,
	faCamera,
	faChartLine,
	faCheckCircle,
	faClock,
	faCloud,
	faCode,
	faCog,
	faComments,
	faDesktop,
	faDownload,
	faEdit,
	faExpand,
	faGlobe,
	faInfinity,
	faKeyboard,
	faLock,
	faMagic,
	faMobileAlt,
	faPalette,
	faRocket,
	faServer,
	faShareNodes,
	faShieldAlt,
	faUsers,
	faVideo,
	faVolumeUp,
	faWandMagicSparkles,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";

interface Feature {
	icon: any;
	title: string;
	description: string;
	category: "recording" | "ai" | "sharing" | "editing" | "platform" | "privacy";
	isPro?: boolean;
	isComingSoon?: boolean;
	size?: "small" | "medium" | "large";
}

const features: Feature[] = [
	{
		icon: faVideo,
		title: "Instant & Studio Modes",
		description:
			"Choose between quick shareable recordings or professional local editing with Studio Mode",
		category: "recording",
		size: "medium",
	},
	{
		icon: faRocket,
		title: "4K 60fps Recording",
		description:
			"Crystal-clear recordings at up to 4K resolution and 60 frames per second",
		category: "recording",
	},
	{
		icon: faCamera,
		title: "Composite Recording",
		description:
			"Camera and screen recorded separately and rendered as one video in real-time",
		category: "recording",
	},
	{
		icon: faDesktop,
		title: "Multiple Layouts",
		description:
			"Choose from various recording layouts to best showcase your content",
		category: "recording",
	},
	{
		icon: faPalette,
		title: "Custom Branding",
		description:
			"Add your logo, colors, and custom backgrounds to match your brand",
		category: "recording",
	},
	{
		icon: faBolt,
		title: "Blazing Fast Native App",
		description:
			"Lightning-fast performance with native macOS and Windows applications",
		category: "platform",
	},
	{
		icon: faKeyboard,
		title: "Keyboard Shortcuts",
		description:
			"Efficient workflow with customizable keyboard shortcuts for all actions",
		category: "recording",
	},
	{
		icon: faExpand,
		title: "Smart Auto-Zoom",
		description: "Automatically zoom in on important content during recordings",
		category: "recording",
	},
	{
		icon: faCog,
		title: "Advanced Cursor Settings",
		description:
			"Customize cursor size, style, animations, and motion blur effects",
		category: "recording",
	},
	{
		icon: faPalette,
		title: "Background Customization",
		description:
			"Choose from colors, gradients, images, or blur effects for your background",
		category: "editing",
	},

	{
		icon: faWandMagicSparkles,
		title: "AI-Generated Titles",
		description: "Automatically generate engaging titles for your recordings",
		category: "ai",
		isPro: true,
	},
	{
		icon: faMagic,
		title: "Smart Summaries",
		description: "Get AI-powered summaries of your recording content instantly",
		category: "ai",
		isPro: true,
		size: "medium",
	},
	{
		icon: faCheckCircle,
		title: "Clickable Chapters",
		description:
			"Auto-generated chapter markers for easy navigation through long recordings",
		category: "ai",
		isPro: true,
	},
	{
		icon: faComments,
		title: "Automatic Transcriptions",
		description: "Accurate transcriptions generated for every recording",
		category: "ai",
		isPro: true,
		size: "medium",
	},
	{
		icon: faEdit,
		title: "Auto-Edit",
		description:
			"AI-powered automatic editing to remove silences and improve pacing",
		category: "ai",
		isComingSoon: true,
	},
	{
		icon: faVolumeUp,
		title: "Noise Reduction",
		description: "Advanced AI noise reduction for crystal-clear audio",
		category: "ai",
		isComingSoon: true,
	},

	{
		icon: faCloud,
		title: "Unlimited Cloud Storage",
		description:
			"Store all your recordings in the cloud with no storage limits",
		category: "sharing",
		isPro: true,
		size: "medium",
	},
	{
		icon: faShareNodes,
		title: "Instant Shareable Links",
		description:
			"Share recordings instantly with a simple link - no downloads required",
		category: "sharing",
	},
	{
		icon: faLock,
		title: "Password Protection",
		description: "Secure your sensitive recordings with password protection",
		category: "sharing",
		isPro: true,
	},
	{
		icon: faChartLine,
		title: "Viewer Analytics",
		description: "Track views, engagement, and watch time for your recordings",
		category: "sharing",
		isPro: true,
	},
	{
		icon: faUsers,
		title: "Team Workspaces",
		description: "Collaborate with your team in organized workspaces",
		category: "sharing",
		isPro: true,
	},
	{
		icon: faComments,
		title: "Thread Comments",
		description: "Contextual discussions with timestamp-linked comments",
		category: "sharing",
	},
	{
		icon: faGlobe,
		title: "Custom Domain",
		description: "Share recordings from your own domain (cap.yourdomain.com)",
		category: "sharing",
		isPro: true,
	},
	{
		icon: faCode,
		title: "Embed Support",
		description: "Embed recordings anywhere with customizable players",
		category: "sharing",
	},

	{
		icon: faServer,
		title: "Custom S3 Bucket",
		description: "Use your own S3 storage for complete data ownership",
		category: "privacy",
		isPro: true,
	},
	{
		icon: faShieldAlt,
		title: "Local Recording",
		description:
			"Record and store everything locally with Cap Studio Mode - your data never leaves your device",
		category: "privacy",
		size: "medium",
	},
	{
		icon: faCode,
		title: "100% Open Source",
		description:
			"Fully transparent, auditable code you can trust and contribute to",
		category: "privacy",
		size: "medium",
	},
	{
		icon: faServer,
		title: "Self-Hosting",
		description: "Deploy Cap on your own infrastructure for ultimate control",
		category: "privacy",
	},

	{
		icon: faDownload,
		title: "Loom Video Importer",
		description:
			"Switching from Loom? Import your existing Loom recordings directly into Cap and keep all your content in one place",
		category: "platform",
		size: "medium",
	},
	{
		icon: faMobileAlt,
		title: "Cross-Platform",
		description: "Native apps for macOS (Apple Silicon & Intel) and Windows",
		category: "platform",
		size: "medium",
	},

	{
		icon: faClock,
		title: "Timeline Editor",
		description: "Professional timeline editing with frame-perfect precision",
		category: "editing",
		size: "medium",
	},
	{
		icon: faEdit,
		title: "Split & Trim",
		description: "Cut, split, and trim your recordings with ease",
		category: "editing",
	},
	{
		icon: faDownload,
		title: "Export Any Format",
		description: "Export to MP4, WebM, MOV, GIF and more formats",
		category: "editing",
	},
	{
		icon: faClock,
		title: "Speed Control",
		description: "Adjust playback speed from 0.25x to 3x",
		category: "editing",
	},
	{
		icon: faInfinity,
		title: "No Watermarks",
		description: "Your recordings are yours - no Cap watermarks ever",
		category: "editing",
	},

	{
		icon: faChartLine,
		title: "Performance Insights",
		description: "Detailed analytics on recording performance and system usage",
		category: "platform",
		isComingSoon: true,
	},
	{
		icon: faServer,
		title: "Webhooks & API",
		description:
			"Integrate Cap into your workflow with webhooks and API access",
		category: "platform",
		isPro: true,
		isComingSoon: true,
		size: "medium",
	},
	{
		icon: faWandMagicSparkles,
		title: "AI Video Search",
		description: "Search through your recordings using natural language",
		category: "ai",
		isPro: true,
		isComingSoon: true,
	},
];

const categoryColors = {
	recording: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	ai: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	sharing: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	editing: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	platform: "bg-gray-1 dark:bg-gray-2 border-gray-3",
	privacy: "bg-gray-1 dark:bg-gray-2 border-gray-3",
};

const categoryIcons = {
	recording: { icon: faVideo, color: "text-gray-11" },
	ai: { icon: faWandMagicSparkles, color: "text-gray-11" },
	sharing: { icon: faShareNodes, color: "text-gray-11" },
	editing: { icon: faEdit, color: "text-gray-11" },
	platform: { icon: faDesktop, color: "text-gray-11" },
	privacy: { icon: faShieldAlt, color: "text-gray-11" },
};

export const FeaturesPage = () => {
	return (
		<div className="min-h-screen">
			<div className="relative z-10 px-5 pt-32 pb-20 w-full">
				<div className="mx-auto text-center wrapper wrapper-sm">
					<h1 className="text-[2rem] font-medium leading-[2.5rem] md:text-[3.75rem] md:leading-[4rem] relative z-10 mb-4">
						The screen recorder for
						<br />
						<span className="text-gray-11">teams and creators</span>
					</h1>
					<p className="mx-auto mb-8 max-w-3xl text-md sm:text-xl text-gray-10">
						Whether you're a solo creator or a global agency, Cap scales with
						you. Record in 4K, collaborate seamlessly, maintain brand
						consistency, and ship content faster. All while keeping full control
						of your data.
					</p>

					<div className="flex flex-col justify-center items-center space-y-2 sm:flex-row sm:space-y-0 sm:space-x-2">
						<Button
							href="/download"
							variant="primary"
							size="lg"
							className="flex justify-center items-center w-full font-medium text-md sm:w-auto"
						>
							Download Cap Free
						</Button>
						<Button
							href="/pricing"
							variant="blue"
							size="lg"
							className="flex justify-center items-center w-full font-medium text-md sm:w-auto"
						>
							Upgrade to Cap Pro
						</Button>
					</div>
				</div>
			</div>

			<div className="pb-32 wrapper">
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-[minmax(200px,_auto)] grid-flow-dense">
					{features.map((feature, index) => {
						const sizeClasses = {
							small: "col-span-1",
							medium: "col-span-1 md:col-span-2",
							large: "col-span-1 md:col-span-2 lg:col-span-2",
						};

						return (
							<div
								key={index}
								className={`
                  ${sizeClasses[feature.size || "small"]}
                  group relative overflow-hidden rounded-xl border p-6
                  ${categoryColors[feature.category]}
                  hover:border-gray-5 transition-all duration-200
                  ${feature.isComingSoon ? "opacity-75" : ""}
                `}
							>
								<div
									className={`
                  w-12 h-12 rounded-lg flex items-center justify-center mb-4
                  bg-gray-2 dark:bg-gray-3
                  ${categoryIcons[feature.category].color}
                `}
								>
									<FontAwesomeIcon icon={feature.icon} className="w-6 h-6" />
								</div>

								<h3 className="mb-2 text-lg font-semibold text-gray-12">
									{feature.title}
									{feature.isPro && (
										<Link
											href="/pricing"
											className="inline-flex items-center px-2 py-1 ml-2 text-xs font-medium text-white bg-gradient-to-br from-blue-400 to-blue-600 rounded-full transition-all duration-200 hover:from-blue-500 hover:to-blue-700"
										>
											Cap Pro
										</Link>
									)}
									{feature.isComingSoon && (
										<span className="px-2 py-1 ml-2 text-xs font-medium rounded-full bg-gray-3 text-gray-10">
											SOON
										</span>
									)}
								</h3>
								<p className="text-sm leading-relaxed text-gray-11">
									{feature.description}
								</p>

								<div className="absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100">
									<FontAwesomeIcon
										icon={categoryIcons[feature.category].icon}
										className={`w-4 h-4 ${
											categoryIcons[feature.category].color
										} opacity-50`}
									/>
								</div>
							</div>
						);
					})}
				</div>
			</div>

			<div className="py-32 bg-gray-2 md:py-40">
				<div className="text-center wrapper">
					<h2 className="mb-4 text-3xl font-medium">Ready to get started?</h2>
					<p className="mx-auto mb-8 max-w-2xl text-lg text-gray-10">
						Join thousands of users who are already creating better recordings
						with Cap.
					</p>
					<div className="flex flex-col gap-4 justify-center sm:flex-row">
						<Button
							href="/download"
							variant="primary"
							size="lg"
							className="font-medium"
						>
							Download Cap Free
						</Button>
						<Button
							href="/pricing"
							variant="white"
							size="lg"
							className="font-medium"
						>
							Compare Plans
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
};
