"use client";

import type { developerVideos } from "@cap/database/schema";
import { Button, Input } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperVideo } from "@/actions/developers/delete-video";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { infraAppPath } from "@/lib/infra-routes";
import { formatDuration } from "@/lib/infra-usage";
import { CodeBlock } from "../../_components/code-block";
import { CopyButton } from "../../_components/copy-button";
import { createVideoCurl } from "../../_components/infra-examples";
import { Panel, Section } from "../../_components/section";

type Video = typeof developerVideos.$inferSelect;

const PAGE_LIMIT = 50;

const dateFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

export function VideosClient({
	appId,
	videos,
	userId,
	publicKey,
	isProduction,
}: {
	appId: string;
	videos: Video[];
	userId: string;
	publicKey: string;
	isProduction: boolean;
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

	if (videos.length === 0 && !userId) {
		return (
			<VideosEmptyState publicKey={publicKey} isProduction={isProduction} />
		);
	}

	return (
		<Section
			title="Videos"
			description={
				videos.length >= PAGE_LIMIT
					? `Showing the ${PAGE_LIMIT} most recent.`
					: "Newest first."
			}
			action={
				<form
					className="flex gap-2 items-center w-full sm:w-auto"
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
						className="h-9 sm:w-56"
					/>
					<Button type="submit" variant="gray" size="sm">
						Filter
					</Button>
					{userId && (
						<Button
							type="button"
							variant="transparent"
							size="sm"
							className="px-2"
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
		>
			<Panel>
				{videos.length === 0 ? (
					<p className="px-5 py-10 text-sm text-center text-gray-10">
						No videos for user id {userId}.
					</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-gray-3">
									<th className="py-2.5 pr-4 pl-5 font-normal text-left text-gray-10">
										Name
									</th>
									<th className="px-4 py-2.5 font-normal text-right text-gray-10">
										Duration
									</th>
									<th className="px-4 py-2.5 font-normal text-right text-gray-10">
										Resolution
									</th>
									<th className="px-4 py-2.5 font-normal text-left text-gray-10">
										Created
									</th>
									<th className="px-4 py-2.5 font-normal text-left text-gray-10">
										User id
									</th>
									<th className="px-4 py-2.5 font-normal text-left text-gray-10">
										Video id
									</th>
									<th className="py-2.5 pr-3 pl-2">
										<span className="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{videos.map((video) => (
									<tr
										key={video.id}
										className="border-b border-gray-3 last:border-0"
									>
										<td className="py-2.5 pr-4 pl-5 max-w-[16rem] truncate text-gray-12">
											{video.name}
										</td>
										<td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums text-gray-11">
											{formatDuration(video.duration) ?? (
												<span className="text-gray-9">Pending</span>
											)}
										</td>
										<td className="px-4 py-2.5 text-right whitespace-nowrap tabular-nums text-gray-11">
											{video.width && video.height ? (
												`${video.width}×${video.height}`
											) : (
												<span className="text-gray-9">None</span>
											)}
										</td>
										<td className="px-4 py-2.5 whitespace-nowrap text-gray-11">
											{dateFormat.format(new Date(video.createdAt))}
										</td>
										<td className="px-4 py-2.5 max-w-[12rem] truncate font-mono text-xs text-gray-11">
											{video.externalUserId ? (
												<button
													type="button"
													onClick={() => {
														setUserIdFilter(video.externalUserId ?? "");
														applyFilter(video.externalUserId ?? "");
													}}
													className="truncate hover:text-gray-12 hover:underline"
													title={`Show videos for ${video.externalUserId}`}
												>
													{video.externalUserId}
												</button>
											) : (
												<span className="font-sans text-gray-9">None</span>
											)}
										</td>
										<td className="px-4 py-1.5 whitespace-nowrap">
											<span className="inline-flex gap-1 items-center font-mono text-xs text-gray-11">
												{video.id}
												<CopyButton value={video.id} label="Copy video id" />
											</span>
										</td>
										<td className="py-1.5 pr-3 pl-2 text-right">
											<button
												type="button"
												onClick={() => setPendingDelete(video)}
												aria-label={`Delete ${video.name}`}
												className="inline-flex justify-center items-center rounded-md transition-colors size-7 text-gray-10 hover:bg-gray-4 hover:text-red-11"
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
			</Panel>
			<ConfirmationDialog
				open={pendingDelete !== null}
				title="Delete video"
				description={
					pendingDelete
						? `Delete "${pendingDelete.name}"? It stops counting toward storage and disappears from the API.`
						: undefined
				}
				confirmLabel="Delete"
				confirmVariant="destructive"
				loading={deleteMutation.isPending}
				onConfirm={() => {
					if (pendingDelete) deleteMutation.mutate(pendingDelete);
				}}
				onCancel={() => {
					if (!deleteMutation.isPending) setPendingDelete(null);
				}}
			/>
		</Section>
	);
}

function VideosEmptyState({
	publicKey,
	isProduction,
}: {
	publicKey: string;
	isProduction: boolean;
}) {
	return (
		<Section
			title="No videos yet"
			description="Create your first video through the API. It shows up here as soon as it exists."
		>
			<Panel className="p-5">
				<ol className="flex flex-col gap-6">
					<li className="flex flex-col gap-2">
						<p className="text-sm text-gray-12">
							1. Create a video with your public key
						</p>
						<CodeBlock
							code={createVideoCurl(publicKey)}
							label="create request"
						/>
						<p className="text-xs leading-5 text-gray-10">
							{isProduction
								? "Production apps only accept this from a browser on an allowed domain. "
								: "Development apps accept this from anywhere, including your terminal. "}
							The app needs credits to create a video.
						</p>
					</li>
					<li className="flex flex-col gap-2">
						<p className="text-sm text-gray-12">2. Upload the file in parts</p>
						<p className="text-sm leading-6 text-gray-10">
							Call{" "}
							<code className="font-mono text-xs text-gray-11">
								POST /api/developer/sdk/v1/upload/multipart/initiate
							</code>{" "}
							with the video id, then{" "}
							<code className="font-mono text-xs text-gray-11">
								presign-part
							</code>{" "}
							for each part and{" "}
							<code className="font-mono text-xs text-gray-11">complete</code>{" "}
							with the duration.
						</p>
					</li>
					<li className="flex flex-col gap-2">
						<p className="text-sm text-gray-12">3. Read it from your server</p>
						<p className="text-sm leading-6 text-gray-10">
							<code className="font-mono text-xs text-gray-11">
								GET /api/developer/v1/videos/:id/status
							</code>{" "}
							with your secret key returns{" "}
							<code className="font-mono text-xs text-gray-11">
								ready: true
							</code>{" "}
							once the upload is complete.
						</p>
					</li>
				</ol>
				<p className="pt-5 mt-6 text-sm border-t border-gray-3 text-gray-10">
					Full reference in the{" "}
					<Link
						href="/docs/api/rest-api"
						className="underline underline-offset-2 text-gray-11 hover:text-gray-12"
					>
						API docs
					</Link>
					.
				</p>
			</Panel>
		</Section>
	);
}
