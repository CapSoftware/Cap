"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { BookOpen, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Tooltip } from "@/components/Tooltip";
import { infraAppPath, parseInfraPathname } from "@/lib/infra-routes";
import { formatCredits } from "@/lib/infra-usage";
import { useDashboardContext } from "../../Contexts";
import { InfraAppSwitcher } from "./infra-app-switcher";
import { infraNavItems } from "./infra-nav-items";

const itemClass = (collapsed: boolean, active: boolean) =>
	clsx(
		"relative flex overflow-hidden items-center tracking-tight rounded-xl border border-transparent transition outline-none z-3 focus-visible:ring-2 focus-visible:ring-gray-8",
		collapsed
			? "justify-center px-0 w-full size-9"
			: "justify-start px-3 py-2 w-full",
		active ? "bg-transparent" : "hover:bg-gray-2",
	);

export function InfraSidebar() {
	const pathname = usePathname();
	const { sidebarCollapsed, infraApps } = useDashboardContext();
	const { appId, section } = parseInfraPathname(pathname);
	const app = infraApps?.find((a) => a.id === appId) ?? null;

	return (
		<nav aria-label="Infra" className="flex flex-col w-full h-full min-h-0">
			{app && (
				<div className="pt-1.5 shrink-0">
					<InfraAppSwitcher collapsed={sidebarCollapsed} />
				</div>
			)}
			<div
				className={clsx(
					"overflow-y-auto flex-1 pt-5 min-h-0",
					sidebarCollapsed && "flex flex-col items-center",
				)}
				style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
			>
				{app &&
					infraNavItems.map((item) => {
						const active = section === item.slug;
						const Icon = item.icon;
						return (
							<div
								key={item.slug || "overview"}
								className="flex relative justify-center items-center mb-1.5 w-full"
							>
								{active && (
									<motion.div
										animate={{ width: sidebarCollapsed ? 36 : "100%" }}
										transition={{
											layout: { type: "tween", duration: 0.15 },
											width: { type: "tween", duration: 0.05 },
										}}
										layoutId="infranavlinks"
										className="absolute h-[36px] w-full rounded-xl pointer-events-none bg-gray-3"
									/>
								)}
								<Tooltip
									disable={!sidebarCollapsed}
									content={item.name}
									position="right"
								>
									<Link
										href={infraAppPath(app.id, item.slug)}
										prefetch
										aria-current={active ? "page" : undefined}
										className={itemClass(sidebarCollapsed, active)}
									>
										<Icon
											size={sidebarCollapsed ? 18 : 16}
											className={
												sidebarCollapsed
													? "mx-auto text-gray-12"
													: "text-gray-10"
											}
										/>
										<span
											className={clsx(
												"text-sm truncate text-gray-12",
												sidebarCollapsed ? "hidden" : "ml-2.5",
											)}
										>
											{item.name}
										</span>
									</Link>
								</Tooltip>
							</div>
						);
					})}
			</div>
			<div
				className={clsx(
					"flex flex-col gap-1 pt-2 pb-4 w-full shrink-0",
					sidebarCollapsed && "items-center",
				)}
			>
				<Tooltip disable={!sidebarCollapsed} content="Docs" position="right">
					<Link href="/docs" className={itemClass(sidebarCollapsed, false)}>
						<BookOpen
							size={sidebarCollapsed ? 18 : 16}
							className={
								sidebarCollapsed ? "mx-auto text-gray-12" : "text-gray-10"
							}
						/>
						<span
							className={clsx(
								"text-sm truncate text-gray-12",
								sidebarCollapsed ? "hidden" : "ml-2.5",
							)}
						>
							Docs
						</span>
					</Link>
				</Tooltip>
				{app && (
					<Tooltip
						disable={!sidebarCollapsed}
						content={`${formatCredits(app.balanceMicroCredits)} in credits`}
						position="right"
					>
						<Link
							href={infraAppPath(app.id, "billing")}
							className={clsx(
								"flex items-center text-xs rounded-lg transition-colors text-gray-10 hover:text-gray-12 outline-none focus-visible:ring-2 focus-visible:ring-gray-8",
								sidebarCollapsed ? "justify-center size-9" : "px-3 py-1.5",
							)}
						>
							{sidebarCollapsed ? (
								<Wallet size={16} />
							) : (
								<span className="truncate tabular-nums">
									{formatCredits(app.balanceMicroCredits)} in credits
								</span>
							)}
						</Link>
					</Tooltip>
				)}
			</div>
		</nav>
	);
}
