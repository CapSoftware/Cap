"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
import { FOCUS, LIT, MONO } from "./ui";

export function Brand() {
	return (
		<Link
			href={INFRA_BASE_PATH}
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
	const { section } = parseInfraPathname(pathname);
	const current = apps.find((app) => app.id === appId) ?? null;

	return (
		<>
			<aside className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-[rgba(222,230,246,0.08)] px-4 pb-5 pt-5 lg:flex">
				<div className="px-2">
					<Brand />
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
						<Link href="/docs/api/rest-api" className={QUIET_LINK}>
							Docs
						</Link>
						<Link href="/dashboard/caps" className={QUIET_LINK}>
							Back to Cap
						</Link>
					</div>
				</div>
			</aside>

			<header className="sticky top-0 z-40 border-b border-[rgba(222,230,246,0.08)] bg-[rgba(5,5,6,0.82)] backdrop-blur-xl lg:hidden">
				<div className="flex h-14 items-center justify-between gap-3 px-4">
					<Brand />
					<AppSwitcher apps={apps} appId={appId} compact />
				</div>
				<nav
					aria-label="App"
					className="flex gap-1 overflow-x-auto px-2 [scrollbar-width:none]"
				>
					{INFRA_SECTIONS.map((item) => {
						const active = section === item.slug;
						return (
							<Link
								key={item.slug}
								href={infraAppPath(appId, item.slug)}
								aria-current={active ? "page" : undefined}
								className={clsx(
									"relative flex h-10 shrink-0 items-center px-2.5 text-[13.5px] transition-colors duration-200",
									active ? "text-white" : "text-[rgba(232,236,244,0.56)]",
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

			<div className="lg:pl-[236px]">
				<div className="mx-auto flex w-full max-w-[1088px] flex-col gap-11 px-5 pb-24 pt-9 sm:px-10 lg:pt-14 [&>*]:min-w-0">
					{children}
				</div>
			</div>
		</>
	);
}
