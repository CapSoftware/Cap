import { classNames } from "@cap/utils/helpers";
import { ArrowUpRight, Github } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
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
import {
	DISCORD_URL,
	focus,
	GITHUB_URL,
	milestones,
	principles,
	quote,
	story,
	X_URL,
} from "./content";

const GitHubButton = ({
	stars,
	className,
}: {
	stars: string;
	className: string;
}) => (
	<a
		href={GITHUB_URL}
		target="_blank"
		rel="noopener noreferrer"
		className={classNames(className, "gap-2.5")}
	>
		<Github className="size-[18px]" strokeWidth={1.75} />
		Star on GitHub
		{stars ? (
			<span
				className={`${MONO} rounded-full bg-[#EDF1F6] px-2 py-1 text-[12px] leading-none text-[rgba(17,17,17,0.65)]`}
			>
				{stars}
			</span>
		) : null}
	</a>
);

const Hero = ({ stars }: { stars: string }) => (
	<section className="relative px-5 pb-6 pt-12 sm:pt-14 lg:pb-8 lg:pt-[56px]">
		<div className="mx-auto max-w-[1200px]">
			<div className="relative mx-auto flex max-w-[860px] flex-col items-center text-center">
				<h1 className={`${H_HERO} text-balance text-[clamp(42px,6.4vw,84px)]`}>
					Why we started Cap
				</h1>
				<p
					className={`${BODY_TEXT} mt-8 max-w-[680px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[19px]`}
				>
					Cap started in 2023 as the open source alternative to Loom. It has
					grown into a screen recording and sharing platform built on three
					things we refuse to compromise on: privacy, transparency, and
					community.
				</p>
				<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
					<Link href="/download" className={BTN_PRIMARY}>
						Download Cap
					</Link>
					<GitHubButton stars={stars} className={BTN_SECONDARY} />
				</div>
				<span
					data-header-sentinel
					aria-hidden="true"
					className="pointer-events-none absolute bottom-0 left-0 size-px"
				/>
			</div>

			<div
				className="mt-12 rounded-[24px] p-3 lg:mt-14 lg:p-4"
				style={meshStyle(MODE_THEME.instant)}
			>
				<div className="relative overflow-hidden rounded-[16px] bg-[#111111]">
					<video
						autoPlay
						loop
						muted
						playsInline
						preload="metadata"
						poster="/videos/about/laptop-open-poster.jpg"
						aria-label="Opening a laptop and launching Cap from the dock"
						className="aspect-video w-full object-cover"
					>
						<source src="/videos/about/laptop-open.webm" type="video/webm" />
						<source src="/videos/about/laptop-open.mp4" type="video/mp4" />
					</video>
				</div>
			</div>
		</div>
	</section>
);

const Story = () => (
	<section className="px-5 py-20 lg:py-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="max-w-[760px]">
				<h2
					className={`${H_SECTION} text-balance text-[clamp(34px,4.6vw,56px)]`}
				>
					Screen recording should be simple.
				</h2>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[560px] text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.72)] sm:text-[18px]`}
				>
					Somewhere along the way it stopped being simple. Here is what we saw,
					and what we decided to do about it.
				</p>
			</div>

			<div className="mt-12 grid gap-10 border-t border-[#E1E7EE] pt-10 md:grid-cols-2 md:gap-14 lg:mt-14">
				{story.map((chapter) => (
					<div key={chapter.label}>
						<h3 className="text-[22px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111] sm:text-[24px]">
							{chapter.label}
						</h3>
						<div className="mt-5 space-y-5">
							{chapter.paragraphs.map((paragraph) => (
								<p
									key={paragraph}
									className={`${BODY_TEXT} text-[16.5px] leading-[1.6] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
								>
									{paragraph}
								</p>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	</section>
);

const Principles = () => (
	<section className="px-5 pb-20 lg:pb-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
				<h2
					className={`${H_SECTION} text-balance text-[clamp(36px,4.6vw,56px)]`}
				>
					Four things we will not compromise on
				</h2>
				<p
					className={`${BODY_TEXT} mt-6 max-w-[560px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[17.5px]`}
				>
					These are not a roadmap. They are the constraints every feature has to
					fit inside before it ships.
				</p>
			</div>

			<ul className="mt-14 grid gap-4 md:grid-cols-2">
				{principles.map((principle) => {
					return (
						<li
							key={principle.title}
							className="flex flex-col rounded-[20px] p-7 lg:p-8"
							style={meshStyle(MODE_THEME[principle.mode])}
						>
							<h3 className="text-[24px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111] sm:text-[26px]">
								{principle.title}
							</h3>
							<p
								className={`${BODY_TEXT} mt-4 text-[15.5px] leading-[1.55] text-[rgba(17,17,17,0.75)]`}
							>
								{principle.body}
							</p>
							{principle.link ? (
								<a
									href={principle.link.href}
									target="_blank"
									rel="noopener noreferrer"
									className={classNames(
										MONO,
										"mt-6 inline-flex w-fit items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-[11px] uppercase leading-none tracking-[0.05em] text-[#111111] shadow-[0_0_0_1px_rgba(17,17,17,0.06)] transition-colors duration-200 hover:bg-[#EDF1F6]",
									)}
								>
									{principle.link.label}
									<ArrowUpRight className="size-3" />
								</a>
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	</section>
);

const Milestones = () => (
	<section className="px-5 pb-20 lg:pb-28">
		<div className="mx-auto grid max-w-[1100px] gap-12 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-20">
			<div className="lg:sticky lg:top-28 lg:self-start">
				<h2
					className={`${H_SECTION} text-balance text-[clamp(34px,3.9vw,48px)]`}
				>
					Building in public since 2023
				</h2>
				<p
					className={`${BODY_TEXT} mt-5 max-w-[320px] text-[16px] leading-[1.5] text-[rgba(17,17,17,0.72)]`}
				>
					Every release, outage, and decision gets written up. Follow along on
					the{" "}
					<Link
						href="/blog"
						className="underline decoration-[rgba(17,17,17,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#111111]"
					>
						blog
					</Link>{" "}
					and the{" "}
					<Link
						href="/changelog"
						className="underline decoration-[rgba(17,17,17,0.3)] underline-offset-[5px] transition-colors duration-200 hover:decoration-[#111111]"
					>
						changelog
					</Link>
					.
				</p>
			</div>

			<ol>
				{milestones.map((milestone) => {
					const inner = (
						<>
							<span
								className={`${MONO} text-[12px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.5)] sm:pt-1.5`}
							>
								{milestone.date}
							</span>
							<span className="min-w-0">
								<span className="block text-[19px] font-normal leading-[1.15] tracking-[-0.02em] text-[#111111]">
									{milestone.title}
								</span>
								<span
									className={`${BODY_TEXT} mt-2 block max-w-[520px] text-[15px] leading-[1.55] text-[rgba(17,17,17,0.72)]`}
								>
									{milestone.body}
								</span>
							</span>
							{milestone.href ? (
								<span className="hidden size-8 place-items-center rounded-full bg-[#EDF1F6] text-[rgba(17,17,17,0.55)] transition-colors duration-200 group-hover:bg-[#111111] group-hover:text-white sm:grid">
									<ArrowUpRight className="size-3.5" />
								</span>
							) : null}
						</>
					);
					const rowClass =
						"group grid gap-2 py-6 sm:grid-cols-[120px_minmax(0,1fr)_auto] sm:items-start sm:gap-6";
					return (
						<li
							key={milestone.title}
							className="border-t border-[#E1E7EE] last:border-b"
						>
							{milestone.href ? (
								<Link
									href={milestone.href}
									target={milestone.external ? "_blank" : undefined}
									rel={milestone.external ? "noopener noreferrer" : undefined}
									className={classNames(
										rowClass,
										"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-4 focus-visible:ring-offset-[#F8FAFC]",
									)}
								>
									{inner}
								</Link>
							) : (
								<div className={rowClass}>{inner}</div>
							)}
						</li>
					);
				})}
			</ol>
		</div>
	</section>
);

const Focus = () => (
	<section className="px-5 pb-20 lg:pb-28">
		<div className="mx-auto max-w-[1200px]">
			<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<figure className="flex flex-col justify-between rounded-[20px] bg-white p-7 shadow-[0_0_0_1px_rgba(17,17,17,0.05)] lg:p-8">
					<blockquote>
						<p
							className={`${BODY_TEXT} text-balance text-[22px] leading-[1.35] text-[#111111] sm:text-[26px]`}
						>
							&ldquo;{quote.content}&rdquo;
						</p>
					</blockquote>
					<figcaption className="mt-8 flex flex-wrap items-center justify-between gap-3">
						<a
							href={quote.url}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-3"
						>
							<Image
								src={quote.image}
								alt=""
								width={32}
								height={32}
								className="size-8 rounded-full object-cover"
							/>
							<span className="text-[14px] font-medium text-[#111111]">
								{quote.name}
							</span>
						</a>
						<span className="rounded-full bg-[#EDF1F6] px-4 py-2 text-[13.5px] text-[rgba(17,17,17,0.55)]">
							{quote.handle}
						</span>
					</figcaption>
				</figure>

				<div className="flex flex-col">
					<h2 className="mb-5 text-[24px] font-normal leading-[1.1] tracking-[-0.02em] text-[#111111]">
						Where we put our energy
					</h2>
					<ul
						className="grid flex-1 grid-cols-1 gap-px overflow-hidden rounded-[20px] sm:grid-cols-2"
						style={grainBg(BAND)}
					>
						{focus.map((item) => (
							<li key={item.label} className="flex flex-col gap-2 p-6">
								<p className="text-[16px] font-medium leading-[1.25] tracking-[-0.02em] text-[#111111]">
									{item.label}
								</p>
								<p
									className={`${BODY_TEXT} text-[14.5px] leading-[1.45] text-[rgba(17,17,17,0.72)]`}
								>
									{item.body}
								</p>
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	</section>
);

const SOCIAL = [
	{ label: "GitHub", href: GITHUB_URL },
	{ label: "Discord", href: DISCORD_URL },
	{ label: "X", href: X_URL },
];

const FinalCta = ({ stars }: { stars: string }) => (
	<section className="px-5 pb-24 pt-4 lg:pb-28 lg:pt-8">
		<div className="mx-auto flex max-w-[900px] flex-col items-center text-center">
			<h2 className={`${H_HERO} text-balance text-[clamp(44px,6.4vw,78px)]`}>
				Build it with us.
			</h2>
			<p
				className={`${BODY_TEXT} mt-7 max-w-[560px] text-balance text-[16.5px] leading-[1.5] text-[rgba(17,17,17,0.78)] sm:text-[18px]`}
			>
				We are building Cap because the tools people use every day should be
				open, honest, and designed to last. If that resonates, try Cap,
				contribute to the project, or follow along as we build in public.
			</p>
			<div className="mt-9 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
				<Link href="/download" className={BTN_PRIMARY}>
					Download Cap
				</Link>
				<GitHubButton stars={stars} className={BTN_SECONDARY} />
			</div>
			<ul className="mt-8 flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
				{SOCIAL.map((item, i) => (
					<li key={item.label} className="flex items-center gap-1">
						{i > 0 ? (
							<span
								aria-hidden="true"
								className="mx-2 size-[3px] rounded-full bg-[rgba(17,17,17,0.25)]"
							/>
						) : null}
						<a
							href={item.href}
							target="_blank"
							rel="noopener noreferrer"
							className={classNames(
								MONO,
								"inline-flex items-center gap-1 text-[11.5px] uppercase leading-none tracking-[0.05em] text-[rgba(17,17,17,0.6)] transition-colors duration-200 hover:text-[#111111]",
							)}
						>
							{item.label}
							<ArrowUpRight className="size-3" />
						</a>
					</li>
				))}
			</ul>
			<p className={`${BODY_TEXT} mt-12 text-[16px] text-[rgba(17,17,17,0.5)]`}>
				The Cap Team
			</p>
		</div>
	</section>
);

export const AboutPage = ({ stars }: { stars: string }) => (
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
				<div className="rounded-[24px] rounded-b-[28px]" style={grainBg(BAND)}>
					<Hero stars={stars} />
				</div>
				<Story />
				<Principles />
				<Milestones />
				<Focus />
				<FinalCta stars={stars} />
			</div>
		</div>
	</div>
);
