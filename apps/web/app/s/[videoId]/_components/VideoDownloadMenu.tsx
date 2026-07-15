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
import { useState } from "react";
import { toast } from "sonner";
import {
	getVideoDownloadInfo,
	type VideoDownloadVariant,
} from "@/actions/videos/download";

export function VideoDownloadMenu({
	videoId,
	hasEdits,
	align = "end",
	triggerClassName,
	triggerLabel = "视频选项",
}: {
	videoId: Video.VideoId;
	hasEdits: boolean;
	align?: "start" | "center" | "end";
	triggerClassName?: string;
	triggerLabel?: string;
}) {
	const [isDownloading, setIsDownloading] = useState(false);

	const handleDownload = (variant: VideoDownloadVariant) => {
		if (isDownloading) return;
		setIsDownloading(true);

		const run = async () => {
			const result = await getVideoDownloadInfo(videoId, variant);
			if (!result.success) {
				throw new Error(result.error);
			}

			const { downloadUrl, filename } = result;
			const response = await fetch(downloadUrl);
			if (!response.ok) throw new Error("下载视频失败");
			const blob = await response.blob();
			const blobUrl = window.URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = blobUrl;
			link.download = filename;
			link.style.display = "none";
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			window.URL.revokeObjectURL(blobUrl);
		};

		const promise = run();
		toast.promise(promise, {
			loading: "正在准备下载…",
			success: "下载已开始",
			error: (error) =>
				error instanceof Error ? error.message : "下载视频失败",
		});
		promise.catch(() => undefined).finally(() => setIsDownloading(false));
	};

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
					<MoreVertical className="size-4" aria-hidden />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align} sideOffset={6} className="min-w-52">
				{hasEdits ? (
					<>
						<DropdownMenuItem
							className="flex gap-2 items-center"
							onClick={() => handleDownload("current")}
						>
							<Download className="size-3.5 shrink-0" aria-hidden />
							<span className="text-sm text-gray-12">下载当前视频</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							className="flex gap-2 items-center"
							onClick={() => handleDownload("original")}
						>
							<Download className="size-3.5 shrink-0" aria-hidden />
							<span className="text-sm text-gray-12">下载原始视频</span>
						</DropdownMenuItem>
					</>
				) : (
					<DropdownMenuItem
						className="flex gap-2 items-center"
						onClick={() => handleDownload("current")}
					>
						<Download className="size-3.5 shrink-0" aria-hidden />
						<span className="text-sm text-gray-12">下载视频</span>
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
