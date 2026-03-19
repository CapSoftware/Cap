"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	fetchMessengerConversation,
	sendMessengerUserMessage,
} from "@/actions/messenger";
import { MESSENGER_SUGGESTED_PROMPTS } from "@/lib/messenger/constants";

interface ChatMessage {
	id: string;
	role: "user" | "agent" | "admin";
	content: string;
}

interface ChatConversation {
	id: string;
	agent: string;
	mode: "agent" | "human";
}

interface ChatWindowProps {
	conversation: ChatConversation;
	initialMessages: ChatMessage[];
}

function AgentAvatar({
	name,
	size = "sm",
}: {
	name: string;
	size?: "sm" | "md";
}) {
	const dims = size === "md" ? "h-8 w-8 text-xs" : "h-6 w-6 text-[10px]";
	return (
		<div
			className={`${dims} flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 font-semibold text-white`}
		>
			{name[0]}
		</div>
	);
}

function TypingDots() {
	return (
		<div className="flex items-center gap-1.5">
			{[0, 1, 2].map((i) => (
				<div
					key={i}
					className="h-1.5 w-1.5 rounded-full bg-blue-400/60"
					style={{
						animation: "msg-typing 1.4s ease-in-out infinite",
						animationDelay: `${i * 0.15}s`,
					}}
				/>
			))}
		</div>
	);
}

function MessageBubble({
	message,
	agentName,
	showAvatar,
}: {
	message: ChatMessage;
	agentName: string;
	showAvatar: boolean;
}) {
	if (message.role === "user") {
		return (
			<div className="flex justify-end pl-12">
				<div className="rounded-2xl rounded-br-md bg-gradient-to-br from-blue-500 to-blue-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">
					<div className="whitespace-pre-wrap break-words">
						{message.content}
					</div>
				</div>
			</div>
		);
	}

	const isAdmin = message.role === "admin";
	const label = isAdmin ? "Cap Team" : agentName;

	return (
		<div className="flex items-end gap-2 pr-12">
			{showAvatar ? (
				<AgentAvatar name={agentName} />
			) : (
				<div className="w-6 shrink-0" />
			)}
			<div>
				{showAvatar && (
					<div
						className={`mb-1 ml-1 flex items-center gap-1.5 text-[11px] font-medium ${isAdmin ? "text-emerald-600" : "text-gray-9"}`}
					>
						{isAdmin && (
							<span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
						)}
						{label}
					</div>
				)}
				<div
					className={`rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-relaxed text-gray-12 ${
						isAdmin ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-gray-3"
					}`}
				>
					<div className="messenger-markdown prose prose-sm max-w-none break-words prose-p:my-1 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-strong:text-gray-12 prose-a:text-blue-600 prose-a:underline hover:prose-a:text-blue-500 prose-headings:text-gray-12 prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:text-sm prose-headings:font-semibold prose-p:text-sm prose-p:leading-relaxed prose-li:text-sm prose-code:text-[13px] prose-code:bg-gray-4 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none">
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

const FULLPAGE_POLL_MS = 3000;

export function ChatWindow({
	conversation: initialConversation,
	initialMessages,
}: ChatWindowProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const [input, setInput] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
	const [conversation, setConversation] =
		useState<ChatConversation>(initialConversation);
	const [isPending, startTransition] = useTransition();
	const prevMessageCountRef = useRef(initialMessages.length);
	const userScrolledRef = useRef(false);
	const isSendingRef = useRef(false);

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

	const handleScroll = useCallback(() => {
		const container = scrollRef.current;
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
			setMessages(data.messages);
			setConversation(data.conversation);
		}, FULLPAGE_POLL_MS);
		return () => clearInterval(interval);
	}, [initialConversation.id]);

	const sendMessage = (text: string) => {
		if (!text || isPending) return;

		setInput("");
		if (inputRef.current) {
			inputRef.current.style.height = "auto";
		}

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
		el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
	};

	const showTyping = isPending && conversation.mode === "agent";

	return (
		<div className="mx-auto flex h-[100dvh] max-w-2xl flex-col bg-gray-1">
			<style>{`
				@keyframes msg-typing {
					0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
					30% { opacity: 1; transform: translateY(-3px); }
				}
			`}</style>

			<div className="border-b border-gray-3">
				<div className="h-[3px] bg-gradient-to-r from-blue-400 via-blue-500 to-blue-600" />
				<div className="flex items-center gap-3 px-4 py-3">
					<Link
						href="/messenger"
						className="flex h-8 w-8 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
						aria-label="Back to inbox"
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
					</Link>
					<AgentAvatar name="Millie" size="md" />
					<div className="flex-1">
						<div className="text-sm font-semibold text-gray-12">
							Cap Support
						</div>
						<div className="text-[11px] text-gray-9">
							{conversation.mode === "human" ? "Cap Team" : "Millie"}
						</div>
					</div>
					{conversation.mode === "human" && (
						<div className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
							<span className="relative flex h-2 w-2">
								<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
								<span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
							</span>
							Live support
						</div>
					)}
				</div>
			</div>

			<div
				ref={scrollRef}
				onScroll={handleScroll}
				className="flex-1 overflow-y-auto overscroll-contain px-4 py-5"
			>
				{messages.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center pb-10">
						<div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 ring-1 ring-blue-100">
							<AgentAvatar name="Millie" size="md" />
						</div>
						<p className="mt-4 text-sm font-medium text-gray-12">
							Chat with Millie
						</p>
						<p className="mt-1 max-w-[240px] text-center text-xs leading-relaxed text-gray-9">
							Ask anything about Cap
						</p>
						<div className="mt-5 flex flex-wrap justify-center gap-2 px-4">
							{MESSENGER_SUGGESTED_PROMPTS.map((prompt) => (
								<button
									key={prompt}
									type="button"
									onClick={() => sendMessage(prompt)}
									disabled={isPending}
									className="rounded-full border border-gray-4 bg-gray-2 px-3.5 py-2 text-xs text-gray-11 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-50"
								>
									{prompt}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="space-y-3">
						{messages.map((message, index) => {
							const prev = messages[index - 1];
							const showAvatar =
								message.role !== "user" && (!prev || prev.role === "user");

							return (
								<MessageBubble
									key={message.id}
									message={message}
									agentName="Millie"
									showAvatar={showAvatar}
								/>
							);
						})}
						{showTyping && (
							<div className="flex items-end gap-2 pr-12">
								<AgentAvatar name="Millie" />
								<div className="rounded-2xl rounded-bl-md bg-gray-3 px-4 py-3">
									<TypingDots />
								</div>
							</div>
						)}
					</div>
				)}
				<div ref={bottomRef} />
			</div>

			<div className="border-t border-gray-3 bg-gray-1 px-4 py-3">
				<form onSubmit={handleSubmit} className="flex items-end gap-2.5">
					<textarea
						ref={inputRef}
						value={input}
						onChange={handleInputChange}
						onKeyDown={handleKeyDown}
						placeholder="Type a message..."
						disabled={isPending}
						rows={1}
						className="flex-1 resize-none rounded-xl border border-gray-4 bg-gray-2 px-4 py-2.5 text-sm text-gray-12 outline-none transition-colors placeholder:text-gray-8 hover:border-gray-5 focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 disabled:opacity-50"
					/>
					<button
						type="submit"
						disabled={isPending || !input.trim()}
						aria-label="Send message"
						className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white transition-all hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600"
					>
						<svg
							width="16"
							height="16"
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
