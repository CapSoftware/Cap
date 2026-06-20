"use client";

import { Button } from "@cap/ui";
import {
	faCheck,
	faMinus,
	faPlus,
	faTimes,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import {
	ArrowLeftRight,
	Building2,
	FolderLock,
	Gauge,
	HardDriveUpload,
	Link2,
	MousePointerClick,
	ShieldCheck,
	Zap,
} from "lucide-react";
import Image from "next/image";
import { type JSX, useState } from "react";
import { GoogleDriveLogo } from "@/components/icons/GoogleDriveLogo";
import { googleDriveScreenRecorderFaqs } from "./google-drive-screen-recorder-faqs";

type ComparisonStatus = "positive" | "negative" | "warning" | "neutral";
type ComparisonCell = { text: string; status?: ComparisonStatus };

const features = [
	{
		icon: MousePointerClick,
		title: "Connect Google Drive in two clicks",
		description:
			"No access keys, endpoints, or buckets to configure. Sign in with Google once, approve access, and Cap is ready to store your recordings in your own Drive.",
	},
	{
		icon: HardDriveUpload,
		title: "Every shareable link lives in your Drive",
		description:
			"Once connected, new shareable links upload straight to a private Cap folder in your Google Drive. You own the underlying video files, in the account you already trust.",
	},
	{
		icon: Building2,
		title: "For one person or your whole organization",
		description:
			"Connect Drive to your personal account from the desktop app, or have an admin connect it once for the entire organization so every member's recordings land in the same place.",
	},
	{
		icon: Link2,
		title: "Your links keep working exactly the same",
		description:
			"Share links stay on Cap with comments, viewer analytics, chapters, and password protection intact. The recording is simply streamed from your Google Drive instead of Cap Cloud.",
	},
	{
		icon: ArrowLeftRight,
		title: "Switch storage whenever you want",
		description:
			"Keep Cap Cloud and your own S3 bucket alongside Drive, then choose the active provider with one toggle. Existing recordings keep the storage they were created with.",
	},
	{
		icon: ShieldCheck,
		title: "Cap only ever touches its own folder",
		description:
			"Cap uses Google's drive.file permission, so it can only see and manage the files it creates for you. The rest of your Google Drive stays completely private to Cap.",
	},
];

const flow = [
	{
		icon: <Zap className="size-6" strokeWidth={1.75} />,
		title: "1. Record in Cap",
		description:
			"Capture your screen in Instant Mode or Studio Mode on Mac or Windows, at up to 4K and 60fps, with system audio and webcam.",
	},
	{
		icon: <GoogleDriveLogo size={26} />,
		title: "2. Store in your Drive",
		description:
			"When you share, Cap uploads the recording to a private Cap folder in your connected Google Drive, individually or for your whole organization.",
	},
	{
		icon: <Link2 className="size-6" strokeWidth={1.75} />,
		title: "3. Share from your Drive",
		description:
			"Copy your Cap link. Viewers watch through Cap's player while the video is served straight from your own Google Drive after access checks.",
	},
];

const comparisonTable: {
	headers: string[];
	rows: (string | ComparisonCell)[][];
} = {
	headers: ["Feature", "Cap + Google Drive", "Loom", "Vidyard"],
	rows: [
		[
			"Store recordings in your own Google Drive",
			{ text: "Yes, native integration", status: "positive" },
			{ text: "Not available", status: "negative" },
			{ text: "Not available", status: "negative" },
		],
		[
			"You own the video files",
			{ text: "Yes, in your account", status: "positive" },
			{ text: "Stored on Loom", status: "negative" },
			{ text: "Stored on Vidyard", status: "negative" },
		],
		[
			"Connect with one Google sign-in",
			{ text: "Yes", status: "positive" },
			{ text: "Not applicable", status: "neutral" },
			{ text: "Not applicable", status: "neutral" },
		],
		[
			"Organization-wide storage",
			{ text: "Connect once for the team", status: "positive" },
			{ text: "Platform managed", status: "neutral" },
			{ text: "Platform managed", status: "neutral" },
		],
		[
			"Also supports your own S3 bucket",
			{ text: "Yes", status: "positive" },
			{ text: "No", status: "negative" },
			{ text: "No", status: "negative" },
		],
		[
			"Instant shareable links",
			{ text: "Yes", status: "positive" },
			{ text: "Yes", status: "positive" },
			{ text: "Yes", status: "positive" },
		],
		[
			"Open source",
			{ text: "Yes, MIT licensed", status: "positive" },
			{ text: "No", status: "negative" },
			{ text: "No", status: "negative" },
		],
		[
			"Pricing",
			{ text: "from $8.16/mo per user", status: "positive" },
			{ text: "$18/mo per user", status: "warning" },
			{ text: "Quote based", status: "warning" },
		],
	],
};

const steps = [
	{
		title: "Upgrade to Cap Pro",
		description:
			"Connecting your own Google Drive is a Cap Pro feature, available for individual creators and entire organizations.",
	},
	{
		title: "Open the storage integrations",
		description:
			"On desktop go to Settings, then Integrations, then Google Drive. For a whole team, an admin opens Dashboard, Settings, Organization, then Integrations.",
	},
	{
		title: "Connect Google Drive",
		description:
			"Click Connect Google Drive, sign in, and approve access. Cap creates a private Cap folder in your Drive for new uploads.",
	},
	{
		title: "Record and share",
		description:
			"Record in Instant or Studio Mode, then copy your share link. The recording uploads to your Drive and is served from there for every viewer.",
	},
];

const fadeUp = {
	hidden: { opacity: 0, y: 24 },
	visible: (custom: number) => ({
		opacity: 1,
		y: 0,
		transition: { delay: custom * 0.08, duration: 0.5, ease: "easeOut" },
	}),
};

const statusIcons: Record<ComparisonStatus, JSX.Element> = {
	positive: (
		<div className="flex flex-shrink-0 justify-center items-center bg-blue-500 rounded-full size-5">
			<FontAwesomeIcon icon={faCheck} className="text-[11px] text-white" />
		</div>
	),
	negative: (
		<div className="flex flex-shrink-0 justify-center items-center bg-red-500 rounded-full size-5">
			<FontAwesomeIcon icon={faTimes} className="text-[11px] text-white" />
		</div>
	),
	warning: (
		<div className="flex flex-shrink-0 justify-center items-center bg-yellow-500 rounded-full size-5">
			<FontAwesomeIcon icon={faMinus} className="text-[11px] text-white" />
		</div>
	),
	neutral: (
		<div className="flex flex-shrink-0 justify-center items-center bg-gray-500 rounded-full size-5">
			<FontAwesomeIcon icon={faMinus} className="text-[11px] text-white" />
		</div>
	),
};

const renderComparisonCell = (cell: string | ComparisonCell) => {
	if (typeof cell === "string") {
		return <span className="font-medium text-gray-12">{cell}</span>;
	}
	return (
		<div className="flex gap-3 items-center">
			{cell.status && statusIcons[cell.status]}
			<span>{cell.text}</span>
		</div>
	);
};

const ConnectionDemo = () => (
	<div className="overflow-hidden mx-auto w-full max-w-4xl rounded-2xl border shadow-xl border-gray-4 bg-gray-2">
		<div className="flex gap-3 items-center px-4 h-11 border-b border-gray-4 bg-gray-3">
			<div className="flex gap-1.5">
				<span className="rounded-full size-3 bg-gray-6" />
				<span className="rounded-full size-3 bg-gray-6" />
				<span className="rounded-full size-3 bg-gray-6" />
			</div>
			<div className="flex flex-1 justify-center items-center text-xs text-gray-10">
				<span className="font-medium text-gray-12">
					Settings → Integrations → Google Drive
				</span>
			</div>
			<div className="w-12" />
		</div>

		<div className="p-6 text-left sm:p-8 bg-gray-1">
			<div className="flex flex-col gap-4 justify-between p-5 rounded-xl border sm:flex-row sm:items-center bg-gray-2 border-gray-3">
				<div className="flex gap-4 items-center">
					<div className="flex flex-shrink-0 justify-center items-center rounded-xl border size-12 bg-gray-1 border-gray-4">
						<GoogleDriveLogo size={24} />
					</div>
					<div className="flex flex-col gap-0.5">
						<p className="text-sm font-medium text-gray-12">Google Drive</p>
						<p className="text-xs text-gray-10">Active for new uploads</p>
					</div>
				</div>
				<span className="inline-flex gap-2 items-center self-start px-3 py-1 text-xs font-medium text-blue-700 bg-blue-100 rounded-full border border-blue-200 sm:self-auto">
					<span className="rounded-full size-1.5 bg-blue-500" />
					Connected
				</span>
			</div>

			<div className="flex gap-3 items-center px-5 py-4 mt-4 rounded-xl border bg-gray-2 border-gray-3">
				<Gauge
					className="flex-shrink-0 size-4 text-gray-10"
					strokeWidth={1.75}
				/>
				<div className="flex-1">
					<div className="flex justify-between mb-1.5 text-xs text-gray-11">
						<span>Drive storage</span>
						<span>42.6 GB of 100 GB used</span>
					</div>
					<div className="overflow-hidden h-1.5 rounded-full bg-gray-4">
						<div className="h-full rounded-full bg-blue-500 w-[43%]" />
					</div>
				</div>
			</div>

			<div className="grid grid-cols-1 gap-3 mt-6 sm:grid-cols-3">
				{flow.map((item) => (
					<div
						key={item.title}
						className="flex flex-col gap-2 p-4 rounded-xl border bg-gray-1 border-gray-3"
					>
						<div className="flex justify-center items-center rounded-lg size-9 bg-gray-3 text-gray-12">
							{item.icon}
						</div>
						<p className="text-sm font-medium text-gray-12">{item.title}</p>
					</div>
				))}
			</div>
		</div>
	</div>
);

export const GoogleDriveScreenRecorderPage = () => {
	const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

	return (
		<>
			<div className="overflow-hidden relative px-5 pt-[140px] md:pt-[200px]">
				<div className="mx-auto text-center max-w-[820px]">
					<motion.div
						initial="hidden"
						animate="visible"
						custom={0}
						variants={fadeUp}
						className="flex gap-3 justify-center items-center mb-6"
					>
						<span className="flex justify-center items-center rounded-xl border size-11 bg-gray-1 border-gray-4">
							<Image
								src="/logos/logo-solo.svg"
								alt="Cap"
								width={22}
								height={22}
							/>
						</span>
						<span className="text-gray-8">+</span>
						<span className="flex justify-center items-center rounded-xl border size-11 bg-gray-1 border-gray-4">
							<GoogleDriveLogo size={24} />
						</span>
					</motion.div>

					<motion.h1
						initial="hidden"
						animate="visible"
						custom={1}
						variants={fadeUp}
						className="text-[2.25rem] leading-[2.5rem] md:text-[3.5rem] md:leading-[3.75rem] font-medium text-gray-12 text-balance"
					>
						The screen recorder that saves straight to your Google Drive
					</motion.h1>

					<motion.p
						initial="hidden"
						animate="visible"
						custom={2}
						variants={fadeUp}
						className="mx-auto mt-6 max-w-2xl text-lg leading-7 text-gray-10"
					>
						Connect Google Drive to Cap and every shareable link uploads to, and
						is served from, your own Drive. Available for individual creators
						and entire organizations. Open source, privacy-first, and yours to
						keep.
					</motion.p>

					<motion.div
						initial="hidden"
						animate="visible"
						custom={3}
						variants={fadeUp}
						className="flex flex-col gap-3 justify-center items-center mt-9 sm:flex-row sm:gap-4"
					>
						<Button
							variant="blue"
							href="/download"
							size="lg"
							className="w-full font-medium sm:w-auto"
						>
							Download Cap Free
						</Button>
						<Button
							variant="white"
							href="/pricing"
							size="lg"
							className="w-full font-medium sm:w-auto"
						>
							View pricing
						</Button>
					</motion.div>

					<motion.p
						initial="hidden"
						animate="visible"
						custom={4}
						variants={fadeUp}
						className="mt-4 text-sm text-gray-9"
					>
						No credit card required. Free to get started.
					</motion.p>
				</div>

				<motion.div
					initial={{ opacity: 0, y: 40 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ delay: 0.35, duration: 0.6, ease: "easeOut" }}
					className="mt-16 md:mt-20"
				>
					<ConnectionDemo />
					<p className="mx-auto mt-4 text-sm text-center text-gray-9">
						This is the Google Drive integration inside Cap, available on Cap
						Pro.
					</p>
				</motion.div>
			</div>

			<div className="px-5 mx-auto mt-32 max-w-[1250px] md:mt-44">
				<div className="mx-auto mb-16 text-center max-w-[800px]">
					<h2 className="mb-3 text-3xl font-medium md:text-4xl text-gray-12">
						Your recordings, in the Drive you already own
					</h2>
					<p className="text-xl leading-relaxed text-gray-10">
						Cap brings the instant sharing you expect from Loom, while every new
						recording stays in your own Google Drive.
					</p>
				</div>
				<div className="grid grid-cols-1 gap-6 md:grid-cols-3">
					{features.map((feature, index) => {
						const Icon = feature.icon;
						return (
							<motion.div
								key={feature.title}
								initial="hidden"
								whileInView="visible"
								viewport={{ once: true, margin: "-80px" }}
								custom={index % 3}
								variants={fadeUp}
								className="p-8 rounded-2xl border shadow-sm transition-all duration-300 border-gray-4 bg-gray-1 hover:shadow-xl hover:-translate-y-1"
							>
								<div className="flex justify-center items-center mb-5 rounded-xl size-11 bg-gray-3 text-gray-12">
									<Icon className="size-5" strokeWidth={1.75} />
								</div>
								<h3 className="mb-3 text-xl font-semibold text-gray-12">
									{feature.title}
								</h3>
								<p className="leading-relaxed text-gray-10">
									{feature.description}
								</p>
							</motion.div>
						);
					})}
				</div>
			</div>

			<div className="px-5 mx-auto mt-32 max-w-[1100px] md:mt-44">
				<div className="mx-auto mb-16 text-center max-w-[800px]">
					<h2 className="mb-3 text-3xl font-medium md:text-4xl text-gray-12">
						How Cap and Google Drive work together
					</h2>
					<p className="text-xl leading-relaxed text-gray-10">
						Record once and Cap handles the rest, from upload to a shareable
						link served from your Drive.
					</p>
				</div>
				<div className="grid grid-cols-1 gap-6 md:grid-cols-3">
					{flow.map((item, index) => (
						<motion.div
							key={item.title}
							initial="hidden"
							whileInView="visible"
							viewport={{ once: true, margin: "-80px" }}
							custom={index}
							variants={fadeUp}
							className="p-8 rounded-2xl border shadow-sm border-gray-4 bg-gray-1"
						>
							<div className="flex justify-center items-center mb-5 rounded-xl size-11 bg-gray-3 text-gray-12">
								{item.icon}
							</div>
							<h3 className="mb-3 text-xl font-semibold text-gray-12">
								{item.title}
							</h3>
							<p className="leading-relaxed text-gray-10">{item.description}</p>
						</motion.div>
					))}
				</div>
				<p className="mx-auto mt-10 max-w-2xl text-center text-gray-10">
					Prefer object storage instead? Cap also lets you{" "}
					<a
						href="/self-hosted-screen-recording"
						className="font-semibold text-blue-500 transition-colors hover:text-blue-600"
					>
						connect your own S3-compatible bucket
					</a>{" "}
					, or see how Cap compares as a{" "}
					<a
						href="/loom-alternative"
						className="font-semibold text-blue-500 transition-colors hover:text-blue-600"
					>
						Loom alternative
					</a>
					.
				</p>
			</div>

			<div className="px-5 mx-auto mt-32 max-w-4xl md:mt-44">
				<div className="mx-auto mb-12 text-center max-w-[800px]">
					<h2 className="text-3xl font-medium md:text-4xl text-gray-12">
						Cap with Google Drive vs other recorders
					</h2>
				</div>
				<div className="overflow-x-auto">
					<table className="overflow-hidden mx-auto w-full rounded-2xl bg-gray-1">
						<thead className="bg-gray-4">
							<tr>
								{comparisonTable.headers.map((header) => (
									<th
										key={header}
										className="px-6 py-4 text-lg font-semibold text-left border-b border-gray-5 text-gray-12"
									>
										{header}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{comparisonTable.rows.map((row, rowIndex) => (
								<tr
									key={row[0] as string}
									className={rowIndex % 2 === 0 ? "bg-gray-1" : "bg-gray-2"}
								>
									{row.map((cell, cellIndex) => (
										<td
											key={cellIndex.toString()}
											className={clsx(
												"px-6 py-4 text-[15px] text-gray-10",
												rowIndex === comparisonTable.rows.length - 1
													? ""
													: "border-b border-gray-5",
											)}
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

			<div className="px-5 mx-auto mt-32 max-w-3xl md:mt-44">
				<div className="mx-auto mb-12 text-center max-w-[800px]">
					<h2 className="text-3xl font-medium md:text-4xl text-gray-12">
						How to record to Google Drive with Cap
					</h2>
				</div>
				<div className="px-6 rounded-2xl border shadow-sm sm:px-8 border-gray-4 bg-gray-1">
					<ol className="list-none">
						{steps.map((step, index) => (
							<li
								key={step.title}
								className="flex gap-4 items-start py-6 [&:not(:last-child)]:border-b border-gray-4"
							>
								<div className="flex flex-shrink-0 justify-center items-center text-sm font-medium rounded-full bg-gray-4 size-8 text-gray-12">
									{index + 1}
								</div>
								<div>
									<p className="font-medium text-gray-12">{step.title}</p>
									<p className="mt-1 text-gray-10">{step.description}</p>
								</div>
							</li>
						))}
					</ol>
				</div>
			</div>

			<div className="px-5 mx-auto mt-32 max-w-3xl md:mt-44">
				<div className="mx-auto mb-12 text-center max-w-[800px]">
					<h2 className="text-3xl font-medium md:text-4xl text-gray-12">
						Frequently asked questions
					</h2>
				</div>
				<div className="space-y-4">
					{googleDriveScreenRecorderFaqs.map((faq, index) => (
						<div
							key={faq.question}
							className={clsx(
								"rounded-xl overflow-hidden border border-gray-5 transition-colors duration-200",
								openFaqIndex === index
									? "bg-blue-500 text-white"
									: "bg-gray-1 hover:bg-gray-3 text-gray-12",
							)}
						>
							<button
								type="button"
								className="flex justify-between items-center px-6 py-4 w-full text-left"
								onClick={() =>
									setOpenFaqIndex(openFaqIndex === index ? null : index)
								}
							>
								<p
									className={clsx(
										"text-lg font-medium",
										openFaqIndex === index ? "text-gray-1" : "text-gray-12",
									)}
								>
									{faq.question}
								</p>
								<FontAwesomeIcon
									icon={openFaqIndex === index ? faMinus : faPlus}
									className={clsx(
										"flex-shrink-0 size-5",
										openFaqIndex === index ? "text-gray-1" : "text-gray-12",
									)}
								/>
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

			<div className="px-5 mx-auto mt-32 mb-32 max-w-[1000px] md:mt-44 md:mb-44">
				<div
					className="flex overflow-hidden relative flex-col justify-center items-center p-12 text-center rounded-3xl border border-gray-5 bg-white min-h-[300px]"
					style={{
						backgroundImage: "url('/illustrations/ctabg.svg')",
						backgroundSize: "cover",
						backgroundRepeat: "no-repeat",
					}}
				>
					<div className="flex gap-3 justify-center items-center mb-5">
						<span className="flex justify-center items-center rounded-xl border size-10 bg-gray-1 border-gray-4">
							<FolderLock className="size-5 text-gray-12" strokeWidth={1.75} />
						</span>
						<span className="flex justify-center items-center rounded-xl border size-10 bg-gray-1 border-gray-4">
							<GoogleDriveLogo size={22} />
						</span>
					</div>
					<h2 className="mb-4 text-3xl font-medium md:text-4xl text-gray-12">
						Keep every recording in your own Google Drive
					</h2>
					<p className="mb-8 max-w-xl text-xl text-gray-10">
						Download Cap, upgrade to Pro, and connect Google Drive for yourself
						or your whole organization in minutes.
					</p>
					<div className="flex flex-col gap-3 justify-center items-center sm:flex-row sm:gap-4">
						<Button
							variant="blue"
							href="/download"
							size="lg"
							className="w-full font-medium sm:w-auto"
						>
							Download Cap Free
						</Button>
						<Button
							variant="white"
							href="/pricing"
							size="lg"
							className="w-full font-medium sm:w-auto"
						>
							View pricing
						</Button>
					</div>
				</div>
			</div>
		</>
	);
};
