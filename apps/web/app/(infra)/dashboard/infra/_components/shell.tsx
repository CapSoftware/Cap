"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Lockup } from "@/components/infra/Lockup";
import {
	INFRA_BASE_PATH,
	INFRA_SECTIONS,
	infraAppPath,
	parseInfraPathname,
} from "@/lib/infra-routes";
import { formatCredits } from "@/lib/infra-usage";
import type { InfraAppSummary } from "../infra-data";
import { AppSwitcher } from "./app-switcher";
import { FOCUS, FOCUS_INSET, LIT, MONO } from "./ui";
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
	"rounded-[6px] text-[13px] text-[rgba(232,236,244,0.5)] transition-colors duration-200 hover:text-[#E8ECF4]",
	FOCUS,
);

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
			<aside className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-[rgba(222,230,246,0.08)] px-4 pb-5 pt-5 lg:flex">
				<div className="px-2">
					<Brand
						href={infraAppPath(appId)}
						onNavigate={section === "" ? undefined : askBeforeLeavingPage}
					/>
				</div>
				<div className="mt-6">
					<AppSwitcher apps={apps} appId={appId} />
				</div>
				<nav aria-label="App" className="mt-5 flex flex-col gap-px">
					{INFRA_SECTIONS.map((item) => {
						const active = section === item.slug;
						return (
							<Link
								key={item.slug}
								href={infraAppPath(appId, item.slug)}
								onNavigate={active ? undefined : askBeforeLeavingPage}
								aria-current={active ? "page" : undefined}
								className={clsx(
									"relative flex h-[34px] items-center rounded-[8px] px-3 text-[14px] transition-colors duration-200",
									active
										? "text-white"
										: "text-[rgba(232,236,244,0.56)] hover:bg-[rgba(222,230,246,0.04)] hover:text-[#E8ECF4]",
									FOCUS,
								)}
							>
								{active && (
									<span
										aria-hidden="true"
										className={clsx(
											"absolute -left-4 top-1/2 h-[18px] w-[2px] -translate-y-1/2 rounded-full",
											LIT,
										)}
									/>
								)}
								{item.name}
							</Link>
						);
					})}
				</nav>
				<div className="mt-auto px-3">
					{current && (
						<div className="border-t border-[rgba(222,230,246,0.08)] pb-5 pt-4">
							<p className="m-0 text-[12.5px] text-[rgba(232,236,244,0.42)]">
								Credit balance
							</p>
							<p
								className={clsx(
									MONO,
									"m-0 mt-2 text-[20px] leading-none tracking-[-0.04em] tabular-nums text-white",
								)}
							>
								{formatCredits(current.balanceMicroCredits)}
							</p>
							<Link
								href={infraAppPath(appId, "billing")}
								className={clsx(QUIET_LINK, "mt-3 inline-block")}
							>
								Add credits
							</Link>
						</div>
					)}
					<div className="flex items-center justify-between border-t border-[rgba(222,230,246,0.08)] pt-4">
						<Link
							href="/docs/api/rest-api"
							onNavigate={askBeforeLeaving}
							className={QUIET_LINK}
						>
							Docs
						</Link>
						<Link
							href="/dashboard/caps"
							onNavigate={askBeforeLeaving}
							className={QUIET_LINK}
						>
							Back to Cap
						</Link>
					</div>
				</div>
			</aside>

			<header className="sticky top-0 z-40 border-b border-[rgba(222,230,246,0.08)] bg-[rgba(5,5,6,0.82)] backdrop-blur-xl lg:hidden">
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
									active ? "text-white" : "text-[rgba(232,236,244,0.56)]",
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
				className="focus:outline-none lg:pl-[236px]"
			>
				<div className="mx-auto flex w-full max-w-[1088px] flex-col gap-11 px-5 pb-24 pt-9 sm:px-10 lg:pt-14 [&>*]:min-w-0">
					{children}
				</div>
			</div>
		</>
	);
}
