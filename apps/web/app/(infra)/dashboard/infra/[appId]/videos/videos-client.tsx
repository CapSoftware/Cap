"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperVideo } from "@/actions/developers/delete-video";
import { infraAppPath } from "@/lib/infra-routes";
import { formatDuration } from "@/lib/infra-usage";
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
import type { InfraVideoRow } from "../../infra-data";

type Video = InfraVideoRow;

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
	publicKey,
}: {
	appId: string;
	videos: Video[];
	userId: string;
	publicKey: string | null;
}) {
	const router = useRouter();
	const filterId = useId();
	const [userIdFilter, setUserIdFilter] = useState(userId);
	const [pendingDelete, setPendingDelete] = useState<Video | null>(null);

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
						? `The ${PAGE_LIMIT} most recent, newest first.`
						: "Every video in this app, newest first."
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

			{publicKey && <UploadDrop appId={appId} publicKey={publicKey} />}

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
								<th className={clsx(TH, "text-right")}>Duration</th>
								<th className={clsx(TH, "text-right")}>Resolution</th>
								<th className={TH}>Created</th>
								<th className={TH}>User id</th>
								<th className={TH}>Video id</th>
								<th className={TH}>
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{videos.map((video) => (
								<tr
									key={video.id}
									className={clsx(
										TR,
										"transition-colors duration-150 hover:bg-[rgba(222,230,246,0.025)]",
									)}
								>
									<td
										className={clsx(
											TD,
											"max-w-[17rem] truncate text-[#E8ECF4]",
										)}
									>
										{video.name}
									</td>
									<td
										className={clsx(
											TD,
											MONO,
											"text-right text-[13px] tabular-nums",
										)}
									>
										{formatDuration(video.duration) ?? "pending"}
									</td>
									<td
										className={clsx(
											TD,
											MONO,
											"text-right text-[13px] tabular-nums",
										)}
									>
										{video.width && video.height
											? `${video.width}×${video.height}`
											: NONE}
									</td>
									<td className={TD}>
										{dateFormat.format(new Date(video.createdAt))}
									</td>
									<td
										className={clsx(
											TD,
											MONO,
											"max-w-[11rem] truncate text-[13px]",
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
									<td className={clsx(TD, "py-1.5")}>
										<span
											className={clsx(
												MONO,
												"inline-flex items-center gap-1 text-[13px]",
											)}
										>
											{video.id}
											<CopyButton value={video.id} label="Copy video id" />
										</span>
									</td>
									<td className={clsx(TD, "py-1.5 text-right")}>
										<button
											type="button"
											onClick={() => setPendingDelete(video)}
											aria-label={`Delete ${video.name}`}
											className={clsx(
												"inline-flex size-7 items-center justify-center rounded-[6px] text-[rgba(232,236,244,0.4)] transition-colors duration-200 hover:bg-[rgba(242,161,153,0.1)] hover:text-[#F2A199]",
												FOCUS,
											)}
										>
											<Trash2 size={14} />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<ConfirmDialog
				open={pendingDelete !== null}
				title="Delete video"
				description={
					pendingDelete
						? `Delete "${pendingDelete.name}"? It stops counting toward storage and disappears from the API.`
						: undefined
				}
				confirmLabel="Delete"
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
