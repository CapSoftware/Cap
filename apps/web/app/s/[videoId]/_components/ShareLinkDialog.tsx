"use client";

import { Dialog, DialogContent, DialogTitle } from "@cap/ui";
import clsx from "clsx";
import { Check, CodeXml, Link2, Lock, Megaphone, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	FacebookIcon,
	GoogleIcon,
	LinkedInIcon,
	XIcon,
} from "@/components/icons/Social";
import { buildEmbedCode } from "@/lib/embed-code";
import {
	type ShareTargetId,
	shareTargetHref,
	socialShareUrl,
} from "@/lib/social-share";
import {
	copyRichVideoLink,
	videoPreviewImageUrl,
} from "@/lib/video-share-clipboard";
import { usePublicEnv } from "@/utils/public-env";
import { useOptionalPlayback } from "./playback/PlaybackContext";
import { formatClock } from "./timeline/timeline-format";

type ShareTab = "social" | "embed";

/**
 * Order matters: it's the order people actually reach for, not alphabetical.
 * Each icon carries its own sizing because the brand marks have wildly
 * different amounts of padding baked into their viewBoxes.
 */
const SHARE_TARGETS: {
	id: ShareTargetId;
	label: string;
	Icon: (props: { className?: string }) => React.JSX.Element;
	iconClassName: string;
}[] = [
	{
		id: "linkedin",
		label: "Share on LinkedIn",
		Icon: LinkedInIcon,
		iconClassName: "size-6",
	},
	{
		id: "x",
		label: "Share on X",
		Icon: XIcon,
		iconClassName: "size-[18px] text-gray-12",
	},
	{
		id: "facebook",
		label: "Share on Facebook",
		Icon: FacebookIcon,
		iconClassName: "size-6",
	},
	{
		id: "gmail",
		label: "Share in Gmail",
		Icon: GoogleIcon,
		iconClassName: "size-5",
	},
];

const TABS: { id: ShareTab; label: string; Icon: typeof Megaphone }[] = [
	{ id: "social", label: "Social", Icon: Megaphone },
	{ id: "embed", label: "Embed", Icon: CodeXml },
];

/**
 * Where the video is *right now*, for the "share at this moment" option.
 * Prefers the playback store (already tracking the element) and falls back to
 * the DOM so the dialog still works in trees without a provider.
 */
const readCurrentTime = (currentTime: number | undefined): number => {
	const fromStore = currentTime ?? document.querySelector("video")?.currentTime;
	return Number.isFinite(fromStore) && (fromStore as number) > 0
		? Math.floor(fromStore as number)
		: 0;
};

export const ShareLinkDialog = ({
	open,
	onOpenChange,
	videoId,
	videoTitle,
	shareUrl,
	isPublic,
	canManageAccess = false,
	onManageAccess,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	videoId: string;
	videoTitle: string;
	/** Custom-domain aware share link, without any query string. */
	shareUrl: string;
	isPublic: boolean;
	canManageAccess?: boolean;
	onManageAccess?: () => void;
}) => {
	const { webUrl } = usePublicEnv();
	const playback = useOptionalPlayback();
	const [tab, setTab] = useState<ShareTab>("social");
	const [withTimestamp, setWithTimestamp] = useState(false);
	const [startTime, setStartTime] = useState(0);
	const [copied, setCopied] = useState(false);

	// The offset is sampled once, when the dialog opens. Subscribing would
	// re-render the dialog at frame rate while the video plays on behind it, and
	// a label that ticks while you're reading it is worse than one that doesn't.
	useEffect(() => {
		if (!open) return;
		setStartTime(readCurrentTime(playback?.getCurrentTime()));
		setTab("social");
		setWithTimestamp(false);
		setCopied(false);
	}, [open, playback]);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);

	const timestamp = withTimestamp ? startTime : null;

	const targetUrl = useMemo(
		() => socialShareUrl({ url: shareUrl, timestamp }),
		[shareUrl, timestamp],
	);

	const embedCode = useMemo(
		() => buildEmbedCode({ webUrl, videoId, startTime: timestamp }),
		[webUrl, videoId, timestamp],
	);

	const handleCopy = useCallback(async () => {
		try {
			if (tab === "embed") {
				await navigator.clipboard.writeText(embedCode);
			} else {
				await copyRichVideoLink({
					url: targetUrl,
					title: videoTitle || "Cap Recording",
					previewImageUrl: videoPreviewImageUrl(webUrl, videoId),
				});
			}
			setCopied(true);
		} catch {
			toast.error(
				tab === "embed" ? "Failed to copy embed code" : "Failed to copy link",
			);
		}
	}, [tab, embedCode, targetUrl, videoTitle, webUrl, videoId]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				hideCloseButton
				aria-describedby={undefined}
				className="w-[calc(100vw-2rem)] max-w-[34rem] overflow-hidden rounded-2xl border bg-gray-1 border-gray-4"
			>
				<div className="flex items-center gap-3 px-6 pt-6 pb-5">
					<DialogTitle className="flex-1 text-2xl font-bold text-gray-12">
						Share
					</DialogTitle>
					<div className="flex items-center gap-1">
						{TABS.map(({ id, label, Icon }) => {
							const active = tab === id;
							return (
								<button
									key={id}
									type="button"
									aria-pressed={active}
									onClick={() => setTab(id)}
									className={clsx(
										"flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[15px] font-medium transition-colors",
										"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-1",
										active
											? "border-blue-8 bg-blue-2 text-blue-11"
											: "border-transparent text-gray-11 hover:bg-gray-3",
									)}
								>
									<Icon className="size-4" aria-hidden />
									{label}
								</button>
							);
						})}
					</div>
					<button
						type="button"
						onClick={() => onOpenChange(false)}
						aria-label="Close"
						className="rounded-lg p-1 text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
					>
						<X className="size-5" aria-hidden />
					</button>
				</div>

				<div className="px-6 pb-5">
					{!isPublic && (
						<div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
							<Lock className="mt-0.5 size-4 shrink-0 text-amber-600" />
							<div className="min-w-0 flex-1">
								<p className="text-sm text-amber-900">
									This Cap isn't public, so anyone you share it with will be
									asked to sign in and will need access.
								</p>
								{canManageAccess && onManageAccess && (
									<button
										type="button"
										onClick={onManageAccess}
										className="mt-1 text-sm font-semibold text-amber-900 underline underline-offset-2 hover:text-amber-600"
									>
										Change access
									</button>
								)}
							</div>
						</div>
					)}

					{tab === "social" ? (
						<div className="flex flex-col gap-3">
							{SHARE_TARGETS.map(({ id, label, Icon, iconClassName }) => (
								<a
									key={id}
									href={shareTargetHref({
										target: id,
										url: targetUrl,
										title: videoTitle || "Cap Recording",
									})}
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center gap-4 rounded-xl border border-gray-4 bg-gray-1 px-4 py-3.5 transition-colors hover:border-gray-6 hover:bg-gray-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
								>
									<span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gray-3">
										<Icon className={iconClassName} />
									</span>
									<span className="text-[15px] font-semibold text-gray-12">
										{label}
									</span>
								</a>
							))}
						</div>
					) : (
						<div className="flex flex-col gap-3">
							<div className="rounded-xl border border-gray-4 bg-gray-3 p-4">
								<code className="block max-h-40 overflow-y-auto break-all font-mono text-xs leading-relaxed text-gray-11">
									{embedCode}
								</code>
							</div>
							<p className="text-sm text-gray-10">
								Paste this wherever HTML is allowed. The player keeps its aspect
								ratio and fills the width it's given.
							</p>
						</div>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-gray-4 px-6 py-4">
					<button
						type="button"
						onClick={handleCopy}
						className="flex items-center gap-2.5 rounded-lg text-[15px] font-medium text-gray-12 transition-colors hover:text-gray-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
					>
						{copied ? (
							<Check className="size-5 text-green-500" aria-hidden />
						) : tab === "embed" ? (
							<CodeXml className="size-5" aria-hidden />
						) : (
							<Link2 className="size-5" aria-hidden />
						)}
						{copied
							? "Copied"
							: tab === "embed"
								? "Copy embed code"
								: "Copy link"}
					</button>

					<label className="flex cursor-pointer items-center gap-3 text-[15px] font-medium text-gray-12">
						<input
							type="checkbox"
							checked={withTimestamp}
							onChange={(event) => setWithTimestamp(event.target.checked)}
							className="peer sr-only"
						/>
						<span
							aria-hidden
							className={clsx(
								"flex size-6 shrink-0 items-center justify-center rounded-md border-2 transition-colors",
								"peer-focus-visible:ring-2 peer-focus-visible:ring-blue-9 peer-focus-visible:ring-offset-1",
								withTimestamp
									? "border-blue-9 bg-blue-9 text-white"
									: "border-gray-12 bg-transparent",
							)}
						>
							{withTimestamp && <Check className="size-4" strokeWidth={3} />}
						</span>
						Share video at {formatClock(startTime)}
					</label>
				</div>
			</DialogContent>
		</Dialog>
	);
};

export default ShareLinkDialog;
