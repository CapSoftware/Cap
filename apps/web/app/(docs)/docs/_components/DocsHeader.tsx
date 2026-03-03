"use client";

import { Logo } from "@cap/ui";
import { ExternalLink, Menu, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

function useOS() {
	const [isMac, setIsMac] = useState(true);

	useEffect(() => {
		setIsMac(navigator.platform.toUpperCase().indexOf("MAC") >= 0);
	}, []);

	return { isMac };
}

export function DocsHeader() {
	const { isMac } = useOS();

	const handleSearchClick = () => {
		window.dispatchEvent(new CustomEvent("open-docs-search"));
	};

	const handleMobileMenuClick = () => {
		window.dispatchEvent(new CustomEvent("open-docs-mobile-menu"));
	};

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				window.dispatchEvent(new CustomEvent("open-docs-search"));
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	return (
		<header
			className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between h-14 px-4 bg-white border-b border-gray-200"
			style={{
				paddingRight: "calc(1rem + var(--scrollbar-compensation, 0px))",
			}}
		>
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={handleMobileMenuClick}
					className="lg:hidden flex items-center justify-center w-8 h-8 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
					aria-label="Open menu"
				>
					<Menu className="w-5 h-5" />
				</button>
				<Link href="/" className="flex items-center">
					<Logo className="h-5 w-auto" />
				</Link>
				<span className="text-sm font-semibold text-gray-400">/</span>
				<Link
					href="/docs"
					className="text-sm font-semibold text-gray-900 hover:text-gray-700 transition-colors"
				>
					Docs
				</Link>
			</div>

			<button
				type="button"
				onClick={handleSearchClick}
				className="hidden sm:flex items-center gap-2 h-8 px-3 rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-500 hover:border-gray-300 hover:bg-gray-100 transition-colors cursor-pointer min-w-[240px]"
			>
				<Search className="w-3.5 h-3.5 text-gray-400" />
				<span className="flex-1 text-left">Search docs...</span>
				<kbd className="hidden md:inline-flex items-center gap-0.5 rounded bg-white border border-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-400">
					{isMac ? "\u2318" : "Ctrl"}K
				</kbd>
			</button>

			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={handleSearchClick}
					className="sm:hidden flex items-center justify-center w-8 h-8 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
					aria-label="Search"
				>
					<Search className="w-4 h-4" />
				</button>
				<Link
					href="https://cap.so"
					target="_blank"
					rel="noopener noreferrer"
					className="hidden sm:flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 transition-colors"
				>
					cap.so
					<ExternalLink className="w-3 h-3" />
				</Link>
				<Link
					href="https://github.com/CapSoftware/Cap"
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center text-gray-500 hover:text-gray-900 transition-colors"
				>
					<svg
						viewBox="0 0 24 24"
						fill="currentColor"
						className="w-5 h-5"
						role="img"
						aria-label="GitHub"
					>
						<title>GitHub</title>
						<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
					</svg>
				</Link>
			</div>
		</header>
	);
}
