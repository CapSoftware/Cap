"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteDeveloperVideo } from "@/actions/developers/delete-video";
import { infraAppPath } from "@/lib/infra-routes";
import { formatDuration } from "@/lib/infra-usage";
import {
	INFRA_VIDEO_PAGE_MAX,
	type InfraVideoListItem,
	infraVideoDisplayState,
} from "@/lib/infra-video-view";
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
import { useLocalUpload } from "../../_components/uploads";
import { useWatchVideos } from "../../_components/video-live";
import { VideoStatus } from "../../_components/video-status";

type Video = InfraVideoListItem;

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
	nextLimit,
	hasMore,
}: {
	appId: string;
	videos: Video[];
	userId: string;
	nextLimit: number | null;
	hasMore: boolean;
}) {
	const router = useRouter();
	const filterId = useId();
	useWatchVideos(videos);
	const localUpload = useLocalUpload();
	const [userIdFilter, setUserIdFilter] = useState(userId);
	const [pendingDelete, setPendingDelete] = useState<Video | null>(null);
	const [loadingMore, startLoadingMore] = useTransition();
	const hasUserIds = videos.some((video) => video.externalUserId);
	const displayState = (video: Video) =>
		infraVideoDisplayState(video.state, localUpload(video.id));

	const deleteMutation = useMutation({
		mutationFn: (video: Video) => deleteDeveloperVideo(appId, video.id),
		onSuccess: () => {
			setPendingDelete(null);
			toast.success("Video deleted");
			router.refresh();
		},
		onError: () => toast.error("Could not delete the video"),
	});

	const listPath = (filter: string, show?: number) => {
		const query = new URLSearchParams();
		if (filter) query.set("userId", filter);
		if (show) query.set("show", String(show));
		const base = infraAppPath(appId, "videos");
		return query.size > 0 ? `${base}?${query}` : base;
	};

	const applyFilter = (value: string) => router.push(listPath(value.trim()));

	const showMore = () => {
		if (nextLimit === null) return;
		startLoadingMore(() =>
			router.replace(listPath(userId, nextLimit), { scroll: false }),
		);
	};

	const pendingDeleteUnfinished =
		pendingDelete !== null && displayState(pendingDelete) === "unfinished";

	return (
		<>
			<PageHeader
				title="Videos"
				description={
					hasMore
						? `The ${videos.length.toLocaleString("en-US")} most recent, newest first. Open one to watch it and copy its links.`
						: "Every video in this app, newest first. Open one to watch it and copy its links."
				}
				action={
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
				}
			/>

			<UploadDrop />

			{videos.length === 0 ? (
				<div className="border-t border-[rgba(222,230,246,0.08)]">
					<Empty>
						<span className="[overflow-wrap:anywhere]">
							No videos for user id {userId}.
						</span>
					</Empty>
				</div>
			) : (
				<div className="relative -mx-1 overflow-x-auto px-1">
					<table className="w-full border-collapse border-t border-[rgba(222,230,246,0.08)]">
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
								const state = displayState(video);
								const unfinished = state === "unfinished";
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
													unfinished ? "pb-0.5" : "pb-3",
													FOCUS,
												)}
											>
												{video.name}
											</Link>
											{unfinished && (
												<p className="m-0 whitespace-normal text-pretty pb-3 text-[12.5px] leading-[1.4] text-[rgba(232,236,244,0.46)]">
													The file did not arrive. Remove this and upload it
													again.
												</p>
											)}
										</td>
										<td className={TD}>
											<VideoStatus state={state} />
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
													disabled={state === "uploading"}
													aria-label={`${unfinished ? "Remove" : "Delete"} ${video.name}`}
													title={unfinished ? "Remove" : "Delete"}
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

			{hasMore && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					{nextLimit !== null ? (
						<Button
							variant="ghost"
							size="sm"
							loading={loadingMore}
							onClick={showMore}
						>
							Show more
						</Button>
					) : (
						<p className="m-0 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
							These are the {INFRA_VIDEO_PAGE_MAX.toLocaleString("en-US")} most
							recent. Filter by user id to reach older videos, or list them
							through the API.
						</p>
					)}
				</div>
			)}

			<ConfirmDialog
				open={pendingDelete !== null}
				title={pendingDeleteUnfinished ? "Remove upload" : "Delete video"}
				description={
					pendingDelete
						? pendingDeleteUnfinished
							? `Remove "${pendingDelete.name}"? Its file has not arrived. An upload still running somewhere else will fail.`
							: `Delete "${pendingDelete.name}"? Its links stop playing within about a minute, its files are removed and it stops counting toward storage.`
						: undefined
				}
				confirmLabel={pendingDeleteUnfinished ? "Remove" : "Delete"}
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
