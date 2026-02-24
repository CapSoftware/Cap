"use client";

import { Button } from "@cap/ui";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import { Clapperboard, Minus, Plus, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useState } from "react";
import type { SeoPageContent } from "@/components/seo/types";

const PlatformSupportArt = memo(() => {
	const { RiveComponent: PlatformSupportRive } = useRive({
		src: "/rive/bento.riv",
		artboard: "storageoptions",
		animations: ["in"],
		autoplay: true,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});
	return <PlatformSupportRive className="w-[120px] h-[80px]" />;
});

const FAQItem = ({
	faq,
	index,
}: {
	faq: { question: string; answer: string };
	index: number;
}) => {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<div
			className={clsx(
				"overflow-hidden rounded-xl border border-gray-5",
				isOpen
					? "text-white bg-blue-500"
					: "bg-gray-1 hover:bg-gray-3 text-gray-12",
				"transition-colors duration-200",
			)}
		>
			<button
				type="button"
				className="flex justify-between items-center px-6 py-4 w-full text-left"
				onClick={() => setIsOpen(!isOpen)}
			>
				<p
					className={clsx(
						"text-lg font-medium",
						isOpen ? "text-gray-1" : "text-gray-12",
					)}
				>
					{faq.question}
				</p>
				{isOpen ? (
					<Minus className="flex-shrink-0 w-5 h-5 text-gray-1" />
				) : (
					<Plus className="flex-shrink-0 w-5 h-5" />
				)}
			</button>

			<AnimatePresence>
				{isOpen && (
					<motion.div
						initial={{ height: 0, opacity: 0 }}
						animate={{ height: "auto", opacity: 1 }}
						exit={{ height: 0, opacity: 0 }}
						transition={{ duration: 0.3 }}
						className="overflow-hidden"
					>
						<div className="px-6 pb-4">
							<p className="text-gray-3">{faq.answer}</p>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
};

const AnimatedDomainBanner = () => {
	const domains = [
		"cap.yourwebsite.com",
		"video.yourwebsite.com",
		"share.yourwebsite.com",
	];
	const [currentIndex, setCurrentIndex] = useState(0);

	useEffect(() => {
		const interval = setInterval(() => {
			setCurrentIndex((prev) => (prev + 1) % domains.length);
		}, 2500);
		return () => clearInterval(interval);
	}, []);

	return (
		<div className="mx-auto mb-12 max-w-2xl text-center">
			<div className="relative p-8 bg-white rounded-xl border border-gray-200 shadow-sm">
				<div className="flex flex-col items-center space-y-4">
					{/* Art */}
					<div className="flex-shrink-0">
						<PlatformSupportArt />
					</div>

					{/* Title */}
					<h3 className="text-xl font-semibold text-gray-900">
						Custom Domain Support
					</h3>

					{/* Description */}
					<p className="max-w-md text-sm text-gray-600">
						Send from your own domain for higher client trust and professional
						branding. Your share links reflect your agency's identity.
					</p>

					{/* Domain URL Animation */}
					<div className="relative h-6 min-w-[180px]">
						<AnimatePresence mode="wait">
							<motion.span
								key={currentIndex}
								initial={{ opacity: 0, y: 10 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -10 }}
								transition={{ duration: 0.4 }}
								className="absolute inset-0 font-mono text-sm font-semibold text-blue-600"
							>
								{domains[currentIndex]}
							</motion.span>
						</AnimatePresence>
					</div>
				</div>
			</div>
		</div>
	);
};

export const agenciesContent: SeoPageContent = {
	title: "Faster Client Updates with Instant Video Links",
	description:
		"Send clearer client updates in minutes. Share instant links with comments, or craft polished walkthroughs. Available for both macOS & Windows.",

	featuresTitle: "Why Agencies Choose Cap for Client Communication",
	featuresDescription:
		"Cap provides everything busy agencies need for efficient, visual client updates that actually get watched",

	features: [
		{
			title: "Instant Share Links",
			description:
				"Hit record, stop, and get a shareable link immediately. No uploads, no file transfers, no guessing where to send it. Drop the link in email, Slack, or your client portal and keep projects moving forward.",
		},
		{
			title: "Comments & Threaded Feedback",
			description:
				"Clients can leave time-stamped comments directly on your videos. Reply to specific moments, address feedback precisely, and keep all project communication in context instead of scattered across emails.",
		},
		{
			title: "Privacy-First for Client Work",
			description:
				"Use your own S3 storage and custom domain for complete data ownership. Password-protect sensitive client videos and maintain compliance with your agency's privacy requirements.",
		},
		{
			title: "Professional Studio Mode",
			description:
				"When you need client-ready presentations, Studio Mode records locally at the highest quality with precision editing tools. Add zoom segments, custom backgrounds, and professional polish.",
		},
		{
			title: "Cross-Platform Team Support",
			description:
				"Desktop apps for both macOS and Windows ensure your entire team can use the same workflow, regardless of their preferred platform or device.",
		},
		{
			title: "Analytics & Engagement Tracking",
			description:
				"See who watched your client updates, track engagement metrics, and know exactly when to follow up. Turn video communication into actionable insights.",
		},
	],

	recordingModes: {
		title: "Two Recording Modes for Agency Workflows",
		description:
			"Cap adapts to your client communication needs with flexible recording options",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode for Quick Client Updates",
				description:
					"Perfect for weekly progress updates, quick design reviews, and urgent bug reports. Record and share in seconds with a simple link that clients can access immediately, complete with automatic subtitles and commenting.",
			},
			{
				icon: (
					<Clapperboard
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Studio Mode for Client Presentations",
				description:
					"Ideal for project proposals, launch demos, and client onboarding. Create professional-quality presentations with separate screen and webcam capture, custom backgrounds, and precision editing tools.",
			},
		],
	},
	video: {
		url: "/videos/agencies-demo.mp4",
		thumbnail: "/videos/agencies-thumbnail.png",
		alt: "Cap screen recorder demonstration for agencies",
	},

	useCasesTitle: "How Agencies Use Cap for Client Success",
	useCasesDescription:
		"Real solutions for common agency communication challenges",

	useCases: [
		{
			title: "Weekly Progress Updates",
			description:
				"Replace status calls with 3-minute video walkthroughs showing actual progress. Clients can watch on their schedule and leave feedback through time-stamped comments, speeding up approval cycles.",
		},
		{
			title: "Design & Development Reviews",
			description:
				"Walk clients through design changes, new features, or website updates with visual context. Time-stamped feedback ensures nothing gets lost in translation between revisions.",
		},
		{
			title: "Bug Reports & QA Feedback",
			description:
				"Capture issues once and share instantly with both clients and development teams. Visual bug reports eliminate confusion and accelerate resolution times.",
		},
		{
			title: "Client Onboarding & Training",
			description:
				"Create reusable onboarding videos that new clients can watch anytime. Record platform walkthroughs, process explanations, and training materials that reduce support requests.",
		},
		{
			title: "Launch Handovers & Documentation",
			description:
				"Deliver comprehensive project handovers with visual documentation. Show clients how to use their new website, manage content, or access admin features with clear, rewatchable instructions.",
		},
		{
			title: "Proposal Presentations",
			description:
				"Create compelling project proposals with screen recordings that demonstrate your agency's approach, showcase past work, and explain complex strategies in an engaging, visual format.",
		},
	],

	faqsTitle: "Agencies FAQ",
	faqs: [
		{
			question: "Does Cap work on both macOS and Windows?",
			answer:
				"Yes. Cap supports both macOS and Windows with desktop apps, so your entire team can use the same workflow regardless of their platform preference.",
		},
		{
			question: "Can clients view videos without installing anything?",
			answer:
				"Yes. Clients can watch videos directly in their browser through a simple link. No downloads, no account creation, no friction. They can also leave comments directly on the video.",
		},
		{
			question: "What's the difference between Instant Mode and Studio Mode?",
			answer:
				"Instant Mode generates a shareable link immediately after recording—perfect for quick updates. Studio Mode records locally for the highest quality and includes precision editing tools for professional client presentations.",
		},
		{
			question: "How long can we record on the free version?",
			answer:
				"The free version supports recordings up to 5 minutes. For longer client presentations and unlimited recording time, upgrade to Cap Pro at $8.16/month (billed annually).",
		},
		{
			question: "Is Cap secure enough for confidential client work?",
			answer:
				"Yes. Cap is open-source and privacy-first. You can connect your own S3 storage, use a custom domain for share links, and password-protect sensitive videos. This gives you complete control over client data.",
		},
		{
			question: "Can we use our own branding with Cap?",
			answer:
				"Yes. Cap Pro includes custom domain support (cap.yourdomain.com) so share links reflect your agency's brand. You can also use your own S3 storage for complete data ownership.",
		},
		{
			question: "How does Cap pricing work for agency teams?",
			answer:
				"Cap Pro is $8.16/month per user (billed annually) and includes unlimited cloud storage, custom domains, team workspaces, and all collaboration features. Volume discounts are available for teams over 10 users.",
		},
	],

	comparisonTable: {
		title: "Cap vs. Traditional Agency Communication Methods",
		headers: ["Feature", "Cap", "Email + Screenshots", "Video Calls"],
		rows: [
			[
				"Client Engagement",
				{ text: "High - visual, timestamped feedback", status: "positive" },
				{ text: "Low - static images lack context", status: "negative" },
				{ text: "Medium - requires scheduling", status: "warning" },
			],
			[
				"Time Efficiency",
				{ text: "Record once, share instantly", status: "positive" },
				{ text: "Time-consuming to capture + explain", status: "negative" },
				{ text: "Meeting fatigue, scheduling overhead", status: "negative" },
			],
			[
				"Feedback Quality",
				{ text: "Precise, timestamped comments", status: "positive" },
				{ text: "Vague, hard to reference", status: "negative" },
				{ text: "Good but not recorded", status: "warning" },
			],
			[
				"Client Accessibility",
				{ text: "Watch anytime, no software needed", status: "positive" },
				{ text: "Static, no follow-up questions", status: "warning" },
				{ text: "Requires coordinated availability", status: "negative" },
			],
			[
				"Project Documentation",
				{ text: "Searchable video history", status: "positive" },
				{ text: "Scattered email threads", status: "negative" },
				{ text: "Unless recorded (uncommon)", status: "warning" },
			],
			[
				"Brand Control",
				{ text: "Custom domain + own storage", status: "positive" },
				{ text: "Generic email formatting", status: "warning" },
				{ text: "Third-party meeting platforms", status: "warning" },
			],
		],
	},

	migrationGuide: {
		title: "Getting Started with Cap for Your Agency",
		steps: [
			"Download Cap for all team members (available on Mac and Windows)",
			"Set up Cap Pro with custom domain for professional share links",
			"Connect your own S3 storage for complete data ownership (optional)",
			"Create agency guidelines for video updates (length, format, etc.)",
			"Train team on Instant vs Studio Mode for different use cases",
			"Integrate video links into your existing client communication workflows",
		],
	},

	cta: {
		title: "Ready to Transform Your Agency's Client Communication?",
		buttonText: "Upgrade to Cap Pro",
	},
};

export const AgenciesPage = () => {
	return (
		<>
			{/* Hero Section with Custom CTAs */}
			<div className="relative mt-12">
				<div className="flex relative z-10 flex-col md:mt-[20vh] mt-[12vh] px-5 w-full h-full">
					<div className="mx-auto text-center wrapper wrapper-sm">
						<motion.h1
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.3 }}
							className="text-[2.25rem] leading-[2.75rem] md:text-[3.5rem] md:leading-[4rem] relative z-10 text-black mb-6"
						>
							{agenciesContent.title}
						</motion.h1>
						<motion.p
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.3, delay: 0.2 }}
							className="mx-auto mb-10 max-w-3xl text-md sm:text-xl text-gray-10"
						>
							{agenciesContent.description}
						</motion.p>

						{/* Custom Domain Banner */}
						<motion.div
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.3, delay: 0.3 }}
						>
							<AnimatedDomainBanner />
						</motion.div>

						{/* CTA */}
						<motion.div
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.3, delay: 0.4 }}
							className="flex justify-center items-center"
						>
							<Button
								variant="blue"
								href="/pricing"
								size="lg"
								className="relative z-[20] w-full sm:w-auto font-medium text-md"
							>
								Upgrade to Cap Pro
							</Button>
						</motion.div>
					</div>
				</div>
			</div>

			<div className="relative z-10 mt-24 mb-24 space-y-24 md:space-y-32 wrapper">
				{/* Features Section */}
				<div>
					<div className="text-center max-w-[800px] mx-auto mb-16">
						<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
							{agenciesContent.featuresTitle}
						</h2>
						<p className="text-xl leading-relaxed text-gray-10">
							{agenciesContent.featuresDescription}
						</p>
					</div>
					<div className="grid grid-cols-1 w-full max-w-[1250px] mx-auto gap-8 px-4 md:grid-cols-3">
						{agenciesContent.features.map((feature, index) => (
							<div
								key={index.toString()}
								className="p-8 rounded-2xl border shadow-sm transition-all duration-300 transform border-gray-4 bg-gray-1 hover:shadow-xl hover:-translate-y-1"
							>
								<div className="flex justify-center items-center mb-4 rounded-full bg-gray-4 size-8">
									<span className="text-sm font-medium text-gray-12">
										{index + 1}
									</span>
								</div>
								<h3 className="mb-4 text-xl font-semibold text-gray-12">
									{feature.title}
								</h3>
								<p className="leading-relaxed text-gray-600">
									{feature.description}
								</p>
							</div>
						))}
					</div>
				</div>

				{/* Recording Modes Section */}
				{agenciesContent.recordingModes && (
					<div>
						<div className="text-center max-w-[800px] mx-auto mb-12">
							<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
								{agenciesContent.recordingModes.title}
							</h2>
							<p className="text-lg leading-relaxed w-full max-w-[600px] mx-auto text-gray-10">
								{agenciesContent.recordingModes.description}
							</p>
						</div>
						<div className="grid grid-cols-1 gap-8 mx-auto max-w-4xl md:grid-cols-2">
							{agenciesContent.recordingModes.modes.map((mode, index) => (
								<div
									key={index.toString()}
									className="p-8 rounded-2xl border shadow-sm transition-all duration-300 transform hover:shadow-xl bg-gray-1 hover:-translate-y-1"
								>
									{mode.icon}
									<h3 className="mb-4 text-xl font-semibold text-gray-12">
										{mode.title}
									</h3>
									<p className="leading-relaxed text-gray-600">
										{mode.description}
									</p>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Use Cases Section */}
				<div>
					<div className="text-center max-w-[800px] mx-auto mb-12">
						<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
							{agenciesContent.useCasesTitle}
						</h2>
						<p className="text-xl leading-relaxed text-gray-10">
							{agenciesContent.useCasesDescription}
						</p>
					</div>
					<div className="grid w-full max-w-[1000px] mx-auto grid-cols-1 gap-8 px-4 md:grid-cols-2">
						{agenciesContent.useCases.map((useCase, index) => (
							<div
								key={index.toString()}
								className="p-8 rounded-2xl border shadow-sm transition-all duration-300 transform border-gray-4 bg-gray-1 hover:shadow-xl hover:-translate-y-1"
							>
								<div className="flex justify-center items-center mb-4 rounded-full bg-gray-4 size-8">
									<span className="text-sm font-medium text-gray-12">
										{index + 1}
									</span>
								</div>
								<h3 className="mb-4 text-xl font-semibold text-gray-800">
									{useCase.title}
								</h3>
								<p className="leading-relaxed text-gray-600">
									{useCase.description}
								</p>
							</div>
						))}
					</div>
				</div>

				{/* Comparison Table Section */}
				{agenciesContent.comparisonTable && (
					<div>
						<div className="text-center max-w-[800px] mx-auto mb-12">
							<h2 className="inline-block relative text-3xl font-medium text-gray-12 md:text-4xl">
								{agenciesContent.comparisonTable.title}
							</h2>
						</div>
						<div className="overflow-x-auto">
							<table className="overflow-hidden mx-auto w-full max-w-4xl rounded-2xl bg-gray-1">
								<thead className="bg-gray-4">
									<tr>
										{agenciesContent.comparisonTable.headers.map(
											(header, index) => (
												<th
													key={index.toString()}
													className="px-6 py-4 text-lg font-semibold text-left border-b border-gray-5 text-gray-12"
												>
													{header}
												</th>
											),
										)}
									</tr>
								</thead>
								<tbody>
									{agenciesContent.comparisonTable.rows.map((row, rowIndex) => (
										<tr
											key={rowIndex.toString()}
											className={rowIndex % 2 === 0 ? "bg-gray-1" : "bg-gray-2"}
										>
											{row.map((cell, cellIndex) => (
												<td
													key={cellIndex.toString()}
													className={`px-6 py-4 text-[15px] text-gray-10 ${
														rowIndex ===
														(agenciesContent.comparisonTable?.rows.length ??
															0) -
															1
															? ""
															: "border-b border-gray-5"
													}`}
												>
													{typeof cell === "string" ? (
														cell
													) : (
														<div className="flex gap-4 items-center md:gap-3">
															{cell.status && (
																<span className="inline-flex items-center">
																	<div
																		className={`flex flex-shrink-0 justify-center items-center rounded-full size-5 min-w-5 min-h-5 ${
																			cell.status === "positive"
																				? "bg-blue-500"
																				: cell.status === "negative"
																					? "bg-red-500"
																					: cell.status === "warning"
																						? "bg-yellow-500"
																						: "bg-gray-500"
																		}`}
																	>
																		<span className="text-[11px] text-white">
																			{cell.status === "positive"
																				? "✓"
																				: cell.status === "negative"
																					? "✕"
																					: cell.status === "warning"
																						? "!"
																						: "i"}
																		</span>
																	</div>
																</span>
															)}
															<span>{cell.text}</span>
														</div>
													)}
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				)}

				{/* Migration Guide Section */}
				{agenciesContent.migrationGuide && (
					<div>
						<div className="text-center max-w-[800px] mx-auto mb-8">
							<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
								{agenciesContent.migrationGuide.title}
							</h2>
						</div>
						<div className="px-8 mx-auto max-w-3xl rounded-2xl shadow-sm bg-gray-1">
							<ol className="list-none">
								{agenciesContent.migrationGuide.steps.map((step, index) => (
									<li
										key={index.toString()}
										className="flex items-start py-6 [&:not(:last-child)]:border-b border-gray-4"
									>
										<div className="flex justify-center items-center mr-4 rounded-full bg-gray-4 size-8">
											{index + 1}
										</div>
										<p className="mt-1 text-gray-12">{step}</p>
									</li>
								))}
							</ol>
						</div>
					</div>
				)}

				{/* FAQ Section */}
				<div>
					<div className="text-center max-w-[800px] mx-auto mb-8">
						<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
							{agenciesContent.faqsTitle}
						</h2>
					</div>
					<div className="mx-auto mb-10 max-w-3xl">
						<div className="space-y-4">
							{agenciesContent.faqs.map((faq, index) => (
								<FAQItem key={index} faq={faq} index={index} />
							))}
						</div>
					</div>
				</div>

				{/* Final CTA Section */}
				<div
					className="max-w-[1000px] mx-auto rounded-3xl overflow-hidden relative flex flex-col justify-center border border-gray-5 p-12 bg-white"
					style={{
						minHeight: "300px",
						backgroundImage: "url('/illustrations/ctabg.svg')",
						backgroundSize: "cover",
						backgroundRepeat: "no-repeat",
					}}
				>
					<div className="flex relative z-10 flex-col justify-center items-center mx-auto h-full wrapper">
						<div className="text-center max-w-[800px] mx-auto mb-8">
							<h2 className="mb-4 text-3xl font-medium md:text-4xl text-gray-12">
								{agenciesContent.cta.title}
							</h2>
							<p className="mb-6 text-xl text-gray-10">
								Ready to get started? Upgrade now and unlock professional
								features.
							</p>
						</div>
						<div className="flex flex-col justify-center items-center space-y-3 sm:flex-row sm:space-y-0 sm:space-x-4">
							<Button
								variant="blue"
								href="/pricing"
								size="lg"
								className="px-8 py-3 w-full font-medium transition-all duration-300 sm:w-auto"
							>
								{agenciesContent.cta.buttonText}
							</Button>
						</div>
					</div>
				</div>
			</div>
		</>
	);
};
