"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import {
	adminSendMessengerMessage,
	adminSetMessengerMode,
	adminSyncMessengerKnowledge,
	fetchAdminConversation,
	fetchAdminConversations,
} from "@/actions/messenger";

interface AdminConversation {
	id: string;
	agent: string;
	mode: "agent" | "human";
	userId: string | null;
	anonymousId: string | null;
	userName: string | null;
	userEmail: string | null;
	lastMessageAt: string | null;
	latestMessage: {
		content: string;
		role: "user" | "agent" | "admin";
		createdAt: string;
	} | null;
}

interface AdminMessage {
	id: string;
	role: "user" | "agent" | "admin";
	content: string;
	createdAt: string;
}

interface ConversationDetail {
	conversation: {
		id: string;
		agent: string;
		mode: "agent" | "human";
		userId: string | null;
		anonymousId: string | null;
		userName: string | null;
		userEmail: string | null;
	};
	messages: AdminMessage[];
}

const POLL_CONVERSATIONS_MS = 4000;
const POLL_MESSAGES_MS = 2000;

function relativeTime(dateStr: string | null) {
	if (!dateStr) return "";
	const diff = Date.now() - new Date(dateStr).getTime();
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
	}).format(new Date(dateStr));
}

function formatTimestamp(dateStr: string) {
	return new Intl.DateTimeFormat("en-US", {
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	}).format(new Date(dateStr));
}

function ownerLabel(conv: {
	userName: string | null;
	userEmail: string | null;
	anonymousId: string | null;
}) {
	if (conv.userEmail) {
		return conv.userName ?? conv.userEmail;
	}
	return `Anonymous ${conv.anonymousId?.slice(0, 8) ?? "unknown"}`;
}

function ownerDetail(conv: {
	userName: string | null;
	userEmail: string | null;
	anonymousId: string | null;
}) {
	if (conv.userEmail) {
		return conv.userName
			? `${conv.userName} (${conv.userEmail})`
			: conv.userEmail;
	}
	return `Anonymous visitor (${conv.anonymousId ?? "unknown"})`;
}

function RoleBadge({ role }: { role: "user" | "agent" | "admin" }) {
	if (role === "user") {
		return (
			<span className="inline-flex items-center gap-1 text-[11px] font-medium text-gray-500">
				<span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400" />
				User
			</span>
		);
	}
	if (role === "admin") {
		return (
			<span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
				<span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
				You (Admin)
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-500">
			<span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400" />
			Millie (AI)
		</span>
	);
}

function ModeBadge({ mode }: { mode: "agent" | "human" }) {
	if (mode === "human") {
		return (
			<span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
				<span className="relative flex h-2 w-2">
					<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
					<span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
				</span>
				Live support
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200">
			<span className="inline-block h-2 w-2 rounded-full bg-violet-400" />
			AI agent
		</span>
	);
}

function ConversationList({
	conversations,
	selectedId,
	onSelect,
}: {
	conversations: AdminConversation[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	return (
		<div className="flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
			<div className="shrink-0 border-b border-gray-200 px-4 py-3">
				<div className="text-sm font-semibold text-gray-900">Conversations</div>
				<div className="mt-0.5 text-[11px] text-gray-500">
					{conversations.length} total
				</div>
			</div>
			<div className="flex-1 overflow-y-auto">
				{conversations.length === 0 ? (
					<div className="px-4 py-8 text-center text-sm text-gray-400">
						No conversations yet.
					</div>
				) : (
					conversations.map((conv) => {
						const selected = conv.id === selectedId;
						const isWaiting =
							conv.latestMessage?.role === "user" && conv.mode !== "human";
						return (
							<button
								key={conv.id}
								type="button"
								onClick={() => onSelect(conv.id)}
								className={`flex w-full flex-col gap-1 border-b border-gray-100 px-4 py-3 text-left transition-colors last:border-b-0 ${
									selected ? "bg-blue-50" : "hover:bg-gray-50"
								}`}
							>
								<div className="flex items-center justify-between gap-2">
									<span className="truncate text-[13px] font-medium text-gray-900">
										{ownerLabel(conv)}
									</span>
									<span className="shrink-0 text-[10px] tabular-nums text-gray-400">
										{relativeTime(
											conv.latestMessage?.createdAt ?? conv.lastMessageAt,
										)}
									</span>
								</div>
								<div className="flex items-center gap-2">
									<ModeBadge mode={conv.mode} />
									{isWaiting && (
										<span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-600 ring-1 ring-amber-200">
											Awaiting reply
										</span>
									)}
								</div>
								<div className="mt-0.5 truncate text-[12px] text-gray-500">
									{conv.latestMessage ? (
										<>
											<span className="font-medium text-gray-600">
												{conv.latestMessage.role === "user"
													? "User"
													: conv.latestMessage.role === "admin"
														? "You"
														: "Millie"}
												:
											</span>{" "}
											{conv.latestMessage.content}
										</>
									) : (
										"No messages yet"
									)}
								</div>
							</button>
						);
					})
				)}
			</div>
		</div>
	);
}

function MessageBubble({ message }: { message: AdminMessage }) {
	const isUser = message.role === "user";

	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div className="flex max-w-[80%] flex-col gap-1">
				<div className="flex items-center justify-between gap-3">
					<RoleBadge role={message.role} />
					<span className="text-[10px] tabular-nums text-gray-400">
						{formatTimestamp(message.createdAt)}
					</span>
				</div>
				<div
					className={`rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed ${
						isUser
							? "bg-blue-600 text-white"
							: message.role === "admin"
								? "bg-emerald-50 text-gray-900 ring-1 ring-emerald-200"
								: "bg-gray-100 text-gray-900"
					}`}
				>
					{isUser ? (
						<div className="whitespace-pre-wrap break-words">
							{message.content}
						</div>
					) : (
						<div className="admin-markdown prose prose-sm max-w-none break-words prose-p:my-1 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:text-[14px] prose-headings:font-semibold prose-p:text-[14px] prose-p:leading-relaxed prose-li:text-[14px] prose-code:text-[13px] prose-code:bg-gray-200 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none">
							<ReactMarkdown>{message.content}</ReactMarkdown>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function ChatPane({
	detail,
	onModeChange,
	onSend,
}: {
	detail: ConversationDetail;
	onModeChange: (mode: "agent" | "human") => void;
	onSend: (content: string) => void;
}) {
	const bottomRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [input, setInput] = useState("");
	const prevMessageCountRef = useRef(detail.messages.length);
	const userScrolledRef = useRef(false);

	const scrollToBottom = useCallback((instant?: boolean) => {
		bottomRef.current?.scrollIntoView({
			behavior: instant ? "instant" : "smooth",
		});
	}, []);

	useEffect(() => {
		scrollToBottom(true);
	}, [scrollToBottom]);

	useEffect(() => {
		if (detail.messages.length > prevMessageCountRef.current) {
			if (!userScrolledRef.current) {
				scrollToBottom();
			}
		}
		prevMessageCountRef.current = detail.messages.length;
	}, [detail.messages.length, scrollToBottom]);

	const handleScroll = useCallback(() => {
		const container = scrollContainerRef.current;
		if (!container) return;
		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		userScrolledRef.current = distanceFromBottom > 100;
	}, []);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const text = input.trim();
		if (!text) return;
		setInput("");
		if (inputRef.current) inputRef.current.style.height = "auto";
		onSend(text);
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
		el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
	};

	const conv = detail.conversation;

	return (
		<div className="flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
			<div className="shrink-0 border-b border-gray-200 px-5 py-4">
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-3">
							<h2 className="truncate text-base font-semibold text-gray-900">
								{ownerDetail(conv)}
							</h2>
							<ModeBadge mode={conv.mode} />
						</div>
						<div className="mt-1 flex items-center gap-2 text-[12px] text-gray-500">
							<span>Agent: Millie</span>
							<span className="text-gray-300">|</span>
							<span className="font-mono text-[11px]">{conv.id}</span>
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{conv.mode === "human" ? (
							<button
								type="button"
								onClick={() => onModeChange("agent")}
								className="rounded-lg border border-gray-300 px-3 py-1.5 text-[12px] font-medium text-gray-700 transition hover:bg-gray-50"
							>
								Return to AI
							</button>
						) : (
							<button
								type="button"
								onClick={() => onModeChange("human")}
								className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-emerald-700"
							>
								Take over
							</button>
						)}
					</div>
				</div>
			</div>

			<div
				ref={scrollContainerRef}
				onScroll={handleScroll}
				className="flex-1 overflow-y-auto px-5 py-4"
			>
				{detail.messages.length === 0 ? (
					<div className="flex h-full items-center justify-center text-sm text-gray-400">
						No messages in this conversation.
					</div>
				) : (
					<div className="space-y-4">
						{detail.messages.map((msg) => (
							<MessageBubble key={msg.id} message={msg} />
						))}
					</div>
				)}
				<div ref={bottomRef} />
			</div>

			<form
				onSubmit={handleSubmit}
				className="shrink-0 border-t border-gray-200 bg-gray-50 px-5 py-3"
			>
				<div className="flex items-end gap-3">
					<textarea
						ref={inputRef}
						value={input}
						onChange={handleInputChange}
						onKeyDown={handleKeyDown}
						placeholder="Reply as admin... (Enter to send, Shift+Enter for new line)"
						rows={1}
						className="flex-1 resize-none rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-[14px] text-gray-900 outline-none transition-colors placeholder:text-gray-400 hover:border-gray-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
					/>
					<button
						type="submit"
						disabled={!input.trim()}
						className="flex h-10 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-[13px] font-medium text-white transition hover:bg-emerald-700 disabled:opacity-40"
					>
						Send
					</button>
				</div>
			</form>
		</div>
	);
}

export function AdminPanel({
	supermemoryConfigured,
	knowledgeTag,
}: {
	supermemoryConfigured: boolean;
	knowledgeTag: string;
}) {
	const [conversations, setConversations] = useState<AdminConversation[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<ConversationDetail | null>(null);
	const [isLoadingList, setIsLoadingList] = useState(true);
	const [isLoadingDetail, setIsLoadingDetail] = useState(false);
	const [isSyncing, startSync] = useTransition();
	const detailIdRef = useRef<string | null>(null);

	const loadConversations = useCallback(async () => {
		const data = await fetchAdminConversations().catch(() => null);
		if (data) setConversations(data);
		setIsLoadingList(false);
		return data;
	}, []);

	const loadDetail = useCallback(async (conversationId: string) => {
		const data = await fetchAdminConversation(conversationId).catch(() => null);
		if (data && detailIdRef.current === conversationId) {
			setDetail(data);
		}
		return data;
	}, []);

	const selectConversation = useCallback(
		async (id: string) => {
			setSelectedId(id);
			detailIdRef.current = id;
			setIsLoadingDetail(true);
			await loadDetail(id);
			setIsLoadingDetail(false);
		},
		[loadDetail],
	);

	useEffect(() => {
		loadConversations();
	}, [loadConversations]);

	useEffect(() => {
		const interval = setInterval(() => {
			loadConversations();
		}, POLL_CONVERSATIONS_MS);
		return () => clearInterval(interval);
	}, [loadConversations]);

	useEffect(() => {
		if (!selectedId) return;
		const interval = setInterval(() => {
			if (detailIdRef.current === selectedId) {
				loadDetail(selectedId);
			}
		}, POLL_MESSAGES_MS);
		return () => clearInterval(interval);
	}, [selectedId, loadDetail]);

	const handleModeChange = useCallback(
		async (mode: "agent" | "human") => {
			if (!selectedId) return;
			await adminSetMessengerMode({ conversationId: selectedId, mode });
			await loadDetail(selectedId);
			await loadConversations();
		},
		[selectedId, loadDetail, loadConversations],
	);

	const handleSend = useCallback(
		async (content: string) => {
			if (!selectedId || !detail) return;
			setDetail((prev) => {
				if (!prev) return prev;
				return {
					...prev,
					conversation: { ...prev.conversation, mode: "human" },
					messages: [
						...prev.messages,
						{
							id: `optimistic-${Date.now()}`,
							role: "admin" as const,
							content,
							createdAt: new Date().toISOString(),
						},
					],
				};
			});
			await adminSendMessengerMessage({
				conversationId: selectedId,
				content,
			});
			await loadDetail(selectedId);
			await loadConversations();
		},
		[selectedId, detail, loadDetail, loadConversations],
	);

	const handleSync = () => {
		startSync(async () => {
			await adminSyncMessengerKnowledge();
		});
	};

	return (
		<div className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10">
			<div className="mb-6 flex flex-wrap items-center justify-between gap-3">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-gray-900">
						Messenger Admin
					</h1>
					<p className="mt-1 text-sm text-gray-500">
						Manage conversations, take over from AI, and reply to users in
						real-time.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Link
						href="/messenger"
						className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
					>
						Open messenger
					</Link>
					<button
						type="button"
						disabled={isSyncing}
						onClick={handleSync}
						className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-gray-800 disabled:opacity-50"
					>
						{isSyncing ? "Syncing..." : "Sync knowledge"}
					</button>
				</div>
			</div>

			<div className="mb-5 flex items-center gap-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-[12px]">
				<div className="flex items-center gap-2">
					<span className="font-medium text-gray-600">Supermemory:</span>
					<span
						className={
							supermemoryConfigured ? "text-emerald-600" : "text-amber-600"
						}
					>
						{supermemoryConfigured ? "Connected" : "Not configured"}
					</span>
				</div>
				<span className="text-gray-300">|</span>
				<div className="flex items-center gap-2">
					<span className="font-medium text-gray-600">Knowledge tag:</span>
					<span className="font-mono text-gray-500">{knowledgeTag}</span>
				</div>
				<span className="text-gray-300">|</span>
				<div className="flex items-center gap-2">
					<span className="font-medium text-gray-600">Polling:</span>
					<span className="text-emerald-600">Active</span>
				</div>
			</div>

			<div className="grid gap-5" style={{ gridTemplateColumns: "380px 1fr" }}>
				{isLoadingList && conversations.length === 0 ? (
					<div className="flex h-[75vh] items-center justify-center rounded-xl border border-gray-200 bg-white">
						<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600" />
					</div>
				) : (
					<div className="h-[75vh]">
						<ConversationList
							conversations={conversations}
							selectedId={selectedId}
							onSelect={selectConversation}
						/>
					</div>
				)}

				<div className="h-[75vh]">
					{selectedId && isLoadingDetail && !detail ? (
						<div className="flex h-full items-center justify-center rounded-xl border border-gray-200 bg-white">
							<div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-gray-600" />
						</div>
					) : detail ? (
						<ChatPane
							detail={detail}
							onModeChange={handleModeChange}
							onSend={handleSend}
						/>
					) : (
						<div className="flex h-full items-center justify-center rounded-xl border border-gray-200 bg-white text-sm text-gray-400">
							Select a conversation from the left.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
