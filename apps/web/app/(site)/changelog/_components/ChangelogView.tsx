import { format, parseISO } from "date-fns";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import {
	CHANGELOG_PLATFORMS,
	type ChangelogEntry,
	type ChangelogPlatform,
	getChangelogPage,
} from "@/utils/changelog";

export const PLATFORM_LABELS: Record<ChangelogPlatform, string> = {
	desktop: "Desktop",
	web: "Web",
	mobile: "Mobile",
	extension: "Extension",
};

const COLLAPSE_THRESHOLD = 600;

function formatPublishedAt(value: string) {
	let date = parseISO(value);
	if (Number.isNaN(date.getTime())) date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : format(date, "MMM d, yyyy");
}

const bodyClass =
	"text-[15px] leading-relaxed text-gray-11 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0";

const markdownComponents: Components = {
	h1: (props) => (
		<h3 className="mt-7 mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-9">
			{props.children}
		</h3>
	),
	h2: (props) => (
		<h3 className="mt-7 mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-9">
			{props.children}
		</h3>
	),
	h3: (props) => (
		<h4 className="mt-5 mb-2 text-[13px] font-medium text-gray-12">
			{props.children}
		</h4>
	),
	p: (props) => <p className="my-3">{props.children}</p>,
	ul: (props) => (
		<ul className="my-3 list-disc space-y-2 pl-5 marker:text-gray-7">
			{props.children}
		</ul>
	),
	ol: (props) => (
		<ol className="my-3 list-decimal space-y-2 pl-5 marker:text-gray-7">
			{props.children}
		</ol>
	),
	li: (props) => <li className="pl-1 [&>p]:my-0">{props.children}</li>,
	strong: (props) => (
		<strong className="font-medium text-gray-12">{props.children}</strong>
	),
	a: (props) => (
		<a
			href={props.href}
			target="_blank"
			rel="noreferrer"
			className="text-gray-12 underline decoration-gray-7 underline-offset-2 transition-colors hover:decoration-gray-12"
		>
			{props.children}
		</a>
	),
	code: (props) => (
		<code className="rounded bg-gray-3 px-1 py-0.5 font-mono text-[13px] text-gray-12">
			{props.children}
		</code>
	),
	img: (props) => (
		<img
			src={typeof props.src === "string" ? props.src : undefined}
			alt={props.alt ?? ""}
			loading="lazy"
			className="my-4 w-full rounded-lg border border-gray-4"
		/>
	),
	hr: () => <hr className="my-6 border-gray-4" />,
};

function EntryBody({
	content,
	className,
}: {
	content: string;
	className?: string;
}) {
	return (
		<div className={className ? `${bodyClass} ${className}` : bodyClass}>
			<ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
		</div>
	);
}

function Entry({ entry }: { entry: ChangelogEntry }) {
	const { platform, slug, metadata, intro, details } = entry;
	const id = `${platform}-${slug}`;
	const collapsible = details.length > COLLAPSE_THRESHOLD;

	return (
		<article
			id={id}
			className="grid scroll-mt-32 gap-3 border-t border-gray-4 py-10 [contain-intrinsic-size:auto_400px] [content-visibility:auto] md:grid-cols-[10rem_1fr] md:gap-0 md:py-12"
		>
			<div className="md:sticky md:top-32 md:self-start">
				<a
					href={`#${id}`}
					className="text-[13px] tabular-nums text-gray-9 transition-colors hover:text-gray-12"
				>
					<time dateTime={metadata.publishedAt}>
						{formatPublishedAt(metadata.publishedAt)}
					</time>
				</a>
			</div>
			<div className="min-w-0 max-w-[42rem]">
				<div className="flex flex-wrap items-center gap-2">
					<span className="rounded-full border border-gray-5 px-2 py-px text-[11px] font-medium text-gray-11">
						{PLATFORM_LABELS[platform]}
					</span>
					{metadata.version && (
						<span className="font-mono text-[12px] text-gray-9">
							{metadata.version}
						</span>
					)}
				</div>
				<h2 className="mt-3 text-lg font-medium tracking-tight text-gray-12">
					{metadata.title}
				</h2>
				{intro && <EntryBody content={intro} className="mt-2" />}
				{details &&
					(collapsible ? (
						<details className="group mt-3">
							<summary className="flex w-fit cursor-pointer select-none list-none items-center gap-1.5 text-[13px] font-medium text-gray-10 transition-colors hover:text-gray-12 [&::-webkit-details-marker]:hidden">
								<svg
									aria-hidden="true"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="size-3.5 text-gray-8 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
								>
									<path d="m9 18 6-6-6-6" />
								</svg>
								<span className="group-open:hidden">Show release notes</span>
								<span className="hidden group-open:inline">
									Hide release notes
								</span>
							</summary>
							<EntryBody content={details} className="mt-3" />
						</details>
					) : (
						<EntryBody content={details} className="mt-2" />
					))}
			</div>
		</article>
	);
}

function FilterTabs({ active }: { active?: ChangelogPlatform }) {
	const tabs = [
		{ href: "/changelog", label: "All", value: undefined },
		...CHANGELOG_PLATFORMS.map((platform) => ({
			href: `/changelog/${platform}`,
			label: PLATFORM_LABELS[platform],
			value: platform,
		})),
	];

	return (
		<nav
			aria-label="Filter updates by platform"
			className="mt-8 flex flex-wrap gap-1"
		>
			{tabs.map((tab) => {
				const isActive = tab.value === active;
				return (
					<Link
						key={tab.label}
						href={tab.href}
						aria-current={isActive ? "page" : undefined}
						className={
							isActive
								? "rounded-full bg-gray-12 px-3 py-1 text-[13px] font-medium text-gray-1"
								: "rounded-full px-3 py-1 text-[13px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
						}
					>
						{tab.label}
					</Link>
				);
			})}
		</nav>
	);
}

export function changelogPageHref(page: number, platform?: ChangelogPlatform) {
	const base = platform ? `/changelog/${platform}` : "/changelog";
	return page <= 1 ? base : `${base}/page/${page}`;
}

type PaginationItem = number | "gap";

function paginationRange(page: number, pageCount: number): PaginationItem[] {
	if (pageCount <= 7) {
		return Array.from({ length: pageCount }, (_, i) => i + 1);
	}
	const pages = new Set<number>([1, pageCount]);
	for (let n = page - 1; n <= page + 1; n++) {
		if (n >= 1 && n <= pageCount) pages.add(n);
	}
	const sorted = [...pages].sort((a, b) => a - b);
	const items: PaginationItem[] = [];
	let prev = 0;
	for (const n of sorted) {
		if (n - prev === 2) items.push(prev + 1);
		else if (n - prev > 2) items.push("gap");
		items.push(n);
		prev = n;
	}
	return items;
}

const paginationArrowClass =
	"flex items-center gap-1.5 text-[13px] font-medium transition-colors";

function PaginationArrow({
	direction,
	href,
}: {
	direction: "newer" | "older";
	href?: string;
}) {
	const label = direction === "newer" ? "Newer" : "Older";
	const chevron = (
		<svg
			aria-hidden="true"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className="size-3.5"
		>
			{direction === "newer" ? (
				<path d="m15 18-6-6 6-6" />
			) : (
				<path d="m9 18 6-6-6-6" />
			)}
		</svg>
	);

	if (!href) {
		return (
			<span
				aria-disabled="true"
				className={`${paginationArrowClass} cursor-default text-gray-6`}
			>
				{direction === "newer" && chevron}
				{label}
				{direction === "older" && chevron}
			</span>
		);
	}

	return (
		<Link
			href={href}
			rel={direction === "newer" ? "prev" : "next"}
			className={`${paginationArrowClass} text-gray-10 hover:text-gray-12`}
		>
			{direction === "newer" && chevron}
			{label}
			{direction === "older" && chevron}
		</Link>
	);
}

function Pagination({
	page,
	pageCount,
	platform,
}: {
	page: number;
	pageCount: number;
	platform?: ChangelogPlatform;
}) {
	if (pageCount <= 1) return null;

	return (
		<nav
			aria-label="Changelog pages"
			className="mt-4 flex items-center justify-between gap-4 border-t border-gray-4 pt-6"
		>
			<PaginationArrow
				direction="newer"
				href={page > 1 ? changelogPageHref(page - 1, platform) : undefined}
			/>
			<div className="flex items-center gap-1">
				{paginationRange(page, pageCount).map((item, index) =>
					item === "gap" ? (
						<span
							key={`gap-${
								// biome-ignore lint/suspicious/noArrayIndexKey: gaps are positional
								index
							}`}
							aria-hidden="true"
							className="px-1 text-[13px] text-gray-8"
						>
							&hellip;
						</span>
					) : (
						<Link
							key={item}
							href={changelogPageHref(item, platform)}
							aria-label={`Page ${item}`}
							aria-current={item === page ? "page" : undefined}
							className={
								item === page
									? "grid size-8 place-items-center rounded-full bg-gray-12 text-[13px] font-medium tabular-nums text-gray-1"
									: "grid size-8 place-items-center rounded-full text-[13px] font-medium tabular-nums text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
							}
						>
							{item}
						</Link>
					),
				)}
			</div>
			<PaginationArrow
				direction="older"
				href={
					page < pageCount ? changelogPageHref(page + 1, platform) : undefined
				}
			/>
		</nav>
	);
}

export function ChangelogView({
	platform,
	page = 1,
}: {
	platform?: ChangelogPlatform;
	page?: number;
}) {
	const data = getChangelogPage(page, platform);
	if (!data) notFound();
	const { entries: visible, pageCount } = data;

	return (
		<main className="wrapper pt-28 pb-28 md:pt-36">
			<div className="mx-auto w-full max-w-[56rem]">
				<header>
					<h1 className="text-3xl font-medium tracking-tight text-gray-12">
						Changelog
					</h1>
					<p className="mt-3 max-w-md text-[15px] leading-relaxed text-gray-10">
						New features, improvements, and fixes across the Cap desktop app,
						web, mobile, and browser extension.
					</p>
					<FilterTabs active={platform} />
				</header>
				{visible.length > 0 ? (
					<div className="mt-10 md:mt-14">
						{visible.map((entry) => (
							<Entry key={`${entry.platform}-${entry.slug}`} entry={entry} />
						))}
					</div>
				) : (
					<div className="mt-10 border-t border-gray-4 py-14 md:mt-14 md:grid md:grid-cols-[10rem_1fr]">
						<div className="hidden md:block" />
						<p className="text-[15px] text-gray-10">
							No {platform ? PLATFORM_LABELS[platform].toLowerCase() : ""}{" "}
							updates yet. New releases will appear here as they ship.
						</p>
					</div>
				)}
				<Pagination page={page} pageCount={pageCount} platform={platform} />
			</div>
		</main>
	);
}
