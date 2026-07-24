"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docsConfig, type SidebarGroup } from "../docs-config";

export function DocsSidebarNav() {
	const pathname = usePathname();

	const isActive = (slug: string) =>
		pathname === `/docs/${slug}` || pathname === `/docs/${slug}/`;

	return (
		<div className="flex flex-col gap-7">
			{docsConfig.sidebar.map((group: SidebarGroup) => (
				<div key={group.title}>
					<p className="mb-2 text-[13px] font-medium leading-5 text-gray-12">
						{group.title}
					</p>
					<ul>
						{group.items.map((item) => {
							const active = isActive(item.slug);
							return (
								<li key={item.slug}>
									<Link
										href={`/docs/${item.slug}`}
										aria-current={active ? "page" : undefined}
										className={`block border-l py-[7px] pl-4 text-[13px] leading-5 transition-colors ${
											active
												? "border-blue-9 font-medium text-blue-11"
												: "border-gray-4 text-gray-11 hover:border-gray-8 hover:text-gray-12"
										}`}
									>
										{item.title}
									</Link>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</div>
	);
}
