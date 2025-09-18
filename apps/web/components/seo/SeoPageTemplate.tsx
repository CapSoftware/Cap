"use client";

import { Button } from "@cap/ui";
import {
	faCheck,
	faExclamation,
	faInfo,
	faMinus,
	faPlus,
	faTimes,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import MuxPlayer from "@mux/mux-player-react";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import { useState } from "react";
import { ComparisonSlider } from "@/components/seo/ComparisonSlider";
import type { ComparisonCell, SeoPageContent } from "@/components/seo/types";

const MotionButton = motion.create(Button);
const MotionImage = motion.create(Image);

const renderHTML = (content: string) => {
	const styledContent = content.replace(
		/<a\s/g,
		'<a class="font-semibold text-blue-500 transition-colors hover:text-blue-600" ',
	);

	return <span dangerouslySetInnerHTML={{ __html: styledContent }} />;
};

const renderComparisonCell = (cell: string | ComparisonCell) => {
	if (typeof cell === "string") {
		return renderHTML(cell);
	}

	const icons = {
		positive: (
			<div className="flex flex-shrink-0 justify-center items-center bg-blue-500 rounded-full size-5 min-w-5 min-h-5">
				<FontAwesomeIcon icon={faCheck} className="text-[11px] text-white" />
			</div>
		),
		negative: (
			<div className="flex flex-shrink-0 justify-center items-center bg-red-500 rounded-full size-5 min-w-5 min-h-5">
				<FontAwesomeIcon icon={faTimes} className="text-[11px] text-white" />
			</div>
		),
		warning: (
			<div className="flex flex-shrink-0 justify-center items-center bg-yellow-500 rounded-full size-5 min-w-5 min-h-5">
				<FontAwesomeIcon
					icon={faExclamation}
					className="text-[11px] text-white"
				/>
			</div>
		),
		neutral: (
			<div className="flex flex-shrink-0 justify-center items-center bg-gray-500 rounded-full size-5 min-w-5 min-h-5">
				<FontAwesomeIcon icon={faInfo} className="text-[11px] text-white" />
			</div>
		),
	};

	const icon = cell.status ? icons[cell.status] : null;

	return (
		<div className="flex gap-4 items-center md:gap-3">
			{icon && <span className="inline-flex items-center">{icon}</span>}
			<span>{cell.text}</span>
		</div>
	);
};

export const SeoPageTemplate = ({
	content,
	showLogosInHeader,
	showLoomComparisonSlider,
	showVideo = true,
	skipHero = false,
}: {
	content: SeoPageContent;
	showVideo?: boolean;
	showLogosInHeader?: boolean;
	showLoomComparisonSlider?: boolean;
	skipHero?: boolean;
}) => {
	const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

	const toggleFaq = (index: number) => {
		setOpenFaqIndex(openFaqIndex === index ? null : index);
	};

	return (
		<>
			{showLogosInHeader && (
				<>
					<MotionImage
						alt="Cap Logo"
						initial={{ opacity: 0, left: "-40vw" }}
						animate={{ opacity: 0.5, left: "-17vw" }}
						transition={{ duration: 1 }}
						width={500}
						height={500}
						className="absolute top-[200px] hidden md:flex md:size-[300px] lg:size-[400px] xl:size-[500px]"
						style={{
							WebkitMaskImage:
								"linear-gradient(to right, rgba(0,0,0,0) 50%, rgba(0,0,0,1) 120%, rgba(0,0,0,1) 100%)",
							maskImage:
								"linear-gradient(to right, rgba(0,0,0,0) 50%, rgba(0,0,0,1) 120%, rgba(0,0,0,1) 100%)",
							WebkitMaskRepeat: "no-repeat",
							maskRepeat: "no-repeat",
							WebkitMaskSize: "100% 100%",
							maskSize: "100% 100%",
						}}
						src="/logos/logo-solo.svg"
					/>

					<MotionImage
						alt="Loom Logo"
						initial={{ opacity: 0, right: "-40vw" }}
						animate={{ opacity: 0.5, right: "-17vw" }}
						transition={{ duration: 1 }}
						width={500}
						height={500}
						className="absolute hidden md:flex top-[200px] md:size-[300px] lg:size-[400px] xl:size-[500px]"
						style={{
							WebkitMaskImage:
								"linear-gradient(to left, rgba(0,0,0,0) 50%, rgba(0,0,0,1) 120%, rgba(0,0,0,1) 100%)",
							maskImage:
								"linear-gradient(to left, rgba(0,0,0,0) 50%, rgba(0,0,0,1) 120%, rgba(0,0,0,1) 100%)",
							WebkitMaskRepeat: "no-repeat",
							maskRepeat: "no-repeat",
							WebkitMaskSize: "100% 100%",
							maskSize: "100% 100%",
						}}
						src="/logos/loom.svg"
					/>
				</>
			)}

			{!skipHero && (
				<div className="relative mt-12">
					<div className="flex relative z-10 flex-col md:mt-[20vh] mt-[12vh] px-5 w-full h-full">
						<div className="mx-auto text-center wrapper wrapper-sm">
							{content.badge && (
								<motion.div
									initial={{ opacity: 0, y: 20 }}
									animate={{ opacity: 1, y: 0 }}
									transition={{ duration: 0.3, delay: 0.1 }}
									className="mb-4"
								>
									<span className="inline-flex items-center px-2 py-1 text-xs font-medium text-blue-700 bg-blue-100 rounded-full border border-blue-200">
										{content.badge}
									</span>
								</motion.div>
							)}
							<motion.h1
								initial={{ opacity: 0, y: 20 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.3, delay: content.badge ? 0.2 : 0 }}
								className="text-[2.25rem] leading-[2.75rem] md:text-[3.5rem] md:leading-[4rem] relative z-10 text-black mb-6"
							>
								{content.title}
							</motion.h1>
							<motion.p
								initial={{ opacity: 0, y: 20 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.3, delay: content.badge ? 0.3 : 0.2 }}
								className="mx-auto mb-10 max-w-3xl text-md sm:text-xl text-gray-10"
							>
								{content.description}
							</motion.p>
						</div>
						<motion.div
							initial={{ opacity: 0, y: 20 }}
							animate={{
								opacity: 1,
								y: 0,
								transition: {
									duration: 0.3,
									delay: 0.3,
								},
							}}
							className="flex flex-col justify-center items-center space-y-3 sm:flex-row sm:space-y-0 sm:space-x-4"
						>
							<MotionButton
								variant="blue"
								href="/download"
								size="lg"
								className="relative z-[20] w-full font-medium text-md sm:w-auto"
							>
								{content.cta.buttonText}
							</MotionButton>
							{content.cta.secondaryButtonText && (
								<MotionButton
									variant="white"
									href="/pricing"
									size="lg"
									className="relative z-[20] w-full font-medium text-md sm:w-auto"
								>
									{content.cta.secondaryButtonText}
								</MotionButton>
							)}
						</motion.div>
					</div>
				</div>
			)}

			{showLoomComparisonSlider && (
				<ComparisonSlider
					leftImage="/app/capdashboard.webp"
					rightImage="/app/loomdashboard.webp"
					leftAlt="Cap Dashboard"
					rightAlt="Loom Dashboard"
					leftLabel="Cap"
					rightLabel="Loom"
				/>
			)}

			<div className="relative z-10 space-y-[120px] md:space-y-[240px] mt-32 mb-[260px] wrapper">
				<div className="mb-28">
					<div className="text-center max-w-[800px] mx-auto mb-16">
						<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
							{content.featuresTitle}
						</h2>
						<p className="text-xl leading-relaxed text-gray-600">
							{renderHTML(content.featuresDescription)}
						</p>
					</div>
					<div className="grid grid-cols-1 w-full max-w-[1250px] mx-auto gap-8 px-4 md:grid-cols-3">
						{content.features.map((feature, index) => (
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
									{renderHTML(feature.description)}
								</p>
							</div>
						))}
					</div>
				</div>

				{showVideo && (
					<div>
						<div className="text-center max-w-[800px] mx-auto mb-10">
							<h2 className="inline-block relative mb-2 text-3xl font-medium text-gray-800 md:text-4xl">
								See Studio Mode in Action
							</h2>
							<p className="text-xl leading-relaxed text-gray-10">
								Watch how Cap makes screen recording simple, powerful, and
								accessible.
							</p>
						</div>
						<div className="mx-auto max-w-2xl">
							{content.video.iframe ? (
								<div
									className="overflow-hidden w-full rounded-xl shadow-md"
									style={{
										position: "relative",
										paddingBottom: "56.25%",
										height: 0,
									}}
								>
									<iframe
										src={content.video.iframe.src}
										title={content.video.iframe.title || "Cap Demo"}
										frameBorder="0"
										allowFullScreen
										style={{
											position: "absolute",
											top: 0,
											left: 0,
											width: "100%",
											height: "100%",
											borderRadius: "0.75rem",
										}}
									/>
								</div>
							) : (
								<div className="overflow-hidden rounded-xl shadow-md">
									<MuxPlayer
										playbackId="A6oZoUWVZjOIVZB6XnBMLagYnXE6xhDhp8Hcyky018hk"
										playerInitTime={0}
										metadataVideoTitle="Cap Demo"
										accentColor="#5C9FFF"
										style={{
											aspectRatio: "16/9",
											width: "100%",
										}}
									/>
								</div>
							)}
						</div>
					</div>
				)}

				{content.comparison && content.comparisonTitle && (
					<div>
						<div className="text-center max-w-[800px] mx-auto mb-8">
							<h2 className="inline-block relative mb-2 text-3xl font-medium text-gray-800 md:text-4xl">
								{content.comparisonTitle}
							</h2>
							{content.comparisonDescription && (
								<p className="text-xl leading-relaxed text-gray-10">
									{renderHTML(content.comparisonDescription)}
								</p>
							)}
						</div>
						<div className="grid grid-cols-1 gap-8 md:grid-cols-2">
							{content.comparison.map((item, index) => (
								<div
									key={index.toString()}
									className="p-8 rounded-2xl border shadow-sm transition-all duration-300 transform border-gray-4 bg-gray-1 hover:shadow-xl hover:-translate-y-1"
								>
									<div className="flex justify-center items-center mb-4 rounded-full bg-gray-4 size-8">
										{" "}
										<span className="text-sm font-medium text-gray-12">
											{index + 1}
										</span>
									</div>
									<h3 className="mb-4 text-xl font-semibold text-gray-800">
										{item.title}
									</h3>
									<p className="leading-relaxed text-gray-600">
										{renderHTML(item.description)}
									</p>
								</div>
							))}
						</div>
					</div>
				)}

				{content.recordingModes && (
					<div>
						<div className="text-center max-w-[800px] mx-auto mb-12">
							<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
								{content.recordingModes.title}
							</h2>
							<p className="text-lg leading-relaxed w-full max-w-[600px] mx-auto text-gray-10">
								{renderHTML(content.recordingModes.description)}
							</p>
						</div>
						<div className="grid grid-cols-1 gap-8 mx-auto max-w-4xl md:grid-cols-2">
							{content.recordingModes.modes.map((mode, index) => (
								<div
									key={index.toString()}
									className="p-8 rounded-2xl border shadow-sm transition-all duration-300 transform hover:shadow-xl bg-gray-1 hover:-translate-y-1"
								>
									{mode.icon}
									<h3 className="mb-4 text-xl font-semibold text-gray-12">
										{mode.title}
									</h3>
									<p className="leading-relaxed text-gray-600">
										{renderHTML(mode.description)}
									</p>
								</div>
							))}
						</div>
					</div>
				)}

				{content.comparisonTable && (
					<div>
						<div className="text-center max-w-[800px] mx-auto mb-12">
							<h2 className="inline-block relative text-3xl font-medium text-gray-12 md:text-4xl">
								{content.comparisonTable.title}
							</h2>
						</div>
						<div className="overflow-x-auto">
							<table className="overflow-hidden mx-auto w-full max-w-4xl rounded-2xl bg-gray-1">
								<thead className="bg-gray-4">
									<tr>
										{content.comparisonTable.headers.map((header, index) => (
											<th
												key={index.toString()}
												className="px-6 py-4 text-lg font-semibold text-left border-b border-gray-5 text-gray-12"
											>
												{header}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{content.comparisonTable.rows.map((row, rowIndex) => (
										<tr
											key={rowIndex.toString()}
											className={rowIndex % 2 === 0 ? "bg-gray-1" : "bg-gray-2"}
										>
											{row.map((cell, cellIndex) => (
												<td
													key={cellIndex.toString()}
													className={`px-6 py-4 text-[15px] text-gray-10 ${
														rowIndex ===
														content.comparisonTable!.rows.length - 1
															? ""
															: "border-b border-gray-5"
													}`}
												>
													{renderComparisonCell(cell)}
												</td>
											))}
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</div>
				)}

				<div>
					<div className="text-center max-w-[800px] mx-auto mb-12">
						<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
							{content.useCasesTitle}
						</h2>
						<p className="text-xl leading-relaxed text-gray-10">
							{renderHTML(content.useCasesDescription)}
						</p>
					</div>
					<div className="grid w-full max-w-[1000px] mx-auto grid-cols-1 gap-8 px-4 md:grid-cols-2">
						{content.useCases.map((useCase, index) => (
							<div
								key={index.toString()}
								className="p-8 rounded-2xl border shadow-sm transition-all duration-300 transform border-gray-4 bg-gray-1 hover:shadow-xl hover:-translate-y-1"
							>
								<div className="flex justify-center items-center mb-4 rounded-full bg-gray-4 size-8">
									{" "}
									<span className="text-sm font-medium text-gray-12">
										{index + 1}
									</span>
								</div>
								<h3 className="mb-4 text-xl font-semibold text-gray-800">
									{useCase.title}
								</h3>
								<p className="leading-relaxed text-gray-600">
									{renderHTML(useCase.description)}
								</p>
							</div>
						))}
					</div>
				</div>

				{content.migrationGuide && (
					<div>
						<div className="text-center max-w-[800px] mx-auto mb-8">
							<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
								{content.migrationGuide.title}
							</h2>
						</div>
						<div className="px-8 mx-auto max-w-3xl rounded-2xl shadow-sm bg-gray-1">
							<ol className="list-none">
								{content.migrationGuide.steps.map((step, index) => (
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

				<div>
					<div className="text-center max-w-[800px] mx-auto mb-8">
						<h2 className="inline-block relative mb-2 text-3xl font-medium md:text-4xl text-gray-12">
							{content.faqsTitle}
						</h2>
					</div>
					<div className="mx-auto mb-10 max-w-3xl">
						<div className="space-y-4">
							{content.faqs.map((faq, index) => (
								<div
									key={index.toString()}
									className={clsx(
										"rounded-xl overflow-hidden border border-gray-5",
										openFaqIndex === index
											? "bg-blue-500 text-white"
											: "bg-gray-1 hover:bg-gray-3 text-gray-12",
										"transition-colors duration-200",
									)}
								>
									<button
										type="button"
										className="flex justify-between items-center px-6 py-4 w-full text-left"
										onClick={() => toggleFaq(index)}
									>
										<p
											className={clsx(
												"text-lg font-medium",
												openFaqIndex === index ? "text-gray-1" : "text-gray-12",
											)}
										>
											{faq.question}
										</p>
										{openFaqIndex === index ? (
											<FontAwesomeIcon
												icon={faMinus}
												className="flex-shrink-0 w-5 h-5 text-gray-1"
											/>
										) : (
											<FontAwesomeIcon
												icon={faPlus}
												className="flex-shrink-0 w-5 h-5"
											/>
										)}
									</button>

									<AnimatePresence>
										{openFaqIndex === index && (
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
							))}
						</div>
					</div>
				</div>

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
								{content.cta.title}
							</h2>
							<p className="mb-6 text-xl text-gray-10">
								Ready to get started? Download now and see the difference.
							</p>
						</div>
						<div className="flex flex-col justify-center items-center space-y-3 sm:flex-row sm:space-y-0 sm:space-x-4">
							<Button
								variant="blue"
								href="/download"
								size="lg"
								className="px-8 py-3 w-full font-medium transition-all duration-300 sm:w-auto sm:max-w-fit"
							>
								{content.cta.buttonText}
							</Button>
							{content.cta.secondaryButtonText && (
								<Button
									variant="white"
									href="/pricing"
									size="lg"
									className="px-8 py-3 w-full font-medium transition-all duration-300 sm:w-auto sm:max-w-fit"
								>
									{content.cta.secondaryButtonText}
								</Button>
							)}
						</div>
					</div>
				</div>
			</div>
		</>
	);
};
