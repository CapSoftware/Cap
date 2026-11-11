"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { infraAppPath, parseInfraPathname } from "@/lib/infra-routes";
import { infraNavItems } from "./infra-nav-items";

export function InfraMobileNav({ appId }: { appId: string }) {
	const pathname = usePathname();
	const { section } = parseInfraPathname(pathname);

	return (
		<nav
			aria-label="Infra"
			className="flex overflow-x-auto gap-1 -mx-5 px-5 pb-1 lg:hidden"
			style={{ scrollbarWidth: "none" }}
		>
			{infraNavItems.map((item) => {
				const active = section === item.slug;
				const Icon = item.icon;
				return (
					<Link
						key={item.slug || "overview"}
						href={infraAppPath(appId, item.slug)}
						aria-current={active ? "page" : undefined}
						className={clsx(
							"flex gap-1.5 items-center px-3 h-9 text-sm whitespace-nowrap rounded-full border transition-colors shrink-0",
							active
								? "bg-gray-3 border-gray-5 text-gray-12"
								: "border-transparent text-gray-11 hover:text-gray-12",
						)}
					>
						<Icon
							size={15}
							className={active ? "text-gray-12" : "text-gray-10"}
						/>
						{item.name}
					</Link>
				);
			})}
		</nav>
	);
}
