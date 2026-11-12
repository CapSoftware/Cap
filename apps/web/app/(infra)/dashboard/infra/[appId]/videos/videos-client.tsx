"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperVideo } from "@/actions/developers/delete-video";
import { infraAppPath } from "@/lib/infra-routes";
import { formatDuration } from "@/lib/infra-usage";
import type { InfraVideoListItem } from "@/lib/infra-video-view";
import { CopyButton } from "../../_components/copy";
import { ConfirmDialog } from "../../_components/dialog";
import {
	Button,
	Empty,
	FOCUS,
	Input,
	MONO,
	PageHeader,
	TD,
	TH,
	TR,
} from "../../_components/ui";
import { UploadDrop } from "../../_components/upload-drop";
import { useWatchVideos } from "../../_components/video-live";
import { VideoStatus } from "../../_components/video-status";

type Video = InfraVideoListItem;

const PAGE_LIMIT = 50;

const dateFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

const NONE = <span className="text-[rgba(232,236,244,0.3)]">none</span>;

export function VideosClient({
	appId,
	videos,
	userId,
}: {
	appId: string;
	videos: Video[];
	userId: string;
}) {
	const router = useRouter();
	const filterId = useId();
	const uploadingId = useWatchVideos(videos);
	const [userIdFilter, setUserIdFilter] = useState(userId);
	const [pendingDelete, setPendingDelete] = useState<Video | null>(null);
	const hasUserIds = videos.some((video) => video.externalUserId);
	const showFilter = userId !== "" || hasUserIds || videos.length >= PAGE_LIMIT;

	const deleteMutation = useMutation({
		mutationFn: (video: Video) => deleteDeveloperVideo(appId, video.id),
		onSuccess: () => {
			setPendingDelete(null);
			toast.success("Video deleted");
			router.refresh();
		},
		onError: () => toast.error("Could not delete the video"),
	});

	const applyFilter = (value: string) => {
		const trimmed = value.trim();
		const base = infraAppPath(appId, "videos");
		router.push(
			trimmed ? `${base}?userId=${encodeURIComponent(trimmed)}` : base,
		);
	};

	return (
		<>
			<PageHeader
				title="Videos"
				description={
					videos.length >= PAGE_LIMIT
						? `The ${PAGE_LIMIT} most recent, newest first. Open one to watch it and copy its links.`
						: "Every video in this app, newest first. Open one to watch it and copy its links."
				}
				action={
					showFilter && (
						<form
							className="flex w-full items-center gap-2 sm:w-auto"
							onSubmit={(e) => {
								e.preventDefault();
								applyFilter(userIdFilter);
							}}
						>
							<label htmlFor={filterId} className="sr-only">
								Filter by external user id
							</label>
							<Input
								id={filterId}
								value={userIdFilter}
								onChange={(e) => setUserIdFilter(e.target.value)}
								placeholder="Filter by user id"
								className="sm:w-56"
							/>
							<Button type="submit" variant="ghost">
								Filter
							</Button>
							{userId && (
								<Button
									variant="quiet"
									onClick={() => {
										setUserIdFilter("");
										applyFilter("");
									}}
								>
									Clear
								</Button>
							)}
						</form>
					)
				}
			/>

			<UploadDrop />

			{videos.length === 0 ? (
				<div className="border-t border-[rgba(222,230,246,0.08)]">
					<Empty>No videos for user id {userId}.</Empty>
				</div>
			) : (
				<div className="relative overflow-x-auto border-t border-[rgba(222,230,246,0.08)]">
					<table className="w-full border-collapse">
						<thead>
							<tr className={TR}>
								<th className={TH}>Name</th>
								<th className={TH}>Status</th>
								<th className={clsx(TH, "hidden text-right sm:table-cell")}>
									Duration
								</th>
								<th className={clsx(TH, "hidden md:table-cell")}>Created</th>
								{hasUserIds && (
									<th className={clsx(TH, "hidden md:table-cell")}>User id</th>
								)}
								<th className={TH}>
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{videos.map((video) => {
								const uploadingHere = video.id === uploadingId;
								const stalled = video.state === "uploading" && !uploadingHere;
								return (
									<tr
										key={video.id}
										className={clsx(
											TR,
											"transition-colors duration-150 hover:bg-[rgba(222,230,246,0.025)]",
										)}
									>
										<td className="w-full max-w-0 whitespace-nowrap pr-6 text-[13.5px]">
											<Link
												href={`${infraAppPath(appId, "videos")}/${encodeURIComponent(video.id)}`}
												className={clsx(
													"block truncate rounded-[4px] pt-3 text-[#E8ECF4] underline-offset-[4px] hover:underline",
													stalled ? "pb-0.5" : "pb-3",
													FOCUS,
												)}
											>
												{video.name}
											</Link>
											{stalled && (
												<p className="m-0 truncate pb-3 text-[12.5px] leading-[1.4] text-[rgba(232,236,244,0.46)]">
													The file did not arrive. Remove this and upload it
													again.
												</p>
											)}
										</td>
										<td className={TD}>
											<VideoStatus
												state={video.state}
												uploadingHere={uploadingHere}
											/>
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"hidden text-right text-[13px] tabular-nums sm:table-cell",
											)}
										>
											{formatDuration(video.duration) ?? NONE}
										</td>
										<td className={clsx(TD, "hidden md:table-cell")}>
											{dateFormat.format(new Date(video.createdAt))}
										</td>
										{hasUserIds && (
											<td
												className={clsx(
													TD,
													MONO,
													"hidden max-w-[11rem] truncate text-[13px] md:table-cell",
												)}
											>
												{video.externalUserId ? (
													<button
														type="button"
														onClick={() => {
															setUserIdFilter(video.externalUserId ?? "");
															applyFilter(video.externalUserId ?? "");
														}}
														className={clsx(
															"truncate rounded-[4px] transition-colors duration-200 hover:text-white hover:underline",
															FOCUS,
														)}
														title={`Show videos for ${video.externalUserId}`}
													>
														{video.externalUserId}
													</button>
												) : (
													NONE
												)}
											</td>
										)}
										<td className={clsx(TD, "py-1.5 text-right")}>
											<span className="inline-flex items-center gap-0.5">
												<CopyButton value={video.id} label="Copy video id" />
												<button
													type="button"
													onClick={() => setPendingDelete(video)}
													disabled={uploadingHere}
													aria-label={`Delete ${video.name}`}
													title="Delete"
													className={clsx(
														"inline-flex size-7 items-center justify-center rounded-[6px] text-[rgba(232,236,244,0.4)] transition-colors duration-200 hover:bg-[rgba(242,161,153,0.1)] hover:text-[#F2A199] disabled:pointer-events-none disabled:opacity-40",
														FOCUS,
													)}
												>
													<Trash2 size={14} />
												</button>
											</span>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			<ConfirmDialog
				open={pendingDelete !== null}
				title="Delete video"
				description={
					pendingDelete
						? pendingDelete.state === "uploading"
							? `Remove "${pendingDelete.name}"? Its file has not arrived. An upload still running somewhere else will fail.`
							: `Delete "${pendingDelete.name}"? It stops playing everywhere it is embedded, stops counting toward storage and disappears from the API.`
						: undefined
				}
				confirmLabel={
					pendingDelete?.state === "uploading" ? "Remove" : "Delete"
				}
				loading={deleteMutation.isPending}
				onConfirm={() => {
					if (pendingDelete) deleteMutation.mutate(pendingDelete);
				}}
				onCancel={() => {
					if (!deleteMutation.isPending) setPendingDelete(null);
				}}
			/>
		</>
	);
}
