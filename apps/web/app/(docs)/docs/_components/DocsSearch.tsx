"use client";

import { FileText, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

interface SearchItem {
	slug: string;
	title: string;
	summary: string;
	content: string;
	group: string;
}

interface DocsSearchProps {
	searchIndex: SearchItem[];
}

interface GroupedResults {
	group: string;
	items: SearchItem[];
}

function groupResults(items: SearchItem[]): GroupedResults[] {
	const map = new Map<string, SearchItem[]>();
	for (const item of items) {
		const existing = map.get(item.group);
		if (existing) {
			existing.push(item);
		} else {
			map.set(item.group, [item]);
		}
	}
	return Array.from(map.entries()).map(([group, items]) => ({
		group,
		items,
	}));
}

function truncateSummary(text: string, maxLength = 120): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength).trimEnd()}...`;
}

export function DocsSearch({ searchIndex }: DocsSearchProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [isAnimating, setIsAnimating] = useState(false);
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const resultsRef = useRef<HTMLDivElement>(null);
	const activeItemRef = useRef<HTMLButtonElement>(null);
	const instanceId = useId();
	const resultsId = `${instanceId}-docs-search-results`;
	const prevQueryRef = useRef(query);
	const prevActiveIndexRef = useRef(activeIndex);

	const filteredResults = useMemo(() => {
		if (!query.trim()) return [];
		const lowerQuery = query.toLowerCase();
		return searchIndex.filter(
			(item) =>
				item.title.toLowerCase().includes(lowerQuery) ||
				item.summary.toLowerCase().includes(lowerQuery) ||
				item.content.toLowerCase().includes(lowerQuery),
		);
	}, [query, searchIndex]);

	const grouped = useMemo(
		() => groupResults(filteredResults),
		[filteredResults],
	);

	const flatResults = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

	const open = useCallback(() => {
		setIsOpen(true);
		setQuery("");
		setActiveIndex(0);
		requestAnimationFrame(() => {
			setIsAnimating(true);
			inputRef.current?.focus();
		});
	}, []);

	const close = useCallback(() => {
		setIsAnimating(false);
		const timeout = setTimeout(() => {
			setIsOpen(false);
			setQuery("");
			setActiveIndex(0);
		}, 150);
		return () => clearTimeout(timeout);
	}, []);

	const navigateTo = useCallback(
		(slug: string) => {
			close();
			router.push(`/docs/${slug}`);
		},
		[close, router],
	);

	useEffect(() => {
		const handleCustomEvent = () => open();
		window.addEventListener("open-docs-search", handleCustomEvent);
		return () =>
			window.removeEventListener("open-docs-search", handleCustomEvent);
	}, [open]);

	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				close();
				return;
			}

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIndex((prev) =>
					prev < flatResults.length - 1 ? prev + 1 : 0,
				);
				return;
			}

			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIndex((prev) =>
					prev > 0 ? prev - 1 : flatResults.length - 1,
				);
				return;
			}

			if (e.key === "Enter") {
				e.preventDefault();
				const selected = flatResults[activeIndex];
				if (selected) {
					navigateTo(selected.slug);
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, flatResults, activeIndex, close, navigateTo]);

	if (prevQueryRef.current !== query) {
		prevQueryRef.current = query;
		setActiveIndex(0);
	}

	if (prevActiveIndexRef.current !== activeIndex) {
		prevActiveIndexRef.current = activeIndex;
		activeItemRef.current?.scrollIntoView({ block: "nearest" });
	}

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

	let flatIndex = -1;

	return (
		<div className="fixed inset-0 z-[60] flex items-start justify-center pt-[min(20vh,120px)]">
			<button
				type="button"
				className={`absolute inset-0 bg-black/30 transition-opacity duration-150 cursor-default ${
					isAnimating ? "opacity-100" : "opacity-0"
				}`}
				onClick={close}
				aria-label="Close search"
				tabIndex={-1}
			/>

			<div
				className={`relative w-full max-w-xl mx-4 bg-white rounded-xl shadow-2xl overflow-hidden transition-all duration-150 ${
					isAnimating
						? "opacity-100 scale-100 translate-y-0"
						: "opacity-0 scale-[0.98] -translate-y-2"
				}`}
				role="dialog"
				aria-modal="true"
				aria-label="Search documentation"
			>
				<div className="flex items-center gap-3 px-4 border-b border-gray-200">
					<Search className="w-4.5 h-4.5 text-gray-400 shrink-0" />
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search documentation..."
						className="flex-1 h-14 text-base text-gray-900 placeholder-gray-400 outline-none bg-transparent"
						aria-label="Search documentation"
						aria-autocomplete="list"
						aria-controls={resultsId}
						aria-activedescendant={
							flatResults[activeIndex]
								? `${instanceId}-item-${flatResults[activeIndex].slug}`
								: undefined
						}
					/>
					<kbd className="shrink-0 inline-flex items-center rounded bg-gray-100 border border-gray-200 px-1.5 py-0.5 text-[11px] font-medium text-gray-400 select-none">
						ESC
					</kbd>
				</div>

				<div
					ref={resultsRef}
					id={resultsId}
					role="listbox"
					className="max-h-[400px] overflow-y-auto overscroll-contain"
				>
					{!query.trim() && (
						<div className="flex flex-col items-center justify-center py-12 px-4">
							<Search className="w-8 h-8 text-gray-300 mb-3" />
							<p className="text-sm text-gray-400">Start typing to search...</p>
						</div>
					)}

					{query.trim() && flatResults.length === 0 && (
						<div className="flex flex-col items-center justify-center py-12 px-4">
							<Search className="w-8 h-8 text-gray-300 mb-3" />
							<p className="text-sm text-gray-500">
								No results found for &ldquo;{query}&rdquo;
							</p>
						</div>
					)}

					{grouped.map((group) => (
						<div key={group.group} className="py-2">
							<div className="px-4 py-1.5">
								<span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
									{group.group}
								</span>
							</div>
							{group.items.map((item) => {
								flatIndex++;
								const isActive = flatIndex === activeIndex;
								const currentIndex = flatIndex;
								return (
									<button
										key={item.slug}
										ref={isActive ? activeItemRef : undefined}
										id={`${instanceId}-item-${item.slug}`}
										role="option"
										aria-selected={isActive}
										type="button"
										className={`w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors duration-75 cursor-pointer ${
											isActive ? "bg-blue-50" : "hover:bg-gray-50"
										}`}
										onClick={() => navigateTo(item.slug)}
										onMouseEnter={() => setActiveIndex(currentIndex)}
									>
										<FileText
											className={`w-4 h-4 mt-0.5 shrink-0 ${
												isActive ? "text-blue-500" : "text-gray-400"
											}`}
										/>
										<div className="min-w-0 flex-1">
											<div
												className={`text-sm font-medium truncate ${
													isActive ? "text-blue-900" : "text-gray-900"
												}`}
											>
												{item.title}
											</div>
											{item.summary && (
												<div className="text-xs text-gray-500 mt-0.5 truncate">
													{truncateSummary(item.summary)}
												</div>
											)}
										</div>
									</button>
								);
							})}
						</div>
					))}
				</div>

				{flatResults.length > 0 && (
					<div className="flex items-center gap-4 px-4 py-2.5 border-t border-gray-200 bg-gray-50">
						<span className="flex items-center gap-1.5 text-[11px] text-gray-400">
							<kbd className="inline-flex items-center justify-center w-5 h-5 rounded bg-white border border-gray-200 text-[10px] font-medium">
								↑
							</kbd>
							<kbd className="inline-flex items-center justify-center w-5 h-5 rounded bg-white border border-gray-200 text-[10px] font-medium">
								↓
							</kbd>
							<span>to navigate</span>
						</span>
						<span className="flex items-center gap-1.5 text-[11px] text-gray-400">
							<kbd className="inline-flex items-center justify-center h-5 px-1.5 rounded bg-white border border-gray-200 text-[10px] font-medium">
								↵
							</kbd>
							<span>to select</span>
						</span>
					</div>
				)}
			</div>
		</div>
	);
}
