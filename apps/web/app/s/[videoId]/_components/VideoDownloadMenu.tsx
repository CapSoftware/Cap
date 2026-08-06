"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import { classNames } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { Download, MoreVertical } from "lucide-react";
import { useVideoDownload } from "./use-video-download";

export function VideoDownloadMenu({
	videoId,
	hasEdits,
	align = "end",
	triggerClassName,
	triggerLabel = "Video options",
	trigger,
}: {
	videoId: Video.VideoId;
	hasEdits: boolean;
	align?: "start" | "center" | "end";
	triggerClassName?: string;
	triggerLabel?: string;
	/** Trigger contents. Defaults to the editor's dots glyph. */
	trigger?: React.ReactNode;
}) {
	const { download, isDownloading } = useVideoDownload(videoId);

	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label={triggerLabel}
					title={triggerLabel}
					disabled={isDownloading}
					className={classNames(
						"inline-flex items-center justify-center transition disabled:pointer-events-none disabled:opacity-40",
						triggerClassName ??
							"size-9 rounded-full text-gray-12 hover:bg-gray-3 active:bg-gray-4",
					)}
				>
					{trigger ?? <MoreVertical className="size-4" aria-hidden />}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align} sideOffset={6} className="min-w-52">
				{hasEdits ? (
					<>
						<DropdownMenuItem
							className="flex gap-2 items-center"
							onClick={() => download("current")}
						>
							<Download className="size-3.5 shrink-0" aria-hidden />
							<span className="text-sm text-gray-12">
								Download current video
							</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							className="flex gap-2 items-center"
							onClick={() => download("original")}
						>
							<Download className="size-3.5 shrink-0" aria-hidden />
							<span className="text-sm text-gray-12">
								Download original video
							</span>
						</DropdownMenuItem>
					</>
				) : (
					<DropdownMenuItem
						className="flex gap-2 items-center"
						onClick={() => download("current")}
					>
						<Download className="size-3.5 shrink-0" aria-hidden />
						<span className="text-sm text-gray-12">Download video</span>
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
