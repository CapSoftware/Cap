"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { docsConfig, type SidebarGroup } from "../docs-config";

export function DocsMobileMenu() {
	const [isOpen, setIsOpen] = useState(false);
	const pathname = usePathname();
	const prevPathname = useRef(pathname);

	useEffect(() => {
		const handleOpen = () => setIsOpen(true);
		window.addEventListener("open-docs-mobile-menu", handleOpen);
		return () =>
			window.removeEventListener("open-docs-mobile-menu", handleOpen);
	}, []);

	useEffect(() => {
		if (prevPathname.current !== pathname) {
			setIsOpen(false);
			prevPathname.current = pathname;
		}
	}, [pathname]);

	useEffect(() => {
		if (isOpen) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "";
		}
		return () => {
			document.body.style.overflow = "";
		};
	}, [isOpen]);

	const isActive = (slug: string) => {
		return pathname === `/docs/${slug}` || pathname === `/docs/${slug}/`;
	};

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-50 lg:hidden">
			<button
				type="button"
				className="absolute inset-0 bg-black/40 cursor-default"
				onClick={() => setIsOpen(false)}
				aria-label="Close menu"
			/>
			<div className="absolute top-0 left-0 bottom-0 w-[280px] bg-white shadow-xl overflow-y-auto">
				<div className="flex items-center justify-between h-14 px-4 border-b border-gray-200">
					<span className="text-sm font-semibold text-gray-900">
						Documentation
					</span>
					<button
						type="button"
						onClick={() => setIsOpen(false)}
						className="flex items-center justify-center w-8 h-8 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
						aria-label="Close menu"
					>
						<X className="w-5 h-5" />
					</button>
				</div>
				<nav className="px-4 py-6">
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
			</div>
		</div>
	);
}
