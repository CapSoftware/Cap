"use client";

import type { developerVideos } from "@cap/database/schema";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
} from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { Search, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperVideo } from "@/actions/developers/delete-video";

type Video = typeof developerVideos.$inferSelect;

export function VideosClient({
	appId,
	videos,
}: {
	appId: string;
	videos: Video[];
}) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [userIdFilter, setUserIdFilter] = useState(
		searchParams.get("userId") ?? "",
	);

	const handleFilter = () => {
		const params = new URLSearchParams();
		if (userIdFilter.trim()) params.set("userId", userIdFilter.trim());
		router.push(
			`/dashboard/developers/apps/${appId}/videos?${params.toString()}`,
		);
	};

	return (
		<div className="flex flex-col gap-5">
			<Card>
				<CardHeader>
					<CardTitle>Videos</CardTitle>
					<CardDescription>
						Videos recorded through the SDK for this app.
					</CardDescription>
				</CardHeader>

				<div className="flex gap-2 items-end mt-4">
					<div className="flex-1">
						<Input
							value={userIdFilter}
							onChange={(e) => setUserIdFilter(e.target.value)}
							placeholder="Filter by user ID..."
						/>
					</div>
					<Button variant="gray" size="sm" onClick={handleFilter}>
						<Search size={14} className="mr-1" />
						Filter
					</Button>
				</div>

				{videos.length === 0 ? (
					<p className="py-8 text-sm text-center text-gray-10 mt-4">
						No videos found
					</p>
				) : (
					<div className="overflow-x-auto rounded-lg border border-gray-3 mt-4">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-gray-3 bg-gray-3/50">
									<th className="px-4 py-2.5 text-left text-xs font-medium text-gray-10">
										Name
									</th>
									<th className="px-4 py-2.5 text-left text-xs font-medium text-gray-10">
										User ID
									</th>
									<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
										Duration
									</th>
									<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10">
										Created
									</th>
									<th className="px-4 py-2.5 text-right text-xs font-medium text-gray-10" />
								</tr>
							</thead>
							<tbody>
								{videos.map((video) => (
									<VideoRow key={video.id} video={video} appId={appId} />
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>
		</div>
	);
}

function VideoRow({ video, appId }: { video: Video; appId: string }) {
	const router = useRouter();
	const deleteMutation = useMutation({
		mutationFn: () => deleteDeveloperVideo(appId, video.id),
		onSuccess: () => {
			toast.success("Video deleted");
			router.refresh();
		},
		onError: () => toast.error("Failed to delete video"),
	});

	return (
		<tr className="border-b border-gray-3 last:border-0">
			<td className="px-4 py-2.5 text-gray-12">{video.name}</td>
			<td className="px-4 py-2.5 text-gray-10 font-mono text-xs">
				{video.externalUserId ?? "\u2014"}
			</td>
			<td className="px-4 py-2.5 text-right text-gray-11">
				{video.duration ? `${(video.duration / 60).toFixed(1)}m` : "\u2014"}
			</td>
			<td className="px-4 py-2.5 text-right text-gray-10">
				{new Date(video.createdAt).toLocaleDateString()}
			</td>
			<td className="px-4 py-2.5 text-right">
				<button
					type="button"
					onClick={() => deleteMutation.mutate()}
					disabled={deleteMutation.isPending}
					className="p-1.5 rounded-md hover:bg-gray-3 text-gray-10 hover:text-red-400 transition-colors"
				>
					<Trash2 size={14} />
				</button>
			</td>
		</tr>
	);
}
