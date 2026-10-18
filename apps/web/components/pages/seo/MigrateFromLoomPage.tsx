import { classNames } from "@cap/utils/helpers";
import { ArrowUpRight, Check, Link2, Minus, Play } from "lucide-react";
import Link from "next/link";
import { LoomMark } from "@/components/icons/LoomMark";
import { MigratePromoBadge } from "@/components/MigratePromoBadge";
import { Eyebrow } from "@/components/pages/HomeTwo/Eyebrow";
import { htMono, htSans, htSerif } from "@/components/pages/HomeTwo/fonts";
import {
	BAND,
	BODY_TEXT,
	BTN_PRIMARY,
	BTN_SECONDARY,
	CREAM,
	grainBg,
	H_HERO,
	H_SECTION,
	MODE_THEME,
	MONO,
	meshStyle,
	SHELL,
} from "@/components/pages/HomeTwo/theme";
import { PRICING } from "@/data/pricing";
import { LoomImportLauncher, LoomImportLink } from "./LoomImportLauncher";
import {
	type ComparisonStatus,
	comparisonRows,
	importSteps,
	includedOnImport,
	LOOM_PURPLE,
	migrateFaqs,
	notIncludedOnImport,
	proofPoints,
} from "./migrate-from-loom-content";

const CHIP = `${MONO} rounded-full px-2 py-1 text-[10.5px] uppercase leading-none tracking-[0.05em]`;

const ImportPreview = () => (
	<div aria-hidden="true" className="relative mx-auto w-full max-w-[520px]">
		<div
			className="rounded-[22px] p-3 shadow-[0_30px_60px_-40px_rgba(17,17,17,0.35)]"
			style={meshStyle(MODE_THEME.instant)}
		>
			<div className="rounded-[14px] bg-white p-4 shadow-[0_1px_2px_rgba(17,17,17,0.06)]">
				<div className="flex items-center gap-3 rounded-[10px] border border-[#E1E7EE] bg-[#F8FAFC] px-3 py-2.5">
					<LoomMark size={16} />
					<span
						className={`${MONO} truncate text-[12.5px] text-[rgba(17,17,17,0.7)]`}
					>
						loom.com/share/7f3a9c2e14b0
					</span>
					<span
						className={classNames(
							CHIP,
							"ml-auto shrink-0 bg-[#111111] text-white",
						)}
					>
						Import
					</span>
				</div>

				<div className="my-3 flex items-center gap-2 px-1">
					<span className="h-px flex-1 bg-[#E1E7EE]" />
					<span
						className={`${MONO} text-[10.5px] uppercase tracking-[0.05em] text-[rgba(17,17,17,0.45)]`}
					>
						Fetched from Loom · Re-hosted on Cap
					</span>
					<span className="h-px flex-1 bg-[#E1E7EE]" />
				</div>

				<div className="overflow-hidden rounded-[12px] border border-[#E1E7EE]">
					<div
						className="relative h-[150px]"
						style={meshStyle(MODE_THEME.studio)}
					>
						<span className="absolute left-1/2 top-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/90 shadow-[0_6px_16px_-6px_rgba(17,17,17,0.4)]">
							<Play className="ml-0.5 size-4 fill-[#111111] text-[#111111]" />
						</span>
						<span
							className={`${MONO} absolute bottom-3 right-3 rounded-md bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white`}
						>
							4:32
						</span>
					</div>
					<div className="p-4">
						<p className="text-[15px] font-medium leading-[1.3] text-[#111111]">
							Q3 roadmap walkthrough
						</p>
						<div className="mt-2.5 flex flex-wrap gap-1.5">
							{["Title", "Transcript", "Summary", "Chapters"].map((chip) => (
								<span
									key={chip}
									className={classNames(
										CHIP,
										"bg-[#EDF1F6] text-[rgba(17,17,17,0.7)]",
									)}
								>
									{chip}
								</span>
							))}
						</div>
						<div className="mt-3 flex items-center gap-2 rounded-[8px] bg-[#F8FAFC] px-3 py-2">
							<Link2 className="size-3.5 shrink-0 text-[rgba(17,17,17,0.5)]" />
							<span
								className={`${MONO} truncate text-[12px] text-[rgba(17,17,17,0.75)]`}
							>
								cap.so/s/8k2m9x1p4qz7c
							</span>
							<span className="ml-auto shrink-0 rounded-full bg-[#DDF5E8] px-2 py-0.5 text-[10.5px] font-medium text-[#1B6E45]">
								Copied
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
);

const Hero = ({ signedIn }: { signedIn: boolean }) => (
	<section className="relative px-5 pb-16 pt-12 sm:pt-16 lg:pb-24 lg:pt-20">
		<span
			data-header-sentinel
			aria-hidden="true"
			className="pointer-events-none absolute bottom-0 left-0 size-px"
		/>
		<div className="mx-auto grid max-w-[1200px] items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)] lg:gap-16">
			<div className="flex flex-col items-start">
				<Eyebrow accent={LOOM_PURPLE}>Switching from Loom</Eyebrow>
				<h1
					className={`${H_HERO} mt-6 max-w-[640px] text-balance text-[clamp(38px,5vw,66px)]`}
				>
					Import your Loom videos into Cap
				</h1>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[560px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18.5px]`}
				>
					Paste a share link or upload a CSV of your whole library. Cap fetches
					each recording, keeps the title, adds a transcript and chapters, and
					stores it somewhere you own.
				</p>

				<LoomImportLauncher signedIn={signedIn} />

				<MigratePromoBadge
					sourcePage="migrate_from_loom_hero"
					className="mt-6"
				/>
				<p className="mt-4 max-w-[560px] text-[13.5px] leading-[1.55] text-[rgba(17,17,17,0.55)]">
					Free account, no credit card. Loom import is part of Cap Pro, from $
					{PRICING.pro.annualPerMonth} per user per month. Enter the code at
					checkout and the discount applies to every renewal.
				</p>
			</div>

			<ImportPreview />
		</div>
	</section>
);

const Proof = () => (
	<section className="px-5">
		<div className="mx-auto grid max-w-[1200px] gap-8 border-y border-[#E1E7EE] py-10 sm:grid-cols-3 sm:gap-10">
			{proofPoints.map((point) => (
				<div key={point.title}>
					<p className="text-[17px] font-medium leading-[1.25] tracking-[-0.02em] text-[#111111]">
						{point.title}
					</p>
					<p
						className={`${BODY_TEXT} mt-2 text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.65)]`}
					>
						{point.body}
					</p>
				</div>
			))}
		</div>
	</section>
);

const HowItWorks = () => (
	<section className="px-5 py-20 lg:py-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="max-w-[640px]">
				<Eyebrow accent={MODE_THEME.instant.accent}>How it works</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(34px,3.9vw,48px)]`}
				>
					From Loom link to Cap link in three steps
				</h2>
			</div>
			<ol className="mt-12 grid gap-4 md:grid-cols-3">
				{importSteps.map((step, index) => (
					<li
						key={step.name}
						className="flex flex-col rounded-[20px] p-7"
						style={grainBg(BAND)}
					>
						<span
							className={`${MONO} text-[12px] uppercase tracking-[0.05em] text-[rgba(17,17,17,0.5)]`}
						>
							Step {index + 1}
						</span>
						<h3 className="mt-5 text-[21px] font-normal leading-[1.15] tracking-[-0.02em] text-[#111111]">
							{step.name}
						</h3>
						<p
							className={`${BODY_TEXT} mt-3 text-[15.5px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
						>
							{step.text}
						</p>
					</li>
				))}
			</ol>
		</div>
	</section>
);

const WhatComesAcross = () => (
	<section className="px-5 pb-20 lg:pb-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="max-w-[640px]">
				<Eyebrow accent={MODE_THEME.studio.accent}>What comes across</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(34px,3.9vw,48px)]`}
				>
					Everything that matters, and nothing you have to redo
				</h2>
			</div>
			<div className="mt-12 grid gap-4 lg:grid-cols-2">
				<div className="rounded-[20px] bg-white p-7 shadow-[0_0_0_1px_rgba(17,17,17,0.05)]">
					<p
						className={`${MONO} text-[12px] uppercase tracking-[0.05em] text-[#1B6E45]`}
					>
						Imported with every video
					</p>
					<ul className="mt-5 divide-y divide-[#E1E7EE]">
						{includedOnImport.map((item) => (
							<li key={item.title} className="flex gap-4 py-4 first:pt-0">
								<span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[#DDF5E8] text-[#1B6E45]">
									<Check className="size-3.5" strokeWidth={2.5} />
								</span>
								<span>
									<span className="block text-[16px] font-medium leading-[1.3] text-[#111111]">
										{item.title}
									</span>
									<span
										className={`${BODY_TEXT} mt-1 block text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.65)]`}
									>
										{item.body}
									</span>
								</span>
							</li>
						))}
					</ul>
				</div>
				<div className="rounded-[20px] p-7" style={grainBg(BAND)}>
					<p
						className={`${MONO} text-[12px] uppercase tracking-[0.05em] text-[rgba(17,17,17,0.55)]`}
					>
						Stays on Loom
					</p>
					<ul className="mt-5 divide-y divide-[rgba(17,17,17,0.08)]">
						{notIncludedOnImport.map((item) => (
							<li key={item.title} className="flex gap-4 py-4 first:pt-0">
								<span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white text-[rgba(17,17,17,0.5)]">
									<Minus className="size-3.5" strokeWidth={2.5} />
								</span>
								<span>
									<span className="block text-[16px] font-medium leading-[1.3] text-[#111111]">
										{item.title}
									</span>
									<span
										className={`${BODY_TEXT} mt-1 block text-[14.5px] leading-[1.5] text-[rgba(17,17,17,0.65)]`}
									>
										{item.body}
									</span>
								</span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	</section>
);

const CSV_LINES = [
	"loom_video_url,user_email,space_name",
	"https://www.loom.com/share/7f3a9c2e,ana@acme.com,Customer Success",
	"https://www.loom.com/share/b81d04ff,sam@acme.com,Engineering",
];

const Teams = () => (
	<section className="px-5 pb-20 lg:pb-28">
		<div
			className="mx-auto grid max-w-[1200px] gap-10 rounded-[24px] p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:items-center lg:p-12"
			style={grainBg(BAND)}
		>
			<div>
				<Eyebrow accent={MODE_THEME.share.accent}>Team migrations</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 max-w-[520px] text-balance text-[clamp(32px,3.6vw,46px)]`}
				>
					Moving a whole team off Loom?
				</h2>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[520px] text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)]`}
				>
					Upload a CSV of up to 500 Loom links mapped to teammate emails and
					spaces, and Cap imports each video for the right owner. Bigger
					libraries run in controlled batches through the Cap CLI or MCP server,
					or we run the migration with you. We have moved organizations with
					hundreds of users and tens of thousands of recordings.
				</p>
				<div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
					<Link href="/docs/migrating-to-cap" className={BTN_PRIMARY}>
						Read the migration guide
					</Link>
					<a
						href="mailto:hello@cap.so?subject=Loom%20team%20migration"
						className={classNames(BTN_SECONDARY, "gap-2")}
					>
						Talk to us about a managed migration
						<ArrowUpRight className="size-4 text-[rgba(17,17,17,0.45)]" />
					</a>
				</div>
			</div>
			<div className="rounded-[16px] bg-[#111111] p-5 shadow-[0_30px_60px_-40px_rgba(17,17,17,0.6)]">
				<div className="flex items-center justify-between">
					<span
						className={`${MONO} text-[11px] uppercase tracking-[0.05em] text-[rgba(255,255,255,0.5)]`}
					>
						loom-library.csv
					</span>
					<span
						className={`${MONO} text-[11px] uppercase tracking-[0.05em] text-[#8FDCBB]`}
					>
						Up to 500 rows
					</span>
				</div>
				<pre
					className={`${MONO} mt-4 overflow-x-auto whitespace-pre text-[12px] leading-[1.8] text-[#F8FAFC]`}
				>
					{CSV_LINES.join("\n")}
				</pre>
			</div>
		</div>
	</section>
);

const STATUS_STYLE: Record<ComparisonStatus, string> = {
	positive: "bg-[#DDF5E8] text-[#1B6E45]",
	negative: "bg-[#FBE3E3] text-[#B42318]",
	warning: "bg-[#FCEEDB] text-[#B07430]",
	neutral: "bg-[#EDF1F6] text-[rgba(17,17,17,0.6)]",
};

const StatusDot = ({ status }: { status: ComparisonStatus }) => (
	<span
		aria-hidden="true"
		className={classNames(
			"grid size-5 shrink-0 place-items-center rounded-full",
			STATUS_STYLE[status],
		)}
	>
		{status === "positive" ? (
			<Check className="size-3" strokeWidth={3} />
		) : (
			<Minus className="size-3" strokeWidth={3} />
		)}
	</span>
);

const Comparison = () => (
	<section className="px-5 pb-20 lg:pb-28">
		<div className="mx-auto max-w-[1000px]">
			<div className="max-w-[640px]">
				<Eyebrow accent={MODE_THEME.screenshot.accent}>Cap vs Loom</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(34px,3.9vw,48px)]`}
				>
					What changes when you switch
				</h2>
			</div>
			<div className="mt-10 overflow-x-auto rounded-[20px] bg-white shadow-[0_0_0_1px_rgba(17,17,17,0.05)]">
				<table className="w-full min-w-[640px] border-collapse text-left">
					<thead>
						<tr className="border-b border-[#E1E7EE]">
							<th
								scope="col"
								className={`${MONO} px-6 py-4 text-[12px] font-normal uppercase tracking-[0.05em] text-[rgba(17,17,17,0.5)]`}
							>
								Feature
							</th>
							<th
								scope="col"
								className="px-6 py-4 text-[15px] font-medium text-[#111111]"
							>
								Cap
							</th>
							<th
								scope="col"
								className="px-6 py-4 text-[15px] font-medium text-[#111111]"
							>
								Loom
							</th>
						</tr>
					</thead>
					<tbody>
						{comparisonRows.map((row) => (
							<tr
								key={row.feature}
								className="border-b border-[#E1E7EE] last:border-b-0"
							>
								<th
									scope="row"
									className="px-6 py-4 text-[15px] font-medium text-[#111111]"
								>
									{row.feature}
								</th>
								<td className="px-6 py-4 text-[15px] text-[rgba(17,17,17,0.8)]">
									<span className="flex items-center gap-3">
										<StatusDot status={row.cap.status} />
										{row.cap.text}
									</span>
								</td>
								<td className="px-6 py-4 text-[15px] text-[rgba(17,17,17,0.8)]">
									<span className="flex items-center gap-3">
										<StatusDot status={row.loom.status} />
										{row.loom.text}
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="mt-4 text-[13.5px] text-[rgba(17,17,17,0.5)]">
				Want the full breakdown?{" "}
				<Link
					href="/loom-alternative"
					className="text-[#111111] underline decoration-[rgba(17,17,17,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#111111]"
				>
					Read why Cap is the open source Loom alternative
				</Link>
				.
			</p>
		</div>
	</section>
);

const Faq = () => (
	<section className="px-5 pb-20 lg:pb-28">
		<div className="mx-auto grid max-w-[1100px] gap-12 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-20">
			<div className="lg:sticky lg:top-28 lg:self-start">
				<Eyebrow accent={MODE_THEME.screenshot.accent}>FAQ</Eyebrow>
				<h2
					className={`${H_SECTION} mt-6 text-balance text-[clamp(34px,3.9vw,48px)]`}
				>
					Migrating from Loom, answered
				</h2>
				<p
					className={`${BODY_TEXT} mt-5 max-w-[320px] text-[16px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
				>
					Something else? Mail{" "}
					<a
						href="mailto:hello@cap.so"
						className="underline decoration-[rgba(17,17,17,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#111111]"
					>
						hello@cap.so
					</a>{" "}
					and a human answers.
				</p>
			</div>
			<div>
				{migrateFaqs.map((item) => (
					<details
						key={item.question}
						className="group border-t border-[#E1E7EE] last:border-b"
					>
						<summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-left text-[17px] font-normal tracking-[-0.02em] text-[rgba(17,17,17,0.75)] transition-colors duration-200 hover:text-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] group-open:text-[#111111] lg:text-[19px] [&::-webkit-details-marker]:hidden">
							{item.question}
							<span
								aria-hidden="true"
								className="relative grid size-8 shrink-0 place-items-center rounded-full bg-[#E7EDF3] transition-colors duration-200 group-hover:bg-[#DCE4EC]"
							>
								<span className="absolute h-[1.5px] w-3 rounded-full bg-[#111111]" />
								<span className="absolute h-3 w-[1.5px] rounded-full bg-[#111111] transition-transform duration-200 group-open:scale-y-0" />
							</span>
						</summary>
						<p
							className={`${BODY_TEXT} max-w-[640px] pb-7 pr-10 text-[15.5px] leading-[1.6] text-[rgba(17,17,17,0.72)]`}
						>
							{item.answer}
						</p>
					</details>
				))}
			</div>
		</div>
	</section>
);

const FinalCta = ({ signedIn }: { signedIn: boolean }) => (
	<section className="px-5 pb-20 lg:pb-28">
		<div
			className="mx-auto flex max-w-[1200px] flex-col items-center rounded-[24px] px-6 py-16 text-center lg:py-20"
			style={grainBg(BAND)}
		>
			<Eyebrow accent={LOOM_PURPLE}>Get started</Eyebrow>
			<h2
				className={`${H_HERO} mt-6 max-w-[720px] text-balance text-[clamp(36px,5vw,60px)]`}
			>
				Ready to leave Loom behind?
			</h2>
			<p
				className={`${BODY_TEXT} mt-6 max-w-[520px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)]`}
			>
				Create a free account, paste your first Loom link, and your library
				starts moving in minutes.
			</p>
			<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
				<LoomImportLink
					signedIn={signedIn}
					location="final_cta"
					className={BTN_PRIMARY}
				>
					Import your Loom videos
				</LoomImportLink>
				<Link href="/loom-alternative" className={BTN_SECONDARY}>
					Compare Cap vs Loom
				</Link>
			</div>
			<MigratePromoBadge
				sourcePage="migrate_from_loom_final"
				className="mt-6"
			/>
			<p className="mt-5 text-[13.5px] text-[rgba(17,17,17,0.5)]">
				Prefer to keep the original files? Use the{" "}
				<Link
					href="/tools/loom-downloader"
					className="text-[#111111] underline decoration-[rgba(17,17,17,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#111111]"
				>
					free Loom video downloader
				</Link>
				.
			</p>
		</div>
	</section>
);

export const MigrateFromLoomPage = ({ signedIn }: { signedIn: boolean }) => (
	<div
		data-header-flat
		className={`${htSans.className} ${htSans.variable} ${htSerif.variable} ${htMono.variable} text-[#111111]`}
		style={grainBg(SHELL)}
	>
		<div className="px-2.5 pb-2.5 pt-[68px] sm:px-4 sm:pb-4 lg:pt-[76px]">
			<div
				className="rounded-[24px] shadow-[0_0_0_1px_rgba(17,17,17,0.045)]"
				style={grainBg(CREAM)}
			>
				<Hero signedIn={signedIn} />
				<Proof />
				<HowItWorks />
				<WhatComesAcross />
				<Teams />
				<Comparison />
				<Faq />
				<FinalCta signedIn={signedIn} />
			</div>
		</div>
	</div>
);
