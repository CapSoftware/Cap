"use client";

import clsx from "clsx";
import {
	ArrowLeft,
	AudioLines,
	BookOpen,
	ChartNoAxesColumn,
	Clapperboard,
	CreditCard,
	KeyRound,
	LayoutGrid,
	type LucideIcon,
	Plus,
	Settings2,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Lockup } from "@/components/infra/Lockup";
import {
	INFRA_BASE_PATH,
	INFRA_SECTIONS,
	type InfraSection,
	infraAppPath,
	parseInfraPathname,
} from "@/lib/infra-routes";
import { formatCredits } from "@/lib/infra-usage";
import type { InfraAppSummary } from "../infra-data";
import { AppSwitcher } from "./app-switcher";
import { FOCUS, FOCUS_INSET, LIT, MONO, SURFACE } from "./ui";
import { useMayLeave, useMayLeavePage } from "./uploads";

type Navigation = { preventDefault: () => void };

export function Brand({
	href = INFRA_BASE_PATH,
	onNavigate,
}: {
	href?: string;
	onNavigate?: (event: Navigation) => void;
}) {
	return (
		<Link
			href={href}
			onNavigate={onNavigate}
			className={clsx("flex shrink-0 items-center rounded-[6px]", FOCUS)}
		>
			<Lockup height={22} />
		</Link>
	);
}

const QUIET_LINK = clsx(
	"inline-flex items-center gap-1.5 rounded-[6px] text-[13px] text-[rgba(232,236,244,0.56)] transition-colors duration-200 hover:text-[#E8ECF4]",
	FOCUS,
);

const SECTION_ICONS: Record<InfraSection, LucideIcon> = {
	"": LayoutGrid,
	videos: Clapperboard,
	audio: AudioLines,
	usage: ChartNoAxesColumn,
	billing: CreditCard,
	keys: KeyRound,
	settings: Settings2,
};

const ACCOUNT_SECTIONS = new Set<InfraSection>(["billing", "keys", "settings"]);

export function Shell({
	apps,
	appId,
	children,
}: {
	apps: InfraAppSummary[];
	appId: string;
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	const mayLeave = useMayLeave();
	const mayLeavePage = useMayLeavePage();
	const askBeforeLeaving = (event: Navigation) => {
		if (!mayLeave()) event.preventDefault();
	};
	const askBeforeLeavingPage = (event: Navigation) => {
		if (!mayLeavePage()) event.preventDefault();
	};
	const { section } = parseInfraPathname(pathname);
	const current = apps.find((app) => app.id === appId) ?? null;
	const contentId = useId();
	const tabs = useRef<HTMLElement>(null);
	const [tabsBeyond, setTabsBeyond] = useState({ left: false, right: false });

	const measureTabs = useCallback(() => {
		const strip = tabs.current;
		if (!strip) return;
		const left = strip.scrollLeft > 4;
		const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 4;
		setTabsBeyond((current) =>
			current.left === left && current.right === right
				? current
				: { left, right },
		);
	}, []);

	useEffect(() => {
		const strip = tabs.current;
		if (!strip) return;
		const active = strip.querySelector<HTMLElement>(
			`[data-section="${section ?? ""}"]`,
		);
		if (active && section !== null) {
			strip.scrollLeft = Math.max(
				0,
				active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2,
			);
		}
		measureTabs();
		window.addEventListener("resize", measureTabs);
		return () => window.removeEventListener("resize", measureTabs);
	}, [section, measureTabs]);

	return (
		<>
			<a
				href={`#${contentId}`}
				className={clsx(
					"sr-only z-50 rounded-[8px] bg-[#E8ECF4] px-3 py-2 text-[13.5px] font-medium text-[#050506] focus:not-sr-only focus:fixed focus:left-3 focus:top-3",
					FOCUS,
				)}
			>
				Skip to content
			</a>
			<aside
				className={clsx(
					"fixed inset-y-3 left-3 z-40 hidden w-[240px] flex-col overflow-y-auto overscroll-contain rounded-[16px] [scrollbar-width:none] bg-[rgba(12,13,16,0.72)] backdrop-blur-xl lg:flex",
					SURFACE,
				)}
			>
				<div className="px-5 pt-5">
					<Brand
						href={infraAppPath(appId)}
						onNavigate={section === "" ? undefined : askBeforeLeavingPage}
					/>
				</div>
				<div className="mt-5 px-3">
					<AppSwitcher apps={apps} appId={appId} />
				</div>
				<nav aria-label="App" className="mt-4 flex flex-col gap-0.5 px-3">
					{INFRA_SECTIONS.map((item, index) => {
						const active = section === item.slug;
						const Icon = SECTION_ICONS[item.slug];
						const startsGroup =
							index > 0 &&
							ACCOUNT_SECTIONS.has(item.slug) &&
							!ACCOUNT_SECTIONS.has(INFRA_SECTIONS[index - 1]?.slug ?? "");
						return (
							<div key={item.slug} className="contents">
								{startsGroup && (
									<span
										aria-hidden="true"
										className="mx-2.5 my-2 h-px bg-[rgba(222,230,246,0.07)]"
									/>
								)}
								<Link
									href={infraAppPath(appId, item.slug)}
									onNavigate={active ? undefined : askBeforeLeavingPage}
									aria-current={active ? "page" : undefined}
									className={clsx(
										"group relative flex h-9 items-center gap-3 rounded-[9px] px-2.5 text-[13.5px] transition-[background-color,color,box-shadow] duration-200",
										active
											? "bg-[rgba(222,230,246,0.075)] text-white shadow-[inset_0_0_0_1px_rgba(222,230,246,0.08)]"
											: "text-[rgba(232,236,244,0.66)] hover:bg-[rgba(222,230,246,0.045)] hover:text-[#E8ECF4]",
										FOCUS,
									)}
								>
									<Icon
										size={16}
										strokeWidth={1.75}
										aria-hidden="true"
										className={clsx(
											"shrink-0 transition-colors duration-200",
											active
												? "text-white [filter:drop-shadow(0_0_6px_rgba(214,228,255,0.55))]"
												: "text-[rgba(232,236,244,0.46)] group-hover:text-[rgba(232,236,244,0.8)]",
										)}
									/>
									{item.name}
								</Link>
							</div>
						);
					})}
				</nav>
				<div className="mt-auto flex flex-col gap-3 px-3 pb-3">
					{current && (
						<div className="relative overflow-hidden rounded-[12px] bg-[#08090B] shadow-[inset_0_0_0_1px_rgba(222,230,246,0.09)]">
							<div className="relative px-4 pt-3.5">
								<div className="flex items-center justify-between gap-2">
									<p className="m-0 text-[12.5px] text-[rgba(232,236,244,0.56)]">
										Credit balance
									</p>
									<Link
										href={infraAppPath(appId, "billing")}
										className={clsx(
											"-mr-1.5 inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[12.5px] text-[rgba(232,236,244,0.72)] transition-colors duration-200 hover:bg-[rgba(222,230,246,0.06)] hover:text-white",
											FOCUS,
										)}
									>
										<Plus size={13} aria-hidden="true" />
										Add
										<span className="sr-only"> credits</span>
									</Link>
								</div>
								<p
									className={clsx(
										MONO,
										"m-0 mt-1.5 text-[21px] leading-[1.1] tracking-[-0.04em] tabular-nums text-white [overflow-wrap:anywhere]",
									)}
								>
									{formatCredits(current.balanceMicroCredits)}
								</p>
							</div>
							<div
								aria-hidden="true"
								className="relative h-[60px] overflow-hidden"
							>
								<picture>
									<source type="image/avif" srcSet="/infra/night-1280.avif" />
									<img
										src="/infra/night-1280.webp"
										width={1280}
										height={384}
										alt=""
										loading="lazy"
										decoding="async"
										className="pointer-events-none absolute left-1/2 top-[-52px] h-[168px] w-auto max-w-none -translate-x-1/2 select-none opacity-80 [mask-image:linear-gradient(to_bottom,transparent_30%,#000_55%)]"
									/>
								</picture>
							</div>
						</div>
					)}
					<div className="flex items-center justify-between px-2 pb-1">
						<Link
							href="/docs/api/rest-api"
							onNavigate={askBeforeLeaving}
							className={QUIET_LINK}
						>
							<BookOpen size={14} strokeWidth={1.75} aria-hidden="true" />
							Docs
						</Link>
						<Link
							href="/dashboard/caps"
							onNavigate={askBeforeLeaving}
							className={QUIET_LINK}
						>
							<ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
							Back to Cap
						</Link>
					</div>
				</div>
			</aside>

			<header className="sticky top-0 z-40 border-b border-[rgba(222,230,246,0.08)] bg-[rgba(10,11,13,0.8)] backdrop-blur-xl lg:hidden">
				<div className="flex h-14 items-center justify-between gap-3 px-4">
					<Brand
						href={infraAppPath(appId)}
						onNavigate={section === "" ? undefined : askBeforeLeavingPage}
					/>
					<AppSwitcher apps={apps} appId={appId} compact />
				</div>
				<nav
					ref={tabs}
					aria-label="App"
					onScroll={measureTabs}
					className={clsx(
						"flex gap-1 overflow-x-auto px-2 [scrollbar-width:none]",
						tabsBeyond.left &&
							tabsBeyond.right &&
							"[mask-image:linear-gradient(to_right,transparent,#000_44px,#000_calc(100%-44px),transparent)]",
						tabsBeyond.left &&
							!tabsBeyond.right &&
							"[mask-image:linear-gradient(to_right,transparent,#000_44px)]",
						!tabsBeyond.left &&
							tabsBeyond.right &&
							"[mask-image:linear-gradient(to_right,#000_calc(100%-44px),transparent)]",
					)}
				>
					{INFRA_SECTIONS.map((item) => {
						const active = section === item.slug;
						return (
							<Link
								key={item.slug}
								href={infraAppPath(appId, item.slug)}
								data-section={item.slug}
								onNavigate={active ? undefined : askBeforeLeavingPage}
								aria-current={active ? "page" : undefined}
								className={clsx(
									"relative flex h-10 shrink-0 items-center rounded-[6px] px-2.5 text-[13.5px] transition-colors duration-200",
									active ? "text-white" : "text-[rgba(232,236,244,0.62)]",
									FOCUS_INSET,
								)}
							>
								{item.name}
								{active && (
									<span
										aria-hidden="true"
										className={clsx(
											"absolute inset-x-2.5 bottom-0 h-[2px] rounded-full",
											LIT,
										)}
									/>
								)}
							</Link>
						);
					})}
				</nav>
			</header>

			<div
				id={contentId}
				tabIndex={-1}
				className="focus:outline-none lg:pl-[252px]"
			>
				<div className="mx-auto flex w-full max-w-[1120px] flex-col gap-10 px-5 pb-24 pt-9 sm:px-10 lg:pt-14 [&>*]:min-w-0">
					{children}
				</div>
			</div>
		</>
	);
}
