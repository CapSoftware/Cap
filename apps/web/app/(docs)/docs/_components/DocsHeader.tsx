"use client";

import { Logo } from "@cap/ui";
import { Menu, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

function useIsMac() {
	const [isMac, setIsMac] = useState(true);

	useEffect(() => {
		setIsMac(navigator.platform.toUpperCase().indexOf("MAC") >= 0);
	}, []);

	return isMac;
}

function isTypingTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable
	);
}

export function DocsHeader() {
	const isMac = useIsMac();

	const openSearch = () => {
		window.dispatchEvent(new CustomEvent("open-docs-search"));
	};

	const openMobileMenu = () => {
		window.dispatchEvent(new CustomEvent("open-docs-mobile-menu"));
	};

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				window.dispatchEvent(new CustomEvent("open-docs-search"));
				return;
			}
			if (
				e.key === "/" &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey &&
				!isTypingTarget(e.target)
			) {
				e.preventDefault();
				window.dispatchEvent(new CustomEvent("open-docs-search"));
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	return (
		<header
			className="fixed inset-x-0 top-0 z-50 border-b border-gray-3 bg-gray-1/90 backdrop-blur-md"
			style={{
				paddingRight: "var(--scrollbar-compensation, 0px)",
			}}
		>
			<div className="mx-auto flex h-14 max-w-[1408px] items-center justify-between gap-4 px-4 sm:px-6">
				<div className="flex min-w-0 items-center gap-3">
					<button
						type="button"
						onClick={openMobileMenu}
						className="flex size-8 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 lg:hidden"
						aria-label="Open navigation"
					>
						<Menu className="size-5" />
					</button>
					<Link href="/" className="flex shrink-0 items-center">
						<Logo className="h-5 w-auto" />
					</Link>
					<span aria-hidden="true" className="h-4 w-px rotate-12 bg-gray-6" />
					<Link
						href="/docs"
						className="text-sm font-medium text-gray-12 transition-colors hover:text-gray-11"
					>
						Docs
					</Link>
				</div>

				<button
					type="button"
					onClick={openSearch}
					className="hidden h-9 w-[300px] items-center gap-2.5 rounded-full border border-gray-4 bg-gray-2 px-3.5 text-[13px] text-gray-10 transition-colors hover:border-gray-5 hover:bg-gray-3 md:flex"
				>
					<Search className="size-3.5 shrink-0 text-gray-9" />
					<span className="flex-1 truncate text-left">
						Search or ask a question...
					</span>
					<kbd className="hidden items-center gap-0.5 rounded-md border border-gray-5 bg-gray-1 px-1.5 py-0.5 text-[11px] font-medium text-gray-10 lg:inline-flex">
						{isMac ? "⌘" : "Ctrl"} K
					</kbd>
				</button>

				<div className="flex items-center gap-1.5">
					<button
						type="button"
						onClick={openSearch}
						className="flex size-8 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 md:hidden"
						aria-label="Search or ask a question"
					>
						<Search className="size-4" />
					</button>
					<Link
						href="https://github.com/CapSoftware/Cap"
						target="_blank"
						rel="noopener noreferrer"
						className="flex size-8 items-center justify-center rounded-lg text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12"
						aria-label="Cap on GitHub"
					>
						<svg
							viewBox="0 0 24 24"
							fill="currentColor"
							className="size-[18px]"
							role="img"
							aria-label="GitHub"
						>
							<title>GitHub</title>
							<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
						</svg>
					</Link>
					<Link
						href="/download"
						className="ml-1 hidden h-8 items-center rounded-full bg-gray-12 px-3.5 text-[13px] font-medium text-gray-1 transition-colors hover:bg-gray-11 sm:flex"
					>
						Download
					</Link>
				</div>
			</div>
		</header>
	);
}
