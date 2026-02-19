import { buildEnv } from "@cap/env";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createMessengerConversation } from "@/actions/messenger";
import { listViewerMessengerConversations } from "@/lib/messenger/data";

const relativeTime = (date: Date | null) => {
	if (!date) return "";
	const diff = Date.now() - date.getTime();
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
	}).format(date);
};

export default async function MessengerPage() {
	if (buildEnv.NEXT_PUBLIC_IS_CAP !== "true") notFound();

	const { viewer, conversations } = await listViewerMessengerConversations();

	async function startConversation() {
		"use server";
		const conversationId = await createMessengerConversation();
		redirect(`/messenger/${conversationId}`);
	}

	return (
		<div className="flex min-h-[100dvh] flex-col bg-gray-1">
			<div className="relative overflow-hidden bg-gradient-to-b from-blue-600 via-blue-600 to-blue-700 px-5 pb-12 pt-12 text-center md:pb-14 md:pt-16">
				<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.12),transparent_50%)]" />
				<div className="relative mx-auto max-w-lg">
					<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 ring-1 ring-white/20">
						<svg
							width="20"
							height="20"
							viewBox="0 0 24 24"
							fill="none"
							className="text-white"
							aria-hidden="true"
						>
							<path
								d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"
								fill="currentColor"
							/>
						</svg>
					</div>
					<h1 className="text-2xl font-bold tracking-tight text-white">
						Cap Support
					</h1>
					<p className="mt-1.5 text-sm text-blue-100/80">
						How can we help you today?
					</p>
				</div>
			</div>

			<div className="mx-auto w-full max-w-lg px-5">
				<div className="-mt-5">
					<form action={startConversation}>
						<button
							type="submit"
							className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-white px-4 py-3.5 text-sm font-semibold text-gray-12 shadow-lg shadow-black/[0.06] ring-1 ring-black/[0.04] transition-all hover:shadow-xl hover:shadow-black/[0.08] active:scale-[0.99]"
						>
							<svg
								width="16"
								height="16"
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
							Start a new chat
						</button>
					</form>
				</div>

				{conversations.length > 0 && (
					<div className="mt-8">
						<div className="mb-3 flex items-center justify-between px-1">
							<span className="text-xs font-medium uppercase tracking-wider text-gray-9">
								Your conversations
							</span>
							<span className="text-[11px] tabular-nums text-gray-8">
								{conversations.length}
							</span>
						</div>
						<div className="overflow-hidden rounded-xl border border-gray-3 bg-white shadow-sm shadow-black/[0.02]">
							{conversations.map((conversation, index) => (
								<Link
									key={conversation.id}
									href={`/messenger/${conversation.id}`}
									className={`flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-blue-50/50 active:bg-blue-50 ${
										index < conversations.length - 1
											? "border-b border-gray-3"
											: ""
									}`}
								>
									<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-xs font-semibold text-white">
										{conversation.agent[0]}
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center justify-between gap-2">
											<span className="text-sm font-medium text-gray-12">
												{conversation.agent}
											</span>
											<span className="shrink-0 text-[11px] tabular-nums text-gray-8">
												{relativeTime(
													conversation.latestMessage?.createdAt ??
														conversation.lastMessageAt,
												)}
											</span>
										</div>
										<div className="mt-0.5 truncate text-xs text-gray-10">
											{conversation.latestMessage?.content ?? "No messages yet"}
										</div>
									</div>
								</Link>
							))}
						</div>
					</div>
				)}

				<div className="mt-10 pb-12 text-center">
					{viewer.user ? (
						<div className="flex items-center justify-center gap-2 text-xs text-gray-9">
							<div className="h-1.5 w-1.5 rounded-full bg-green-500" />
							<span>{viewer.user.name ?? viewer.user.email}</span>
							{viewer.isAdmin && (
								<Link
									href="/admin"
									className="ml-1 text-gray-8 underline decoration-gray-6 underline-offset-2 transition-colors hover:text-gray-12"
								>
									Admin
								</Link>
							)}
						</div>
					) : (
						<div className="flex items-center justify-center gap-3 text-xs">
							<Link
								href="/login?next=%2Fmessenger"
								className="text-gray-10 underline decoration-gray-6 underline-offset-2 transition-colors hover:text-gray-12"
							>
								Sign in
							</Link>
							<span className="text-gray-6">or</span>
							<Link
								href="/signup?next=%2Fmessenger"
								className="text-gray-10 underline decoration-gray-6 underline-offset-2 transition-colors hover:text-gray-12"
							>
								Create account
							</Link>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
