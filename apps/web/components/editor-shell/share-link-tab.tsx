"use client";

import type { Video } from "@cap/web-domain";
import * as Popover from "@radix-ui/react-popover";
import clsx from "clsx";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getEditorSharing } from "@/actions/videos/get-editor-sharing";
import { useCurrentUser } from "@/app/Layout/AuthContext";

const SharingDialog = dynamic(
	() =>
		import("@/app/(org)/dashboard/caps/components/SharingDialog").then(
			(m) => m.SharingDialog,
		),
	{ ssr: false },
);

type Sharing = Awaited<ReturnType<typeof getEditorSharing>>;

/**
 * The recording's share link, shown beside the Editor tab: a light for
 * whether anyone can watch it, the link itself, and the same sharing
 * settings as the share page.
 */
export function ShareLinkTab({
	videoId,
	capName,
	initialPublic,
	onUpgradeRequest,
}: {
	videoId: Video.VideoId;
	capName: string;
	initialPublic: boolean;
	onUpgradeRequest: () => void;
}) {
	const user = useCurrentUser();
	const [isPublic, setIsPublic] = useState(initialPublic);
	const [sharing, setSharing] = useState<Sharing | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const [shareUrl, setShareUrl] = useState(`/s/${videoId}`);

	useEffect(() => {
		setShareUrl(new URL(`/s/${videoId}`, window.location.origin).toString());
	}, [videoId]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1800);
		return () => clearTimeout(timer);
	}, [copied]);

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

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(shareUrl);
			setCopied(true);
		} catch {
			toast.error("Couldn't copy the link");
		}
	};

	const displayUrl = shareUrl.replace(/^https?:\/\//, "");

	return (
		<>
			<Popover.Root>
				<Popover.Trigger
					className="rec-focus flex h-7 min-w-0 max-w-[16rem] items-center gap-2 rounded-md px-3 text-[13px] font-medium text-[var(--rec-text-2)] transition-colors hover:text-[var(--rec-text-1)] data-[state=open]:text-[var(--rec-text-1)]"
					aria-label={`Share link, ${isPublic ? "public" : "private"}`}
				>
					<span
						className={clsx(
							"size-2 shrink-0 rounded-full",
							isPublic
								? "bg-[#22b07d] shadow-[0_0_0_3px_rgba(34,176,125,0.18)]"
								: "bg-[var(--rec-red)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--rec-red)_18%,transparent)]",
						)}
					/>
					<span className="truncate">{displayUrl}</span>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						sideOffset={8}
						align="center"
						className="cap-rec rec-pop z-[400] flex w-[22rem] flex-col gap-3 p-3"
					>
						<div className="flex items-start gap-2.5 px-0.5">
							<span
								className={clsx(
									"mt-1.5 size-2 shrink-0 rounded-full",
									isPublic ? "bg-[#22b07d]" : "bg-[var(--rec-red)]",
								)}
							/>
							<div className="flex min-w-0 flex-col">
								<span className="text-[13px] font-medium text-[var(--rec-text-1)]">
									{isPublic ? "Public" : "Private"}
								</span>
								<span className="text-[12px] text-[var(--rec-text-2)]">
									{isPublic
										? "Anyone with the link can watch."
										: "Only you and the people or spaces you share it with can watch."}
								</span>
							</div>
						</div>
						<div className="flex h-9 items-center gap-1 rounded-[10px] bg-[var(--rec-ctl)] pl-3 pr-1">
							<span className="min-w-0 flex-1 truncate text-[13px] text-[var(--rec-text-1)]">
								{displayUrl}
							</span>
							<button
								type="button"
								onClick={() => void copy()}
								className="rec-btn is-accent !h-7 !px-2.5 text-[12px]"
							>
								{copied ? (
									<CheckIcon className="size-3.5" aria-hidden />
								) : (
									<CopyIcon className="size-3.5" aria-hidden />
								)}
								{copied ? "Copied" : "Copy link"}
							</button>
						</div>
						<div className="flex items-center justify-between gap-2">
							<button
								type="button"
								onClick={async () => {
									if (sharing || (await refresh())) setDialogOpen(true);
								}}
								className="rec-btn is-ghost !h-8 text-[12px]"
							>
								Sharing settings
							</button>
							<a
								href={`/s/${videoId}`}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--rec-accent)] hover:underline"
							>
								Open share page
								<ExternalLinkIcon className="size-3.5" aria-hidden />
							</a>
						</div>
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
			{sharing && (
				<SharingDialog
					isOpen={dialogOpen}
					onClose={() => {
						setDialogOpen(false);
						void refresh();
					}}
					capId={videoId}
					capName={capName}
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
