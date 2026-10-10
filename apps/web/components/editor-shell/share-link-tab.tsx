"use client";

import type { Video } from "@cap/web-domain";
import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { CheckIcon, ClockIcon, CopyIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type MouseEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { getEditorSharing } from "@/actions/videos/get-editor-sharing";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { HoverPrefetchLink } from "@/components/hover-prefetch-link";
import { formatTimestamp } from "@/lib/format-timestamp";
import {
	copyRichVideoLink,
	videoPreviewImageUrl,
} from "@/lib/video-share-clipboard";
import { usePublicEnv } from "@/utils/public-env";
import { shellTabClass } from "./editor-shell-bar";

const SharingDialog = dynamic(
	() =>
		import("@/app/(org)/dashboard/caps/components/SharingDialog").then(
			(m) => m.SharingDialog,
		),
	{ ssr: false },
);

/**
 * The recording's share link as a segment of the bar's toggle: a light for
 * who can watch it, the link itself, and Copy, which copies it the way the
 * share page does.
 */
export function ShareLinkTab({
	videoId,
	shareUrl,
	title,
	isPublic,
	active = false,
	playbackTime,
	onPrivacyClick,
	onNavigate,
	prefetchOnHover = false,
	compact = false,
}: {
	videoId: Video.VideoId;
	shareUrl: string;
	title: string;
	isPublic: boolean;
	active?: boolean;
	/** On a phone, only a way back to the share page, so the toggle fits. */
	compact?: boolean;
	/** Where the viewer is in the video, offered as a link to that moment. */
	playbackTime?: () => number;
	onPrivacyClick: () => void;
	onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
	prefetchOnHover?: boolean;
}) {
	const { webUrl } = usePublicEnv();
	const PageLink = prefetchOnHover ? HoverPrefetchLink : Link;
	const [copied, setCopied] = useState(false);
	const [moment, setMoment] = useState<number | null>(null);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = async (url: string) => {
		setMoment(null);
		try {
			await copyRichVideoLink({
				url,
				title: title || "Cap Recording",
				previewImageUrl: videoPreviewImageUrl(webUrl, videoId),
			});
			setCopied(true);
		} catch {
			toast.error("Couldn't copy the link");
		}
	};

	return (
		<div className={clsx(shellTabClass(active), "min-w-0")}>
			<button
				type="button"
				onClick={onPrivacyClick}
				aria-label={`${isPublic ? "Public" : "Private"}. Change who can watch`}
				title={
					isPublic
						? "Anyone with the link can watch"
						: "Only people you share it with can watch"
				}
				className={clsx(
					"rec-focus grid size-7 shrink-0 place-items-center rounded-md",
					compact && "max-sm:hidden",
				)}
			>
				<span
					className={clsx(
						"size-2 rounded-full",
						isPublic
							? "bg-[#22b07d] shadow-[0_0_0_3px_rgba(34,176,125,0.18)]"
							: "bg-[var(--rec-red)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--rec-red)_18%,transparent)]",
					)}
				/>
			</button>
			<PageLink
				href={`/s/${videoId}`}
				onClick={onNavigate}
				aria-current={active ? "page" : undefined}
				className={clsx(
					"rec-focus min-w-0 max-w-[16rem] truncate rounded-sm",
					compact &&
						"max-sm:flex max-sm:h-full max-sm:items-center max-sm:px-3",
				)}
			>
				{compact ? (
					<>
						<span className="max-sm:hidden">
							{shareUrl.replace(/^https?:\/\//, "")}
						</span>
						<span className="sm:hidden">Share page</span>
					</>
				) : (
					shareUrl.replace(/^https?:\/\//, "")
				)}
			</PageLink>
			<Popover.Root
				open={moment !== null}
				onOpenChange={(open) => {
					if (!open) setMoment(null);
				}}
			>
				<Popover.Anchor asChild>
					<button
						type="button"
						onClick={() => {
							const time = Math.floor(playbackTime?.() ?? 0);
							if (time > 3) setMoment(time);
							else void copy(shareUrl);
						}}
						aria-label="Copy link"
						title="Copy link"
						className={clsx(
							"rec-focus grid size-7 shrink-0 place-items-center rounded-md hover:text-[var(--rec-text-1)]",
							compact && "max-sm:hidden",
						)}
					>
						{copied ? (
							<CheckIcon className="size-3.5" aria-hidden />
						) : (
							<CopyIcon className="size-3.5" aria-hidden />
						)}
					</button>
				</Popover.Anchor>
				<Popover.Portal>
					<Popover.Content
						sideOffset={6}
						align="end"
						data-appearance={active ? "light" : undefined}
						className="cap-rec rec-pop z-[400] flex min-w-44 flex-col p-1 text-[13px]"
					>
						<button
							type="button"
							onClick={() => void copy(shareUrl)}
							className="rec-focus flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--rec-ctl-hover)]"
						>
							<CopyIcon className="size-3.5 shrink-0" aria-hidden />
							Copy link
						</button>
						{moment !== null && (
							<button
								type="button"
								onClick={() => void copy(`${shareUrl}?t=${moment}`)}
								className="rec-focus flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--rec-ctl-hover)]"
							>
								<ClockIcon className="size-3.5 shrink-0" aria-hidden />
								Copy link at {formatTimestamp(moment)}
							</button>
						)}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		</div>
	);
}

type Sharing = Awaited<ReturnType<typeof getEditorSharing>>;

/** The share link tab in the editor, with the share page's sharing settings. */
export function EditorShareLinkTab({
	videoId,
	shareUrl,
	title,
	initialPublic,
	onNavigate,
	onUpgradeRequest,
}: {
	videoId: Video.VideoId;
	shareUrl: string;
	title: string;
	initialPublic: boolean;
	onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
	onUpgradeRequest: () => void;
}) {
	const user = useCurrentUser();
	const [isPublic, setIsPublic] = useState(initialPublic);
	const [sharing, setSharing] = useState<Sharing | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);

	const refresh = async () => {
		try {
			const next = await getEditorSharing(videoId);
			setSharing(next);
			setIsPublic(next.isPublic);
			return next;
		} catch {
			toast.error("Couldn't load sharing settings");
			return null;
		}
	};

	return (
		<>
			<ShareLinkTab
				videoId={videoId}
				shareUrl={shareUrl}
				title={title}
				isPublic={isPublic}
				onNavigate={onNavigate}
				prefetchOnHover
				compact
				onPrivacyClick={async () => {
					if (sharing || (await refresh())) setDialogOpen(true);
				}}
			/>
			{sharing && (
				<SharingDialog
					isOpen={dialogOpen}
					onClose={() => {
						setDialogOpen(false);
						void refresh();
					}}
					capId={videoId}
					capName={title}
					sharedSpaces={sharing.sharedSpaces}
					onSharingUpdated={() => void refresh()}
					isPublic={sharing.isPublic}
					spacesData={sharing.spacesData}
					hasPassword={sharing.hasPassword}
					onPasswordUpdated={() => void refresh()}
					user={user}
					onUpgradeRequest={(open) => {
						if (open) onUpgradeRequest();
					}}
				/>
			)}
		</>
	);
}
