"use client";

import {
	ArrowLeft,
	CornerDownLeft,
	FileText,
	MessageCircle,
	Search,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

const DocsAskAnswer = dynamic(() => import("./DocsAskAnswer"), { ssr: false });

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

type PaletteItem =
	| { type: "ask"; question: string }
	| { type: "doc"; doc: SearchItem };

interface AskTurn {
	question: string;
	answer: string;
	status: "streaming" | "done" | "error";
	error?: string;
}

const EXAMPLE_QUESTIONS = [
	"How do I set up Cap in Claude Code?",
	"Can my agent record my screen and share a link?",
	"How do I self-host Cap with my own S3 bucket?",
];

const QUICK_LINK_SLUGS = [
	"introduction",
	"agents",
	"agents/setup",
	"api/rest-api",
];

const MAX_RESULTS = 10;

export function DocsSearch({ searchIndex }: DocsSearchProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [isAnimating, setIsAnimating] = useState(false);
	const [mode, setMode] = useState<"search" | "ask">("search");
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [turns, setTurns] = useState<AskTurn[]>([]);
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const conversationRef = useRef<HTMLDivElement>(null);
	const activeItemRef = useRef<HTMLButtonElement>(null);
	const abortRef = useRef<AbortController | null>(null);
	const stickToBottomRef = useRef(true);
	const instanceId = useId();
	const resultsId = `${instanceId}-docs-search-results`;
	const prevQueryRef = useRef(query);
	const prevActiveIndexRef = useRef(activeIndex);

	const filteredResults = useMemo(() => {
		if (!query.trim()) return [];
		const lowerQuery = query.toLowerCase();
		return searchIndex
			.filter(
				(item) =>
					item.title.toLowerCase().includes(lowerQuery) ||
					item.summary.toLowerCase().includes(lowerQuery) ||
					item.content.toLowerCase().includes(lowerQuery),
			)
			.slice(0, MAX_RESULTS);
	}, [query, searchIndex]);

	const quickLinks = useMemo(
		() =>
			QUICK_LINK_SLUGS.flatMap((slug) => {
				const doc = searchIndex.find((item) => item.slug === slug);
				return doc ? [doc] : [];
			}),
		[searchIndex],
	);

	const flatItems = useMemo<PaletteItem[]>(() => {
		if (query.trim()) {
			return [
				{ type: "ask", question: query.trim() },
				...filteredResults.map((doc): PaletteItem => ({ type: "doc", doc })),
			];
		}
		return [
			...EXAMPLE_QUESTIONS.map(
				(question): PaletteItem => ({ type: "ask", question }),
			),
			...quickLinks.map((doc): PaletteItem => ({ type: "doc", doc })),
		];
	}, [query, filteredResults, quickLinks]);

	const lastTurn = turns[turns.length - 1];
	const isStreaming = lastTurn?.status === "streaming";

	const open = useCallback((detail?: { mode?: string }) => {
		setIsOpen(true);
		setQuery("");
		setActiveIndex(0);
		setMode(detail?.mode === "ask" ? "ask" : "search");
	}, []);

	useEffect(() => {
		if (!isOpen) return;
		const frame = requestAnimationFrame(() => {
			setIsAnimating(true);
			inputRef.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [isOpen]);

	const close = useCallback(() => {
		abortRef.current?.abort();
		setIsAnimating(false);
		const timeout = setTimeout(() => {
			setIsOpen(false);
			setQuery("");
			setActiveIndex(0);
			setMode("search");
			setTurns([]);
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

	const patchLastTurn = useCallback((patch: Partial<AskTurn>) => {
		setTurns((prev) =>
			prev.map((turn, index) =>
				index === prev.length - 1 ? { ...turn, ...patch } : turn,
			),
		);
	}, []);

	const streamAnswer = useCallback(
		async (
			question: string,
			history: Array<{ role: "user" | "assistant"; content: string }>,
		) => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			try {
				const response = await fetch("/api/docs/ask", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ question, history }),
					signal: controller.signal,
				});

				if (!response.ok || !response.body) {
					let message =
						"Ask AI is unavailable right now. Try searching instead.";
					try {
						const data = (await response.json()) as { error?: unknown };
						if (typeof data.error === "string") message = data.error;
					} catch {
						message = "Ask AI is unavailable right now. Try searching instead.";
					}
					patchLastTurn({ status: "error", error: message });
					return;
				}

				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = decoder.decode(value, { stream: true });
					if (chunk) {
						setTurns((prev) =>
							prev.map((turn, index) =>
								index === prev.length - 1
									? { ...turn, answer: turn.answer + chunk }
									: turn,
							),
						);
					}
				}
				patchLastTurn({ status: "done" });
			} catch {
				if (!controller.signal.aborted) {
					patchLastTurn({
						status: "error",
						error: "Connection lost. Try asking again.",
					});
				}
			}
		},
		[patchLastTurn],
	);

	const startAsk = useCallback(
		(question: string) => {
			const trimmed = question.trim();
			if (trimmed.length < 3 || isStreaming) return;
			const history = turns
				.filter((turn) => turn.status === "done")
				.flatMap((turn) => [
					{ role: "user" as const, content: turn.question },
					{ role: "assistant" as const, content: turn.answer },
				])
				.slice(-6);
			setMode("ask");
			setQuery("");
			stickToBottomRef.current = true;
			setTurns((prev) => [
				...prev,
				{ question: trimmed, answer: "", status: "streaming" },
			]);
			inputRef.current?.focus();
			void streamAnswer(trimmed, history);
		},
		[isStreaming, turns, streamAnswer],
	);

	const goBackToSearch = useCallback(() => {
		if (isStreaming) {
			abortRef.current?.abort();
			setTurns((prev) => {
				const last = prev[prev.length - 1];
				if (last && last.status === "streaming") {
					return last.answer
						? prev.map((turn, index) =>
								index === prev.length - 1
									? { ...turn, status: "done" as const }
									: turn,
							)
						: prev.slice(0, -1);
				}
				return prev;
			});
		}
		setMode("search");
		setActiveIndex(0);
		inputRef.current?.focus();
	}, [isStreaming]);

	const selectItem = useCallback(
		(item: PaletteItem) => {
			if (item.type === "ask") {
				startAsk(item.question);
			} else {
				navigateTo(item.doc.slug);
			}
		},
		[startAsk, navigateTo],
	);

	const retryLastTurn = useCallback(() => {
		const failed = turns[turns.length - 1];
		if (!failed || failed.status !== "error") return;
		setTurns((prev) => prev.slice(0, -1));
		startAsk(failed.question);
	}, [turns, startAsk]);

	useEffect(() => {
		const handleOpenEvent = (event: Event) => {
			open((event as CustomEvent<{ mode?: string }>).detail ?? undefined);
		};
		window.addEventListener("open-docs-search", handleOpenEvent);
		return () =>
			window.removeEventListener("open-docs-search", handleOpenEvent);
	}, [open]);

	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.isComposing) return;

			if (e.key === "Escape") {
				e.preventDefault();
				if (mode === "ask") {
					goBackToSearch();
				} else {
					close();
				}
				return;
			}

			if (mode === "ask") {
				if (e.key === "Enter") {
					e.preventDefault();
					startAsk(query);
				}
				return;
			}

			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIndex((prev) => (prev < flatItems.length - 1 ? prev + 1 : 0));
				return;
			}

			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIndex((prev) => (prev > 0 ? prev - 1 : flatItems.length - 1));
				return;
			}

			if (e.key === "Enter") {
				e.preventDefault();
				const selected = flatItems[activeIndex];
				if (selected) selectItem(selected);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		isOpen,
		mode,
		query,
		flatItems,
		activeIndex,
		close,
		goBackToSearch,
		startAsk,
		selectItem,
	]);

	if (prevQueryRef.current !== query) {
		prevQueryRef.current = query;
		setActiveIndex(0);
	}

	if (prevActiveIndexRef.current !== activeIndex) {
		prevActiveIndexRef.current = activeIndex;
		activeItemRef.current?.scrollIntoView({ block: "nearest" });
	}

	useEffect(() => {
		if (mode !== "ask" || turns.length === 0) return;
		const el = conversationRef.current;
		if (el && stickToBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [mode, turns]);

	useEffect(() => {
		if (isOpen) {
			const scrollbarWidth =
				window.innerWidth - document.documentElement.clientWidth;
			document.documentElement.style.setProperty(
				"--scrollbar-compensation",
				`${scrollbarWidth}px`,
			);
			document.body.style.paddingRight = `${scrollbarWidth}px`;
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "";
			document.body.style.paddingRight = "";
			document.documentElement.style.removeProperty("--scrollbar-compensation");
		}
		return () => {
			document.body.style.overflow = "";
			document.body.style.paddingRight = "";
			document.documentElement.style.removeProperty("--scrollbar-compensation");
		};
	}, [isOpen]);

	if (!isOpen) return null;

	const showAskIntro = mode === "ask" && turns.length === 0;

	return (
		<div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[min(14vh,120px)]">
			<button
				type="button"
				className={`absolute inset-0 cursor-default bg-black-transparent-40 transition-opacity duration-150 ${
					isAnimating ? "opacity-100" : "opacity-0"
				}`}
				onClick={close}
				aria-label="Close"
				tabIndex={-1}
			/>

			<div
				className={`relative flex max-h-[min(620px,78vh)] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-gray-3 bg-gray-1 shadow-2xl transition-all duration-150 ${
					isAnimating
						? "translate-y-0 scale-100 opacity-100"
						: "-translate-y-2 scale-[0.98] opacity-0"
				}`}
				role="dialog"
				aria-modal="true"
				aria-label={
					mode === "ask" ? "Ask about the docs" : "Search documentation"
				}
			>
				<div className="flex shrink-0 items-center gap-2.5 border-b border-gray-3 px-4">
					{mode === "ask" ? (
						<button
							type="button"
							onClick={goBackToSearch}
							className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
							aria-label="Back to search"
						>
							<ArrowLeft className="size-4" />
						</button>
					) : (
						<Search className="size-4 shrink-0 text-gray-9" />
					)}
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={
							mode === "ask"
								? turns.length > 0
									? "Ask a follow-up..."
									: "Ask a question about Cap..."
								: "Search docs or ask a question..."
						}
						className="h-[52px] flex-1 bg-transparent text-[15px] text-gray-12 outline-none placeholder:text-gray-9"
						aria-label={
							mode === "ask"
								? "Ask a question about Cap"
								: "Search documentation"
						}
						aria-autocomplete="list"
						aria-controls={mode === "search" ? resultsId : undefined}
						aria-activedescendant={
							mode === "search" && flatItems[activeIndex]
								? `${instanceId}-item-${activeIndex}`
								: undefined
						}
					/>
					<kbd className="shrink-0 rounded-md border border-gray-4 bg-gray-2 px-1.5 py-0.5 text-[11px] font-medium text-gray-9 select-none">
						Esc
					</kbd>
				</div>

				{mode === "search" ? (
					<div
						id={resultsId}
						role="listbox"
						className="flex-1 overflow-y-auto overscroll-contain py-2 [scrollbar-width:thin]"
					>
						{query.trim() && filteredResults.length === 0 && (
							<p className="px-4 pb-1 pt-3 text-[13px] text-gray-9">
								No pages match &ldquo;{query}&rdquo; — ask the docs instead:
							</p>
						)}
						{!query.trim() && (
							<p className="px-4 pb-1.5 pt-2 text-xs font-medium text-gray-9">
								Ask the docs
							</p>
						)}
						{flatItems.map((item, index) => {
							const isActive = index === activeIndex;
							const isFirstQuickLink =
								!query.trim() &&
								item.type === "doc" &&
								flatItems[index - 1]?.type === "ask";
							return (
								<div
									key={
										item.type === "ask" ? `ask-${item.question}` : item.doc.slug
									}
								>
									{isFirstQuickLink && (
										<p className="px-4 pb-1.5 pt-3 text-xs font-medium text-gray-9">
											Popular pages
										</p>
									)}
									<button
										ref={isActive ? activeItemRef : undefined}
										id={`${instanceId}-item-${index}`}
										role="option"
										aria-selected={isActive}
										type="button"
										className={`mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors duration-75 ${
											isActive ? "bg-gray-3" : "hover:bg-gray-2"
										}`}
										onClick={() => selectItem(item)}
										onMouseEnter={() => setActiveIndex(index)}
									>
										{item.type === "ask" ? (
											<MessageCircle className="size-4 shrink-0 text-gray-9" />
										) : (
											<FileText className="size-4 shrink-0 text-gray-9" />
										)}
										<span className="min-w-0 flex-1 truncate text-sm text-gray-12">
											{item.type === "ask" ? (
												query.trim() ? (
													<>
														Ask the docs about{" "}
														<span className="font-medium">
															&ldquo;{item.question}&rdquo;
														</span>
													</>
												) : (
													item.question
												)
											) : (
												item.doc.title
											)}
										</span>
										{item.type === "doc" && (
											<span className="shrink-0 text-xs text-gray-8">
												{item.doc.group}
											</span>
										)}
										{isActive && (
											<CornerDownLeft className="size-3.5 shrink-0 text-gray-8" />
										)}
									</button>
								</div>
							);
						})}
					</div>
				) : (
					<div
						ref={conversationRef}
						onScroll={(e) => {
							const el = e.currentTarget;
							stickToBottomRef.current =
								el.scrollHeight - el.scrollTop - el.clientHeight < 80;
						}}
						className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-width:thin]"
					>
						{showAskIntro ? (
							<div className="py-2">
								<p className="text-sm font-medium text-gray-12">
									Ask anything about Cap
								</p>
								<p className="mt-1 text-[13px] leading-5 text-gray-10">
									Get instant answers from the documentation, with links to the
									right pages.
								</p>
								<div className="mt-4 flex flex-col items-start gap-1.5">
									{EXAMPLE_QUESTIONS.map((question) => (
										<button
											key={question}
											type="button"
											onClick={() => startAsk(question)}
											className="rounded-full border border-gray-4 bg-gray-2 px-3 py-1.5 text-[13px] text-gray-11 transition-colors hover:border-gray-5 hover:text-gray-12"
										>
											{question}
										</button>
									))}
								</div>
							</div>
						) : (
							<div className="flex flex-col gap-6">
								{turns.map((turn, index) => (
									<div key={`${index}-${turn.question}`}>
										<p className="text-sm font-medium leading-6 text-gray-12">
											{turn.question}
										</p>
										<div className="mt-2">
											{turn.status === "error" ? (
												<div className="flex flex-wrap items-center gap-2">
													<p className="text-sm text-red-400">{turn.error}</p>
													<button
														type="button"
														onClick={retryLastTurn}
														className="text-sm font-medium text-blue-11 underline-offset-[3px] hover:underline"
													>
														Try again
													</button>
												</div>
											) : turn.answer ? (
												<>
													<DocsAskAnswer
														answer={turn.answer}
														onNavigate={close}
													/>
													{turn.status === "streaming" && (
														<span className="mt-1 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-blue-9" />
													)}
												</>
											) : (
												<div className="flex items-center gap-1.5 py-1">
													<span className="size-1.5 animate-pulse rounded-full bg-gray-8" />
													<span className="size-1.5 animate-pulse rounded-full bg-gray-8 [animation-delay:150ms]" />
													<span className="size-1.5 animate-pulse rounded-full bg-gray-8 [animation-delay:300ms]" />
												</div>
											)}
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				)}

				<div className="flex shrink-0 items-center gap-4 border-t border-gray-3 bg-gray-2 px-4 py-2.5">
					{mode === "search" ? (
						<>
							<span className="flex items-center gap-1.5 text-[11px] text-gray-9">
								<kbd className="flex h-5 w-5 items-center justify-center rounded border border-gray-4 bg-gray-1 text-[10px] font-medium">
									↑
								</kbd>
								<kbd className="flex h-5 w-5 items-center justify-center rounded border border-gray-4 bg-gray-1 text-[10px] font-medium">
									↓
								</kbd>
								navigate
							</span>
							<span className="flex items-center gap-1.5 text-[11px] text-gray-9">
								<kbd className="flex h-5 items-center rounded border border-gray-4 bg-gray-1 px-1.5 text-[10px] font-medium">
									↵
								</kbd>
								select
							</span>
						</>
					) : (
						<span className="text-[11px] text-gray-9">
							Powered by Claude. Check important details against the linked
							docs.
						</span>
					)}
				</div>
			</div>
		</div>
	);
}
