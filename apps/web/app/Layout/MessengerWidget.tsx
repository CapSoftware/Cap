"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	createMessengerConversation,
	fetchMessengerConversation,
	fetchMessengerConversations,
	sendMessengerUserMessage,
} from "@/actions/messenger";
import { MESSENGER_SUGGESTED_PROMPTS } from "@/lib/messenger/constants";

interface ConversationSummary {
	id: string;
	agent: string;
	latestMessage: { content: string; createdAt: string } | null;
	lastMessageAt: string | null;
}

interface ChatMessage {
	id: string;
	role: "user" | "agent" | "admin";
	content: string;
}

interface ActiveConversation {
	id: string;
	agent: string;
	mode: "agent" | "human";
}

type PanelView = "closed" | "loading" | "home" | "chat";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function relativeTime(dateStr: string | null) {
	if (!dateStr) return "";
	const diff = Date.now() - new Date(dateStr).getTime();
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
	}).format(new Date(dateStr));
}

function TypingDots() {
	return (
		<div className="flex items-center gap-1">
			{[0, 1, 2].map((i) => (
				<div
					key={i}
					className="h-1.5 w-1.5 rounded-full bg-gray-8"
					style={{
						animation: "cap-messenger-typing 1.4s ease-in-out infinite",
						animationDelay: `${i * 0.15}s`,
					}}
				/>
			))}
		</div>
	);
}

function MessageBubble({ message }: { message: ChatMessage }) {
	if (message.role === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[85%] rounded-[18px] bg-gray-12 px-4 py-2.5 text-[14px] leading-[1.6] text-gray-1">
					<div className="whitespace-pre-wrap break-words">
						{message.content}
					</div>
				</div>
			</div>
		);
	}

	const isAdmin = message.role === "admin";

	return (
		<div className="flex justify-start">
			<div className="flex max-w-[85%] flex-col gap-1">
				{isAdmin && (
					<span
						className="ml-1 flex items-center gap-1 text-[12px] font-medium"
						style={{ color: "var(--msngr-admin-text)" }}
					>
						<span
							className="inline-block h-1.5 w-1.5 rounded-full"
							style={{ backgroundColor: "var(--msngr-admin-dot)" }}
						/>
						Cap Team
					</span>
				)}
				<div
					className={`rounded-[18px] px-4 py-2.5 text-[14px] leading-[1.6] text-gray-12 ${
						isAdmin ? "msngr-admin-bubble" : "bg-gray-3"
					}`}
				>
					<div className="messenger-markdown prose prose-sm max-w-none break-words text-gray-12 prose-p:my-1.5 prose-p:text-gray-12 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-li:text-gray-12 prose-strong:text-gray-12 prose-a:underline prose-headings:text-gray-12 prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:text-[14px] prose-headings:font-semibold prose-p:text-[14px] prose-p:leading-[1.6] prose-li:text-[14px] prose-li:leading-[1.6] prose-code:text-[13px] prose-code:text-gray-12 prose-code:bg-gray-4 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none">
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							components={{
								a: ({ href, children }) => (
									<a href={href} target="_blank" rel="noopener noreferrer">
										{children}
									</a>
								),
							}}
						>
							{message.content}
						</ReactMarkdown>
					</div>
				</div>
			</div>
		</div>
	);
}

function PanelHeader({
	showBack,
	onBack,
	onClose,
}: {
	showBack: boolean;
	onBack: () => void;
	onClose: () => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-3 bg-gray-12 px-4 py-3">
			{showBack && (
				<button
					type="button"
					onClick={onBack}
					className="msngr-header-btn flex h-7 w-7 items-center justify-center rounded-full"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						aria-hidden="true"
					>
						<path
							d="M10 12L6 8L10 4"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</button>
			)}
			<div
				className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
				style={{ backgroundColor: "var(--msngr-accent-subtle)" }}
			>
				<Image src="/favicon.ico" alt="Cap Logo" width={32} height={32} />
			</div>
			<span
				className="flex-1 text-[14px] font-semibold"
				style={{ color: "var(--msngr-on-accent)" }}
			>
				Cap Support
			</span>
			<button
				type="button"
				onClick={onClose}
				className="msngr-header-btn flex h-7 w-7 items-center justify-center rounded-full"
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M18 6L6 18M6 6l12 12"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
		</div>
	);
}

function HomeView({
	conversations,
	isLoading,
	onNewChat,
	onSelectConversation,
	isCreating,
}: {
	conversations: ConversationSummary[];
	isLoading: boolean;
	onNewChat: () => void;
	onSelectConversation: (id: string) => void;
	isCreating: boolean;
}) {
	return (
		<div className="flex-1 overflow-y-auto overscroll-contain bg-gray-1 px-4 py-4">
			<button
				type="button"
				disabled={isCreating}
				onClick={onNewChat}
				className="flex w-full items-center justify-center gap-2 rounded-xl bg-gray-12 px-3 py-2.5 text-[14px] font-medium text-gray-1 transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-50"
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M12 5V19M5 12H19"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
				{isCreating ? "Starting..." : "New conversation"}
			</button>

			{!isLoading && conversations.length > 0 && (
				<div className="mt-4">
					<div className="mb-2 px-1 text-[12px] font-medium uppercase tracking-wider text-gray-10">
						Previous conversations
					</div>
					<div className="overflow-hidden rounded-xl border border-gray-4">
						{conversations.map((c, i) => (
							<button
								key={c.id}
								type="button"
								onClick={() => onSelectConversation(c.id)}
								className={`flex w-full items-center gap-3 bg-gray-1 px-3 py-3 text-left transition-colors hover:bg-gray-2 active:bg-gray-3 ${
									i < conversations.length - 1 ? "border-b border-gray-4" : ""
								}`}
							>
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-3 text-[11px] font-semibold text-gray-11">
									M
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center justify-between gap-2">
										<span className="text-[14px] font-medium text-gray-12">
											Millie
										</span>
										<span className="shrink-0 text-[11px] tabular-nums text-gray-9">
											{relativeTime(
												c.latestMessage?.createdAt ?? c.lastMessageAt,
											)}
										</span>
									</div>
									<div className="mt-0.5 truncate text-[13px] leading-normal text-gray-10">
										{c.latestMessage?.content ?? "No messages yet"}
									</div>
								</div>
							</button>
						))}
					</div>
				</div>
			)}

			{isLoading && (
				<div className="mt-8 flex justify-center">
					<div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-4 border-t-gray-11" />
				</div>
			)}
		</div>
	);
}

const WIDGET_POLL_MS = 3000;

function playNotificationSound() {
	try {
		const ctx = new AudioContext();
		const t = ctx.currentTime;
		const playTone = (freq: number, start: number, dur: number) => {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.type = "sine";
			osc.frequency.setValueAtTime(freq, t + start);
			gain.gain.setValueAtTime(0.12, t + start);
			gain.gain.exponentialRampToValueAtTime(0.001, t + start + dur);
			osc.start(t + start);
			osc.stop(t + start + dur);
		};
		playTone(523.25, 0, 0.15);
		playTone(659.25, 0.12, 0.2);
		setTimeout(() => ctx.close(), 500);
	} catch {}
}

function ChatView({
	conversation: initialConversation,
	initialMessages,
}: {
	conversation: ActiveConversation;
	initialMessages: ChatMessage[];
}) {
	const bottomRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const chatContainerRef = useRef<HTMLDivElement>(null);
	const [input, setInput] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
	const [conversation, setConversation] =
		useState<ActiveConversation>(initialConversation);
	const [isPending, startTransition] = useTransition();
	const prevMessageCountRef = useRef(initialMessages.length);
	const userScrolledRef = useRef(false);
	const isSendingRef = useRef(false);
	const wasPendingRef = useRef(false);
	const isHoveringRef = useRef(false);
	const agentMsgCountRef = useRef(
		initialMessages.filter((m) => m.role === "agent" || m.role === "admin")
			.length,
	);
	const originalTitleRef = useRef("");

	const scrollToBottom = useCallback((instant?: boolean) => {
		bottomRef.current?.scrollIntoView({
			behavior: instant ? "instant" : "smooth",
		});
	}, []);

	useEffect(() => {
		scrollToBottom(true);
	}, [scrollToBottom]);

	useEffect(() => {
		if (
			messages.length > prevMessageCountRef.current &&
			!userScrolledRef.current
		) {
			scrollToBottom();
		}
		prevMessageCountRef.current = messages.length;
	}, [messages.length, scrollToBottom]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if (wasPendingRef.current && !isPending) {
			inputRef.current?.focus();
		}
		wasPendingRef.current = isPending;
	}, [isPending]);

	useEffect(() => {
		originalTitleRef.current = document.title;
		const resetTitle = () => {
			document.title = originalTitleRef.current;
		};
		const handleVisibility = () => {
			if (!document.hidden) resetTitle();
		};
		window.addEventListener("focus", resetTitle);
		document.addEventListener("visibilitychange", handleVisibility);
		return () => {
			window.removeEventListener("focus", resetTitle);
			document.removeEventListener("visibilitychange", handleVisibility);
			document.title = originalTitleRef.current;
		};
	}, []);

	useEffect(() => {
		const el = chatContainerRef.current;
		if (!el) return;
		const enter = () => {
			isHoveringRef.current = true;
		};
		const leave = () => {
			isHoveringRef.current = false;
		};
		el.addEventListener("mouseenter", enter);
		el.addEventListener("mouseleave", leave);
		return () => {
			el.removeEventListener("mouseenter", enter);
			el.removeEventListener("mouseleave", leave);
		};
	}, []);

	const handleScroll = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container) return;
		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		userScrolledRef.current = distanceFromBottom > 80;
	}, []);

	useEffect(() => {
		const interval = setInterval(async () => {
			if (isSendingRef.current) return;
			const data = await fetchMessengerConversation(
				initialConversation.id,
			).catch(() => null);
			if (!data || isSendingRef.current) return;

			const newAgentCount = data.messages.filter(
				(m) => m.role === "agent" || m.role === "admin",
			).length;
			const hasNewReply = newAgentCount > agentMsgCountRef.current;
			agentMsgCountRef.current = newAgentCount;

			setMessages(data.messages);
			setConversation(data.conversation);

			if (hasNewReply) {
				if (document.hidden) {
					document.title = "New Reply — Cap";
				}
				const inputFocused = document.activeElement === inputRef.current;
				if (document.hidden || (!inputFocused && !isHoveringRef.current)) {
					playNotificationSound();
				}
			}
		}, WIDGET_POLL_MS);
		return () => clearInterval(interval);
	}, [initialConversation.id]);

	const sendMessage = (text: string) => {
		if (!text || isPending) return;

		setInput("");
		if (inputRef.current) inputRef.current.style.height = "auto";

		const optimistic: ChatMessage = {
			id: `optimistic-${Date.now()}`,
			role: "user",
			content: text,
		};
		setMessages((prev) => [...prev, optimistic]);
		isSendingRef.current = true;

		startTransition(async () => {
			await sendMessengerUserMessage({
				conversationId: conversation.id,
				content: text,
			});
			const data = await fetchMessengerConversation(conversation.id);
			agentMsgCountRef.current = data.messages.filter(
				(m) => m.role === "agent" || m.role === "admin",
			).length;
			setMessages(data.messages);
			setConversation(data.conversation);
			isSendingRef.current = false;
		});
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		sendMessage(input.trim());
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit(e);
		}
	};

	const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setInput(e.target.value);
		const el = e.target;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
	};

	const showTyping = isPending && conversation.mode === "agent";
	const isEmpty = messages.length === 0;

	return (
		<div
			ref={chatContainerRef}
			className="flex flex-1 flex-col overflow-hidden bg-gray-1"
		>
			{conversation.mode === "human" && (
				<div className="msngr-human-banner flex shrink-0 items-center justify-center gap-2 border-b px-3 py-1.5 text-[13px] font-medium">
					<span className="relative flex h-2 w-2">
						<span
							className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
							style={{ backgroundColor: "var(--msngr-human-ping)" }}
						/>
						<span
							className="relative inline-flex h-2 w-2 rounded-full"
							style={{ backgroundColor: "var(--msngr-human-dot)" }}
						/>
					</span>
					You're chatting with a real person
				</div>
			)}
			<div
				ref={scrollContainerRef}
				onScroll={handleScroll}
				className="flex-1 overflow-y-auto overscroll-contain"
			>
				{isEmpty ? (
					<div className="flex h-full flex-col px-4 pt-6">
						<div className="flex justify-start">
							<div className="max-w-[85%] rounded-[18px] bg-gray-3 px-4 py-2.5 text-[14px] leading-[1.6] text-gray-12">
								Hey! I&apos;m Millie from Cap, ask me anything!
							</div>
						</div>
						<div className="flex-1" />
						<div className="flex flex-wrap justify-center gap-2 pb-4">
							{MESSENGER_SUGGESTED_PROMPTS.map((prompt) => (
								<button
									key={prompt}
									type="button"
									onClick={() => sendMessage(prompt)}
									disabled={isPending}
									className="rounded-full border border-gray-5 bg-gray-1 px-4 py-2 text-[14px] leading-snug text-gray-11 transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:opacity-50"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="space-y-4 px-4 py-4">
						{messages.map((msg) => (
							<MessageBubble key={msg.id} message={msg} />
						))}
						{showTyping && (
							<div className="flex justify-start">
								<div className="rounded-[18px] bg-gray-3 px-4 py-3">
									<TypingDots />
								</div>
							</div>
						)}
					</div>
				)}
				<div ref={bottomRef} />
			</div>

			<div className="shrink-0 border-t border-gray-4 bg-gray-1 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
				<form onSubmit={handleSubmit} className="flex items-end gap-2">
					<textarea
						ref={inputRef}
						value={input}
						onChange={handleInputChange}
						onKeyDown={handleKeyDown}
						placeholder="Message..."
						disabled={isPending}
						rows={1}
						className="flex-1 resize-none rounded-full border border-gray-5 bg-gray-1 px-4 py-2 text-[16px] leading-snug text-gray-12 outline-none transition-colors placeholder:text-gray-9 hover:border-gray-6 focus:border-gray-8 disabled:opacity-50 sm:text-[14px]"
					/>
					<button
						type="submit"
						disabled={isPending || !input.trim()}
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-12 text-gray-1 transition-all hover:opacity-90 disabled:opacity-30"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 16 16"
							fill="none"
							aria-hidden="true"
						>
							<path
								d="M8 13V3M8 3L4 7M8 3L12 7"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				</form>
			</div>
		</div>
	);
}

export function MessengerWidget() {
	const [view, setView] = useState<PanelView>("closed");
	const [isAnimating, setIsAnimating] = useState(false);
	const [conversations, setConversations] = useState<ConversationSummary[]>([]);
	const [isLoadingConversations, setIsLoadingConversations] = useState(false);
	const [isCreating, setIsCreating] = useState(false);
	const [activeConversation, setActiveConversation] =
		useState<ActiveConversation | null>(null);
	const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
	const [chatKey, setChatKey] = useState(0);
	const panelRef = useRef<HTMLDivElement>(null);

	const isOpen = view !== "closed";

	const loadConversations = useCallback(async () => {
		setIsLoadingConversations(true);
		const data = await fetchMessengerConversations().catch(() => null);
		if (data) setConversations(data);
		setIsLoadingConversations(false);
		return data ?? [];
	}, []);

	const openConversation = useCallback(async (conversationId: string) => {
		const data = await fetchMessengerConversation(conversationId).catch(
			() => null,
		);
		if (!data) return false;
		setActiveConversation(data.conversation);
		setChatMessages(data.messages);
		setChatKey((k) => k + 1);
		setView("chat");
		return true;
	}, []);

	const openPanel = useCallback(async () => {
		setView("loading");
		requestAnimationFrame(() => {
			requestAnimationFrame(() => setIsAnimating(true));
		});

		const convos = await loadConversations();

		const oneWeekAgo = Date.now() - SEVEN_DAYS_MS;
		const recent = convos
			.filter((c) => {
				const time = c.lastMessageAt ?? c.latestMessage?.createdAt;
				return time && new Date(time).getTime() > oneWeekAgo;
			})
			.sort((a, b) => {
				const aTime = new Date(
					a.lastMessageAt ?? a.latestMessage?.createdAt ?? 0,
				).getTime();
				const bTime = new Date(
					b.lastMessageAt ?? b.latestMessage?.createdAt ?? 0,
				).getTime();
				return bTime - aTime;
			})[0];

		if (recent) {
			const opened = await openConversation(recent.id);
			if (opened) return;
		}

		const conversationId = await createMessengerConversation().catch(
			() => null,
		);
		if (conversationId) {
			const opened = await openConversation(conversationId);
			if (opened) return;
		}

		setView("home");
	}, [loadConversations, openConversation]);

	const closePanel = useCallback(() => {
		setIsAnimating(false);
		setTimeout(() => {
			setView("closed");
			setActiveConversation(null);
			setChatMessages([]);
		}, 200);
	}, []);

	const togglePanel = useCallback(() => {
		if (isOpen) closePanel();
		else openPanel();
	}, [isOpen, openPanel, closePanel]);

	const handleSelectConversation = useCallback(
		async (conversationId: string) => {
			await openConversation(conversationId);
		},
		[openConversation],
	);

	const handleNewChat = useCallback(async () => {
		const emptyConversation = conversations.find((c) => !c.latestMessage);
		if (emptyConversation) {
			handleSelectConversation(emptyConversation.id);
			return;
		}

		setIsCreating(true);
		const conversationId = await createMessengerConversation().catch(
			() => null,
		);
		if (!conversationId) {
			setIsCreating(false);
			return;
		}
		const data = await fetchMessengerConversation(conversationId).catch(
			() => null,
		);
		setIsCreating(false);
		if (!data) return;
		setActiveConversation(data.conversation);
		setChatMessages(data.messages);
		setChatKey((k) => k + 1);
		setView("chat");
	}, [conversations, handleSelectConversation]);

	const handleBackToHome = useCallback(() => {
		setView("home");
		setActiveConversation(null);
		setChatMessages([]);
		loadConversations();
	}, [loadConversations]);

	useEffect(() => {
		if (!isOpen) return;
		const handleEsc = (e: KeyboardEvent) => {
			if (e.key === "Escape") closePanel();
		};
		document.addEventListener("keydown", handleEsc);
		return () => document.removeEventListener("keydown", handleEsc);
	}, [isOpen, closePanel]);

	return (
		<>
			<style>{`
				@keyframes cap-messenger-typing {
					0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
					30% { opacity: 1; transform: translateY(-3px); }
				}
				.cap-messenger-panel {
					position: fixed;
					bottom: 88px;
					right: 20px;
					z-index: 9999;
					width: min(440px, calc(100vw - 40px));
					height: min(760px, calc(100dvh - 108px));
					box-shadow:
						0 0 0 1px rgba(0,0,0,0.08),
						0 8px 40px rgba(0,0,0,0.12),
						0 20px 60px rgba(0,0,0,0.06);
					--msngr-on-accent: #fff;
					--msngr-on-accent-muted: rgba(255,255,255,0.6);
					--msngr-accent-overlay: rgba(255,255,255,0.1);
					--msngr-accent-subtle: rgba(255,255,255,0.15);
					--msngr-admin-bg: #ecfdf5;
					--msngr-admin-ring: #a7f3d0;
					--msngr-admin-text: #059669;
					--msngr-admin-dot: #10b981;
					--msngr-human-bg: #ecfdf5;
					--msngr-human-border: #d1fae5;
					--msngr-human-text: #047857;
					--msngr-human-dot: #10b981;
					--msngr-human-ping: rgba(52,211,153,0.75);
					--msngr-link: #2563eb;
					--msngr-link-hover: #3b82f6;
				}
				.dark .cap-messenger-panel {
					box-shadow:
						0 0 0 1px rgba(255,255,255,0.06),
						0 8px 40px rgba(0,0,0,0.4),
						0 20px 60px rgba(0,0,0,0.2);
					--msngr-on-accent: var(--gray-1);
					--msngr-on-accent-muted: rgba(0,0,0,0.45);
					--msngr-accent-overlay: rgba(0,0,0,0.08);
					--msngr-accent-subtle: rgba(0,0,0,0.1);
					--msngr-admin-bg: rgba(16,185,129,0.1);
					--msngr-admin-ring: rgba(16,185,129,0.2);
					--msngr-admin-text: #6ee7b7;
					--msngr-admin-dot: #34d399;
					--msngr-human-bg: rgba(16,185,129,0.08);
					--msngr-human-border: rgba(16,185,129,0.15);
					--msngr-human-text: #6ee7b7;
					--msngr-human-dot: #34d399;
					--msngr-human-ping: rgba(52,211,153,0.75);
					--msngr-link: #93c5fd;
					--msngr-link-hover: #bfdbfe;
				}
				.msngr-header-btn {
					color: var(--msngr-on-accent-muted);
					transition: color 150ms, background-color 150ms;
				}
				.msngr-header-btn:hover {
					color: var(--msngr-on-accent);
					background-color: var(--msngr-accent-overlay);
				}
				.msngr-admin-bubble {
					background-color: var(--msngr-admin-bg);
					box-shadow: inset 0 0 0 1px var(--msngr-admin-ring);
				}
				.msngr-human-banner {
					background-color: var(--msngr-human-bg);
					border-color: var(--msngr-human-border);
					color: var(--msngr-human-text);
				}
				.messenger-markdown a { color: var(--msngr-link); }
				.messenger-markdown a:hover { color: var(--msngr-link-hover); }
				@media (max-width: 480px) {
					.cap-messenger-panel {
						width: 100vw;
						height: 100dvh;
						right: 0;
						bottom: 0;
						border-radius: 0 !important;
					}
				}
			`}</style>

			{isOpen && (
				<div
					ref={panelRef}
					className={`cap-messenger-panel flex flex-col overflow-hidden rounded-2xl bg-gray-1 transition-all duration-200 ease-out ${
						isAnimating
							? "opacity-100 translate-y-0 scale-100"
							: "opacity-0 translate-y-3 scale-[0.97]"
					}`}
				>
					{view === "loading" && (
						<>
							<PanelHeader
								showBack={false}
								onBack={() => {}}
								onClose={closePanel}
							/>
							<div className="flex flex-1 items-center justify-center bg-gray-1">
								<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-4 border-t-gray-11" />
							</div>
						</>
					)}

					{view === "home" && (
						<>
							<PanelHeader
								showBack={false}
								onBack={() => {}}
								onClose={closePanel}
							/>
							<HomeView
								conversations={conversations}
								isLoading={isLoadingConversations}
								onNewChat={handleNewChat}
								onSelectConversation={handleSelectConversation}
								isCreating={isCreating}
							/>
						</>
					)}

					{view === "chat" && activeConversation && (
						<>
							<PanelHeader
								showBack
								onBack={handleBackToHome}
								onClose={closePanel}
							/>
							<ChatView
								key={chatKey}
								conversation={activeConversation}
								initialMessages={chatMessages}
							/>
						</>
					)}
				</div>
			)}

			<button
				type="button"
				onClick={togglePanel}
				className={`fixed bottom-5 right-5 z-[9999] flex h-14 w-14 items-center justify-center rounded-full bg-gray-12 text-gray-1 transition-all duration-200 hover:scale-105 active:scale-95 ${isOpen ? "max-[480px]:hidden" : ""}`}
				style={{
					boxShadow:
						"0 4px 14px rgba(0, 0, 0, 0.25), 0 2px 4px rgba(0, 0, 0, 0.1)",
				}}
				aria-label={isOpen ? "Close messenger" : "Open messenger"}
			>
				{isOpen ? (
					<svg
						width="22"
						height="22"
						viewBox="0 0 24 24"
						fill="none"
						aria-hidden="true"
					>
						<path
							d="M6 9L12 15L18 9"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				) : (
					<svg
						width="22"
						height="22"
						viewBox="0 0 24 24"
						fill="none"
						aria-hidden="true"
					>
						<path
							d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"
							fill="currentColor"
						/>
					</svg>
				)}
			</button>
		</>
	);
}
