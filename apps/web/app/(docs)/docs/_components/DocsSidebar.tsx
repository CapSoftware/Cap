"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { docsConfig, type SidebarGroup } from "../docs-config";

export function DocsSidebar() {
	const pathname = usePathname();

	const isActive = (slug: string) => {
		return pathname === `/docs/${slug}` || pathname === `/docs/${slug}/`;
	};

	return (
		<nav className="sticky top-14 h-[calc(100vh-56px)] w-[260px] shrink-0 overflow-y-auto border-r border-gray-200 px-4 py-6">
			<div className="flex flex-col gap-6">
				{docsConfig.sidebar.map((group: SidebarGroup) => (
					<div key={group.title}>
						<h4 className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
							{group.title}
						</h4>
						<ul className="flex flex-col gap-0.5">
							{group.items.map((item) => {
								const active = isActive(item.slug);
								return (
									<li key={item.slug}>
										<Link
											href={`/docs/${item.slug}`}
											className={`block text-[13px] font-medium py-1.5 px-3 rounded-md transition-colors ${
												active
													? "text-blue-500 bg-blue-50 border-l-2 border-blue-500"
													: "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
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
		</nav>
	);
}
