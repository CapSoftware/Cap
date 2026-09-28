"use client";

import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import { CheckIcon, CopyIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { type MouseEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { getEditorSharing } from "@/actions/videos/get-editor-sharing";
import { useCurrentUser } from "@/app/Layout/AuthContext";
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
	onPrivacyClick,
	onNavigate,
}: {
	videoId: Video.VideoId;
	shareUrl: string;
	title: string;
	isPublic: boolean;
	active?: boolean;
	onPrivacyClick: () => void;
	onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
	const { webUrl } = usePublicEnv();
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = async () => {
		try {
			await copyRichVideoLink({
				url: shareUrl,
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
				className="rec-focus grid size-7 shrink-0 place-items-center rounded-md"
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
			<Link
				href={`/s/${videoId}`}
				onClick={onNavigate}
				aria-current={active ? "page" : undefined}
				className="rec-focus min-w-0 max-w-[16rem] truncate rounded-sm"
			>
				{shareUrl.replace(/^https?:\/\//, "")}
			</Link>
			<button
				type="button"
				onClick={() => void copy()}
				aria-label="Copy link"
				title="Copy link"
				className="rec-focus grid size-7 shrink-0 place-items-center rounded-md hover:text-[var(--rec-text-1)]"
			>
				{copied ? (
					<CheckIcon className="size-3.5" aria-hidden />
				) : (
					<CopyIcon className="size-3.5" aria-hidden />
				)}
			</button>
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
