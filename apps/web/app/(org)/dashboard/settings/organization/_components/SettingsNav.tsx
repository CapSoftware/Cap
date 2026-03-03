"use client";

import { buildEnv } from "@cap/env";
import clsx from "clsx";
import { motion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function SettingsNav() {
	const pathname = usePathname();
	const tabs = [
		{ label: "General", href: "/dashboard/settings/organization" },
		{
			label: "Preferences",
			href: "/dashboard/settings/organization/preferences",
		},
		{
			label: buildEnv.NEXT_PUBLIC_IS_CAP ? "Billing & Members" : "Members",
			href: "/dashboard/settings/organization/billing",
		},
	] as const;

	return (
		<div className="flex gap-4 items-center border-b border-gray-4">
			{tabs.map((tab) => {
				const isActive = pathname === tab.href;

				return (
					<div key={tab.href} className="relative min-w-fit">
						<Link
							href={tab.href}
							className="flex relative items-center py-3 cursor-pointer group"
						>
							<p
								className={clsx(
									"text-[13px] transition-colors",
									isActive
										? "text-gray-12"
										: "text-gray-10 group-hover:text-gray-11",
								)}
							>
								{tab.label}
							</p>
						</Link>
						{isActive && (
							<motion.div
								layoutId="org-settings-tab"
								className="absolute right-0 bottom-0 w-full h-px rounded-full bg-gray-12"
								transition={{ ease: "easeOut", duration: 0.2 }}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}
