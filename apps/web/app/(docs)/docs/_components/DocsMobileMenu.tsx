"use client";

import { Logo } from "@cap/ui";
import { X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DocsSidebarNav } from "./DocsSidebarNav";

export function DocsMobileMenu() {
	const [isOpen, setIsOpen] = useState(false);
	const [isAnimating, setIsAnimating] = useState(false);
	const pathname = usePathname();

	useEffect(() => {
		const handleOpen = () => {
			setIsOpen(true);
			requestAnimationFrame(() => setIsAnimating(true));
		};
		window.addEventListener("open-docs-mobile-menu", handleOpen);
		return () =>
			window.removeEventListener("open-docs-mobile-menu", handleOpen);
	}, []);

	const close = () => {
		setIsAnimating(false);
		setTimeout(() => setIsOpen(false), 200);
	};

	const prevPathname = useRef(pathname);
	useEffect(() => {
		if (prevPathname.current !== pathname) {
			prevPathname.current = pathname;
			setIsAnimating(false);
			setIsOpen(false);
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

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-[60] lg:hidden">
			<button
				type="button"
				className={`absolute inset-0 cursor-default bg-black-transparent-40 transition-opacity duration-200 ${
					isAnimating ? "opacity-100" : "opacity-0"
				}`}
				onClick={close}
				aria-label="Close navigation"
				tabIndex={-1}
			/>
			<div
				className={`absolute inset-y-0 left-0 w-[300px] overflow-y-auto border-r border-gray-3 bg-gray-1 shadow-xl transition-transform duration-200 ease-out ${
					isAnimating ? "translate-x-0" : "-translate-x-full"
				}`}
				role="dialog"
				aria-modal="true"
				aria-label="Documentation navigation"
			>
				<div className="sticky top-0 flex h-14 items-center justify-between border-b border-gray-3 bg-gray-1 px-5">
					<Logo className="h-5 w-auto" />
					<button
						type="button"
						onClick={close}
						className="flex size-8 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12"
						aria-label="Close navigation"
					>
						<X className="size-5" />
					</button>
				</div>
				<nav aria-label="Documentation" className="px-5 py-6">
					<DocsSidebarNav />
				</nav>
			</div>
		</div>
	);
}
