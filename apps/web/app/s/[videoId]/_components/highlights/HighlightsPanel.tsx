"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import {
	canManageHighlight,
	formatHighlightTime,
	HIGHLIGHT_LABEL_MAX_LENGTH,
	highlightDeepLink,
	highlightsAsText,
} from "@/lib/video-highlights";
import { AuthOverlay } from "../AuthOverlayLazy";
import { useOptionalPlayback } from "../playback/PlaybackContext";
import type {
	ShareHighlight,
	VideoHighlightsController,
} from "./useVideoHighlights";

const copyText = async (text: string, success: string) => {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(success);
	} catch {
		toast.error("Couldn't copy to clipboard");
	}
};

export function HighlightsPanel({
	controller,
	ownerId,
	onSeek,
}: {
	controller: VideoHighlightsController;
	ownerId: string;
	onSeek?: (time: number) => void;
}) {
	const user = useCurrentUser();
	const playback = useOptionalPlayback();
	const [showAuthOverlay, setShowAuthOverlay] = useState(false);
	const [draftLabel, setDraftLabel] = useState("");
	const { highlights } = controller;

	const currentTime = () =>
		playback?.getCurrentTime() ??
		(document.querySelector("video") as HTMLVideoElement | null)?.currentTime ??
		0;

	const addAtCurrentTime = async () => {
		if (!user) {
			setShowAuthOverlay(true);
			return;
		}
		const label = draftLabel;
		setDraftLabel("");
		await controller.add(currentTime(), label);
	};

	const pageUrl = () => window.location.href;

	return (
		<div className="flex flex-col h-full">
			<div className="flex flex-col gap-2 p-4 border-b border-gray-5">
				<form
					className="flex gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void addAtCurrentTime();
					}}
				>
					<input
						type="text"
						value={draftLabel}
						onChange={(event) => setDraftLabel(event.target.value)}
						maxLength={HIGHLIGHT_LABEL_MAX_LENGTH}
						placeholder="Label (optional)"
						aria-label="Highlight label"
						className="flex-1 min-w-0 px-3 h-9 text-sm rounded-lg border bg-gray-1 border-gray-5 text-gray-12 placeholder:text-gray-8 focus:outline-none focus:border-blue-8"
					/>
					<button
						type="submit"
						className="px-3 h-9 text-sm font-medium text-white rounded-lg shrink-0 bg-gray-12 hover:bg-gray-11"
					>
						{user ? "Highlight now" : "Sign in"}
					</button>
				</form>
				<p className="text-xs text-gray-9">
					Marks the current playback time. Press{" "}
					<kbd className="px-1 rounded border border-gray-5 bg-gray-2">H</kbd>{" "}
					while watching to drop one.
				</p>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto">
				{highlights.length === 0 ? (
					<p className="p-6 text-sm text-center text-gray-9">
						No highlights yet. Mark the moments that matter so anyone can jump
						straight to them.
					</p>
				) : (
					<ul className="divide-y divide-gray-4">
						{highlights.map((highlight) => (
							<HighlightRow
								key={highlight.id}
								highlight={highlight}
								canManage={
									!highlight.pending &&
									canManageHighlight({
										viewerId: user?.id,
										authorId: highlight.authorId,
										ownerId,
									})
								}
								onSeek={onSeek}
								onCopyLink={() =>
									copyText(
										highlightDeepLink(pageUrl(), highlight.timestamp),
										"Link copied",
									)
								}
								onRename={(label) => controller.rename(highlight.id, label)}
								onDelete={() => controller.remove(highlight.id)}
							/>
						))}
					</ul>
				)}
			</div>

			{highlights.length > 0 && (
				<div className="p-3 border-t border-gray-5">
					<button
						type="button"
						onClick={() =>
							copyText(
								highlightsAsText(highlights, pageUrl()),
								"Highlights copied",
							)
						}
						className="w-full h-8 text-xs font-medium rounded-lg border border-gray-5 text-gray-11 hover:bg-gray-2"
					>
						Copy all as text
					</button>
				</div>
			)}

			<AuthOverlay
				isOpen={showAuthOverlay}
				onClose={() => setShowAuthOverlay(false)}
			/>
		</div>
	);
}

function HighlightRow({
	highlight,
	canManage,
	onSeek,
	onCopyLink,
	onRename,
	onDelete,
}: {
	highlight: ShareHighlight;
	canManage: boolean;
	onSeek?: (time: number) => void;
	onCopyLink: () => void;
	onRename: (label: string | null) => Promise<void>;
	onDelete: () => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(highlight.label ?? "");

	const commit = async () => {
		setEditing(false);
		const next = value.trim() || null;
		if (next === highlight.label) return;
		await onRename(next);
	};

	return (
		<li
			className="group flex gap-3 items-start px-4 py-3 hover:bg-gray-2"
			data-highlight-id={highlight.id}
		>
			<button
				type="button"
				onClick={() => onSeek?.(highlight.timestamp)}
				className="mt-0.5 px-1.5 py-0.5 font-mono text-xs font-medium rounded shrink-0 bg-amber-100 text-amber-900 hover:bg-amber-200"
				aria-label={`Jump to ${formatHighlightTime(highlight.timestamp)}`}
			>
				{formatHighlightTime(highlight.timestamp)}
			</button>
			<div className="flex-1 min-w-0">
				{editing ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void commit();
						}}
					>
						<input
							ref={(input) => input?.focus()}
							type="text"
							value={value}
							maxLength={HIGHLIGHT_LABEL_MAX_LENGTH}
							onChange={(event) => setValue(event.target.value)}
							onBlur={() => void commit()}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									setValue(highlight.label ?? "");
									setEditing(false);
								}
							}}
							aria-label="Rename highlight"
							className="px-2 w-full h-7 text-sm rounded border bg-white border-gray-6 text-gray-12 focus:outline-none focus:border-blue-8"
						/>
					</form>
				) : (
					<button
						type="button"
						onClick={() => onSeek?.(highlight.timestamp)}
						className="block w-full text-sm text-left break-words text-gray-12"
					>
						{highlight.label ?? (
							<span className="text-gray-9">Untitled highlight</span>
						)}
					</button>
				)}
				{highlight.authorName && (
					<p className="mt-0.5 text-xs text-gray-9 truncate">
						{highlight.authorName}
					</p>
				)}
			</div>
			<div className="flex gap-1 items-center opacity-100 shrink-0 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
				<RowAction label="Copy link" onClick={onCopyLink} />
				{canManage && (
					<>
						<RowAction
							label="Rename"
							onClick={() => {
								setValue(highlight.label ?? "");
								setEditing(true);
							}}
						/>
						<RowAction
							label="Delete"
							destructive
							onClick={() => {
								if (window.confirm("Delete this highlight?")) void onDelete();
							}}
						/>
					</>
				)}
			</div>
		</li>
	);
}

function RowAction({
	label,
	onClick,
	destructive = false,
}: {
	label: string;
	onClick: () => void;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={
				destructive
					? "px-1.5 h-6 text-xs rounded text-red-600 hover:bg-red-50"
					: "px-1.5 h-6 text-xs rounded text-gray-10 hover:bg-gray-4 hover:text-gray-12"
			}
		>
			{label}
		</button>
	);
}
