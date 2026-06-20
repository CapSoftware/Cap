"use client";

import { Button } from "@cap/ui";
import {
	faArrowLeft,
	faArrowRight,
	faCheck,
	faExclamation,
	faFileCsv,
	faInfo,
	faLink,
	faMinus,
	faPlus,
	faTimes,
	faUpload,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import {
	BadgeDollarSign,
	Database,
	FileDown,
	ShieldCheck,
	Sparkles,
	Zap,
} from "lucide-react";
import { useRouter } from "next/navigation";
import Script from "next/script";
import { type JSX, useState } from "react";
import { LoomMark } from "@/components/icons/LoomMark";

const IMPORT_HREF = "/dashboard/import/loom";

type ImportTab = "single" | "csv";

type ComparisonStatus = "positive" | "negative" | "warning" | "neutral";
type ComparisonCell = { text: string; status?: ComparisonStatus };

const comparisonTable: {
	headers: string[];
	rows: (string | ComparisonCell)[][];
} = {
	headers: ["Feature", "Cap", "Loom"],
	rows: [
		[
			"Pricing",
			{ text: "from $8.16/mo per user", status: "positive" },
			{ text: "$18/mo per user", status: "warning" },
		],
		[
			"Open source",
			{ text: "Yes", status: "positive" },
			{ text: "No", status: "negative" },
		],
		[
			"Free plan",
			{ text: "Unlimited Studio Mode", status: "positive" },
			{ text: "Limited features & time", status: "warning" },
		],
		[
			"4K recording",
			{ text: "Free & paid plans", status: "positive" },
			{ text: "Paid plans only", status: "warning" },
		],
		[
			"Bring your own storage",
			{ text: "Connect your own S3 or Google Drive", status: "positive" },
			{ text: "Not available", status: "negative" },
		],
		[
			"Team members",
			{
				text: "Invite people to your organization for free",
				status: "positive",
			},
			{ text: "Paid per seat", status: "warning" },
		],
		[
			"Custom domain",
			{ text: "Yes", status: "positive" },
			{ text: "Enterprise plan only", status: "neutral" },
		],
		[
			"Data ownership",
			{ text: "100% with own storage", status: "positive" },
			{ text: "Platform dependent", status: "neutral" },
		],
	],
};

const features = [
	{
		icon: FileDown,
		title: "Built-in Loom importer",
		description:
			"Paste a Loom share link or upload a CSV of your whole library. Cap downloads and re-hosts every recording for you, with no manual downloads or re-uploads.",
	},
	{
		icon: BadgeDollarSign,
		title: "Half the price of Loom",
		description:
			"Cap Pro starts at just $8.16/month per user versus Loom's $18. A genuinely generous free plan is included, with Studio mode free for personal use.",
	},
	{
		icon: ShieldCheck,
		title: "Open source & private",
		description:
			"Cap is fully open source and privacy-first. Audit the code, self-host the whole stack, or password-protect sensitive shares. Your call.",
	},
	{
		icon: Database,
		title: "Your storage, your rules",
		description:
			"Connect your own S3 bucket or Google Drive, plus a custom domain, for 100% ownership of every recording. No vendor lock-in, ever.",
	},
	{
		icon: Zap,
		title: "Instant, Studio & Screenshot Modes",
		description:
			"Share in seconds with Instant Mode, edit pixel-perfect locally with Studio Mode, or grab and annotate a single frame, all in one native app.",
	},
	{
		icon: Sparkles,
		title: "Cap AI does the busywork",
		description:
			"Every recording gets an AI-generated title, summary, clickable chapters, and a searchable transcript, so the work after recording is already done.",
	},
];

const steps = [
	{
		title: "Create your free Cap account",
		description: "Sign up in seconds. No credit card required to get started.",
	},
	{
		title: "Open Dashboard → Import → Loom",
		description:
			"Head to the import hub and choose Loom to bring your recordings across.",
	},
	{
		title: "Paste a link or upload a CSV",
		description:
			"Migrate a single share link, or bulk import your entire library from a CSV, assigning videos to members and spaces.",
	},
	{
		title: "We import everything in the background",
		description:
			"Cap re-hosts your videos and they appear in your caps, ready to share with links, comments and analytics.",
	},
];

const faqs = [
	{
		question: "Can I import my existing Loom videos into Cap?",
		answer:
			"Yes. Cap Pro includes a built-in Loom video importer. Paste a Loom share link to bring a single video across, or upload a CSV to bulk import your whole library directly into Cap.",
	},
	{
		question: "How does bulk migrating from Loom work?",
		answer:
			"Download our CSV template, add a row per video with the Loom URL, the user's email, and an optional space name, then upload it. Cap imports each recording for the matching organization member and places it in the right space, up to 500 videos at a time.",
	},
	{
		question: "Do I need to download my Loom videos first?",
		answer:
			"No. Cap fetches each Loom recording directly from the share link and re-hosts it for you. There's no manual downloading or re-uploading involved.",
	},
	{
		question: "Is migrating from Loom free?",
		answer:
			"Creating a Cap account is free, and you can try Cap with no credit card. The built-in Loom importer is a Cap Pro feature, which starts at just $8.16/month per user, less than half the price of Loom.",
	},
	{
		question: "Will I keep ownership of my recordings?",
		answer:
			"Absolutely. Cap is open source, and you can connect your own S3 storage and custom domain for 100% ownership and control of your content. You're never locked into our platform.",
	},
	{
		question: "How is Cap different from Loom?",
		answer:
			"Cap gives you the simplicity of Loom with the power of professional tools: open source, bring-your-own-storage, better pricing, and a native desktop app that works offline. Plus you actually own your content, and our importer makes switching effortless.",
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
			<FontAwesomeIcon
				icon={faExclamation}
				className="text-[11px] text-white"
			/>
		</div>
	),
	neutral: (
		<div className="flex flex-shrink-0 justify-center items-center bg-gray-500 rounded-full size-5">
			<FontAwesomeIcon icon={faInfo} className="text-[11px] text-white" />
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

const ImportDemoTab = ({
	active,
	icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: typeof faLink;
	label: string;
	onClick: () => void;
}) => (
	<button
		type="button"
		role="tab"
		aria-selected={active}
		onClick={onClick}
		className={clsx(
			"relative flex items-center gap-2 px-4 h-9 rounded-full text-sm font-medium transition-colors",
			active
				? "text-gray-12"
				: "text-gray-10 hover:text-gray-12 cursor-pointer",
		)}
	>
		{active && (
			<motion.span
				layoutId="migrate-loom-mode-indicator"
				className="absolute inset-0 rounded-full border shadow-sm bg-gray-1 border-gray-4"
				transition={{ type: "spring", stiffness: 500, damping: 35 }}
			/>
		)}
		<FontAwesomeIcon icon={icon} className="relative size-3.5" />
		<span className="relative">{label}</span>
	</button>
);

const ImportDemo = () => {
	const router = useRouter();
	const [tab, setTab] = useState<ImportTab>("single");

	const goToImport = () => router.push(IMPORT_HREF);

	return (
		<div className="overflow-hidden mx-auto w-full max-w-4xl rounded-2xl border shadow-xl border-gray-4 bg-gray-2">
			<div className="flex gap-3 items-center px-4 h-11 border-b border-gray-4 bg-gray-3">
				<div className="flex gap-1.5">
					<span className="rounded-full size-3 bg-gray-6" />
					<span className="rounded-full size-3 bg-gray-6" />
					<span className="rounded-full size-3 bg-gray-6" />
				</div>
				<div className="flex flex-1 gap-2 justify-center items-center text-xs text-gray-10">
					<span className="hidden sm:inline">Dashboard</span>
					<FontAwesomeIcon
						className="hidden size-2 sm:inline text-gray-8"
						icon={faArrowRight}
					/>
					<span className="hidden sm:inline">Import</span>
					<FontAwesomeIcon
						className="hidden size-2 sm:inline text-gray-8"
						icon={faArrowRight}
					/>
					<span className="font-medium text-gray-12">Loom</span>
				</div>
				<div className="w-12" />
			</div>

			<div className="p-6 text-left sm:p-8 bg-gray-1">
				<button
					type="button"
					onClick={goToImport}
					className="inline-flex gap-2 items-center mb-4 text-sm transition-colors cursor-pointer text-gray-10 hover:text-gray-12"
				>
					<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					Back to Import
				</button>

				<div className="flex gap-4 items-start mb-8">
					<div className="flex flex-shrink-0 justify-center items-center rounded-full size-12 bg-gray-3">
						<LoomMark size={20} />
					</div>
					<div>
						<h2 className="text-2xl font-medium text-gray-12">
							Import from Loom
						</h2>
						<p className="mt-1 max-w-xl text-sm text-gray-10">
							Bring a single Loom video into Cap, or bulk import your whole
							library for organization members from a CSV.
						</p>
					</div>
				</div>

				<div className="flex flex-col gap-6 w-full">
					<div
						role="tablist"
						aria-label="Loom import mode"
						className="flex gap-1 p-1 rounded-full border w-fit border-gray-3 bg-gray-2"
					>
						<ImportDemoTab
							active={tab === "single"}
							icon={faLink}
							label="Single Video"
							onClick={() => setTab("single")}
						/>
						<ImportDemoTab
							active={tab === "csv"}
							icon={faFileCsv}
							label="Bulk Import"
							onClick={() => setTab("csv")}
						/>
					</div>

					{tab === "single" ? (
						<div className="flex overflow-hidden flex-col rounded-xl border bg-gray-1 border-gray-3">
							<div className="flex flex-col gap-1 px-6 py-5 border-b border-gray-3">
								<p className="text-sm font-medium text-gray-12">
									Loom video URL
								</p>
								<p className="text-xs text-gray-10">
									Paste any Loom share link. The video downloads and processes
									in the background.
								</p>
							</div>
							<div className="flex flex-col gap-4 p-6">
								<button
									type="button"
									onClick={goToImport}
									className="flex items-center px-3 w-full h-11 text-sm text-left rounded-xl border transition-colors cursor-pointer border-gray-4 bg-gray-1 text-gray-9 hover:border-gray-6"
								>
									https://www.loom.com/share/...
								</button>
								<div className="flex flex-col-reverse gap-3 justify-end sm:flex-row">
									<Button
										type="button"
										size="sm"
										variant="gray"
										onClick={goToImport}
									>
										Cancel
									</Button>
									<Button
										type="button"
										size="sm"
										variant="dark"
										onClick={goToImport}
									>
										Import Video
									</Button>
								</div>
							</div>
						</div>
					) : (
						<div className="flex flex-col gap-6">
							<div className="flex flex-col gap-4 justify-between p-5 rounded-xl border sm:flex-row sm:items-center bg-gray-2 border-gray-3">
								<div className="flex gap-4 items-start sm:items-center">
									<div className="flex flex-shrink-0 justify-center items-center rounded-lg size-10 bg-gray-3 text-gray-11">
										<FontAwesomeIcon className="size-4" icon={faFileCsv} />
									</div>
									<div className="flex flex-col gap-1.5">
										<p className="text-sm font-medium text-gray-12">
											First time? Start with our template
										</p>
										<p className="text-xs text-gray-10">
											Two columns required:{" "}
											<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
												loom_video_url
											</code>{" "}
											and{" "}
											<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
												user_email
											</code>
											. Add{" "}
											<code className="px-1.5 py-0.5 rounded bg-gray-3 text-gray-12 text-[11px] font-mono">
												space_name
											</code>{" "}
											to place videos in spaces.
										</p>
									</div>
								</div>
								<Button
									type="button"
									variant="white"
									size="sm"
									onClick={goToImport}
									className="flex-shrink-0"
								>
									<FontAwesomeIcon className="size-3.5" icon={faFileCsv} />
									Download Template
								</Button>
							</div>

							<button
								type="button"
								onClick={goToImport}
								aria-label="Upload a CSV"
								className="flex relative flex-col justify-center items-center px-8 w-full rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer py-14 border-gray-4 bg-gray-1 hover:border-gray-6 hover:bg-gray-2"
							>
								<div className="flex flex-col gap-4 items-center">
									<div className="flex justify-center items-center rounded-full size-16 bg-gray-3 text-gray-10">
										<FontAwesomeIcon className="size-6" icon={faUpload} />
									</div>
									<div className="flex flex-col gap-1 items-center text-center">
										<p className="text-sm font-medium text-gray-12">
											Drag and drop your CSV here
										</p>
										<p className="text-xs text-gray-10">
											Or browse your computer to upload a file.
										</p>
									</div>
									<span className="flex justify-center items-center px-5 mt-2 h-9 text-sm font-medium rounded-full bg-gray-12 text-gray-1">
										Browse CSV
									</span>
								</div>
							</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};

const createFaqStructuredData = () =>
	JSON.stringify({
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: faqs.map((faq) => ({
			"@type": "Question",
			name: faq.question,
			acceptedAnswer: { "@type": "Answer", text: faq.answer },
		})),
	});

export const MigrateFromLoomPage = () => {
	const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);

	return (
		<>
			<Script
				id="migrate-from-loom-faq"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>

			<div className="overflow-hidden relative px-5 pt-[140px] md:pt-[200px]">
				<div className="mx-auto text-center max-w-[820px]">
					<motion.div
						initial="hidden"
						animate="visible"
						custom={0}
						variants={fadeUp}
						className="flex justify-center mb-5"
					>
						<span className="inline-flex gap-2 items-center px-3 py-1 text-sm font-medium rounded-full border border-gray-4 bg-gray-2 text-gray-11">
							<LoomMark size={14} />
							Loom → Cap migration
						</span>
					</motion.div>

					<motion.h1
						initial="hidden"
						animate="visible"
						custom={1}
						variants={fadeUp}
						className="text-[2.25rem] leading-[2.5rem] md:text-[3.5rem] md:leading-[3.75rem] font-medium text-gray-12 text-balance"
					>
						Migrate from Loom to Cap in minutes
					</motion.h1>

					<motion.p
						initial="hidden"
						animate="visible"
						custom={2}
						variants={fadeUp}
						className="mx-auto mt-6 max-w-2xl text-lg leading-7 text-gray-10"
					>
						Bring your existing Loom videos into Cap with the built-in importer.
						Paste a single share link or bulk import your entire library from a
						CSV. Open source, privacy-first, and half the price of Loom.
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
							href={IMPORT_HREF}
							size="lg"
							className="w-full font-medium sm:w-auto"
						>
							Import your Loom videos
						</Button>
						<Button
							variant="white"
							href="/loom-alternative"
							size="lg"
							className="w-full font-medium sm:w-auto"
						>
							Compare Cap vs Loom
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
					<ImportDemo />
					<p className="mx-auto mt-4 text-sm text-center text-gray-9">
						This is the Loom importer inside Cap.{" "}
						<a
							href={IMPORT_HREF}
							className="font-medium text-blue-500 transition-colors hover:text-blue-600"
						>
							Open it in your dashboard to import your first video.
						</a>
					</p>
				</motion.div>
			</div>

			<div className="px-5 mx-auto mt-32 max-w-[1250px] md:mt-44">
				<div className="mx-auto mb-16 text-center max-w-[800px]">
					<h2 className="mb-3 text-3xl font-medium md:text-4xl text-gray-12">
						Everything you loved about Loom, without the lock-in
					</h2>
					<p className="text-xl leading-relaxed text-gray-10">
						Cap is the open-source screen recorder built to be yours: your
						storage, your platform, your workflow.
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

			<div className="px-5 mx-auto mt-32 max-w-4xl md:mt-44">
				<div className="mx-auto mb-12 text-center max-w-[800px]">
					<h2 className="text-3xl font-medium md:text-4xl text-gray-12">
						Cap vs Loom at a glance
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
						How migrating from Loom works
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
					{faqs.map((faq, index) => (
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
					<h2 className="mb-4 text-3xl font-medium md:text-4xl text-gray-12">
						Ready to leave Loom behind?
					</h2>
					<p className="mb-8 max-w-xl text-xl text-gray-10">
						Create your free account and bring your Loom library with you. It
						takes minutes.
					</p>
					<div className="flex flex-col gap-3 justify-center items-center sm:flex-row sm:gap-4">
						<Button
							variant="blue"
							href={IMPORT_HREF}
							size="lg"
							className="w-full font-medium sm:w-auto"
						>
							Import your Loom videos
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
