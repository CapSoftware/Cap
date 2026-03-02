"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import {
	BarChart3,
	Box,
	CreditCard,
	Globe,
	Key,
	Settings,
	Video,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Tooltip } from "@/components/Tooltip";
import { useDashboardContext } from "../../Contexts";
import { EnvironmentBadge } from "./EnvironmentBadge";

const mainNav = [
	{ name: "Apps", href: "/dashboard/developers/apps", icon: Box },
	{ name: "Usage", href: "/dashboard/developers/usage", icon: BarChart3 },
	{
		name: "Credits",
		href: "/dashboard/developers/credits",
		icon: CreditCard,
	},
];

const appNav = [
	{ name: "Settings", href: "settings", icon: Settings },
	{ name: "API Keys", href: "api-keys", icon: Key },
	{ name: "Domains", href: "domains", icon: Globe },
	{ name: "Videos", href: "videos", icon: Video },
];

export function DeveloperSidebarContent() {
	const pathname = usePathname();
	const params = useParams<{ appId?: string }>();
	const { sidebarCollapsed, developerApps } = useDashboardContext();

	const currentApp =
		params.appId && developerApps
			? developerApps.find((a) => a.id === params.appId)
			: null;

	const basePath = params.appId
		? `/dashboard/developers/apps/${params.appId}`
		: null;

	const isActive = (href: string) =>
		pathname === href || pathname.startsWith(`${href}/`);

	return (
		<nav className="flex flex-col justify-between w-full h-full">
			<div
				className={clsx(
					"mt-1",
					sidebarCollapsed ? "flex flex-col justify-center items-center" : "",
				)}
			>
				{mainNav.map((item) => {
					const active = isActive(item.href);
					const Icon = item.icon;
					return (
						<div
							key={item.name}
							className="flex relative justify-center items-center mb-1 w-full"
						>
							{active && (
								<motion.div
									animate={{
										width: sidebarCollapsed ? 36 : "100%",
									}}
									transition={{
										layout: { type: "tween", duration: 0.15 },
										width: { type: "tween", duration: 0.05 },
									}}
									layoutId="devnavlinks"
									className="absolute h-[36px] w-full rounded-xl pointer-events-none bg-gray-3"
								/>
							)}
							<Tooltip
								disable={!sidebarCollapsed}
								content={item.name}
								position="right"
							>
								<Link
									href={item.href}
									prefetch={true}
									className={clsx(
										"relative border border-transparent transition z-3 flex overflow-hidden justify-start items-center tracking-tight rounded-xl outline-none",
										sidebarCollapsed
											? "justify-center px-0 w-full size-9"
											: "px-3 py-2 w-full",
										active
											? "bg-transparent pointer-events-none"
											: "hover:bg-gray-2",
									)}
								>
									<Icon
										size={sidebarCollapsed ? 18 : 16}
										className={clsx(
											sidebarCollapsed
												? "text-gray-12 mx-auto"
												: "text-gray-10",
										)}
									/>
									<span
										className={clsx(
											"text-sm text-gray-12 truncate",
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

				{currentApp && basePath && (
					<>
						<div
							className={clsx(
								"my-3 h-px bg-gray-4",
								sidebarCollapsed ? "mx-2" : "mx-1",
							)}
						/>
						{!sidebarCollapsed && (
							<div className="flex items-center gap-2 px-3 mb-2">
								<span className="text-xs font-medium text-gray-12 truncate">
									{currentApp.name}
								</span>
								<EnvironmentBadge
									environment={currentApp.environment}
									size="xs"
								/>
							</div>
						)}
						{appNav.map((item) => {
							const href = `${basePath}/${item.href}`;
							const active = isActive(href);
							const Icon = item.icon;
							return (
								<div
									key={item.href}
									className="flex relative justify-center items-center mb-1 w-full"
								>
									{active && (
										<motion.div
											animate={{
												width: sidebarCollapsed ? 36 : "100%",
											}}
											transition={{
												layout: {
													type: "tween",
													duration: 0.15,
												},
												width: {
													type: "tween",
													duration: 0.05,
												},
											}}
											layoutId="devappnavlinks"
											className="absolute h-[36px] w-full rounded-xl pointer-events-none bg-gray-3"
										/>
									)}
									<Tooltip
										disable={!sidebarCollapsed}
										content={item.name}
										position="right"
									>
										<Link
											href={href}
											prefetch={true}
											className={clsx(
												"relative border border-transparent transition z-3 flex overflow-hidden justify-start items-center tracking-tight rounded-xl outline-none",
												sidebarCollapsed
													? "justify-center px-0 w-full size-9"
													: "px-3 py-2 w-full",
												active
													? "bg-transparent pointer-events-none"
													: "hover:bg-gray-2",
											)}
										>
											<Icon
												size={sidebarCollapsed ? 18 : 16}
												className={clsx(
													sidebarCollapsed
														? "text-gray-12 mx-auto"
														: "text-gray-10",
												)}
											/>
											<span
												className={clsx(
													"text-sm text-gray-12 truncate",
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
					</>
				)}
			</div>
		</nav>
	);
}
