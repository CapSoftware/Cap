"use client";

import type { Video } from "@cap/web-domain";
import { Effect, Exit } from "effect";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useVideosAnalyticsQuery } from "@/lib/Queries/Analytics";
import type { VideoData } from "../../../caps/Caps";
import { CapCard } from "../../../caps/components/CapCard/CapCard";
import { SelectedCapsBar } from "../../../caps/components/SelectedCapsBar";
import { UploadPlaceholderCard } from "../../../caps/components/UploadPlaceholderCard";
import { useUploadingStatus } from "../../../caps/UploadingContext";

interface FolderVideosSectionProps {
	initialVideos: VideoData;
	analyticsEnabled: boolean;
}

export default function FolderVideosSection({
	initialVideos,
	analyticsEnabled,
}: FolderVideosSectionProps) {
	const router = useRouter();
	const { user } = useDashboardContext();

	const [selectedCaps, setSelectedCaps] = useState<Video.VideoId[]>([]);
	const previousCountRef = useRef<number>(0);

	const rpc = useRpcClient();

	const { mutate: deleteCaps, isPending: isDeletingCaps } = useEffectMutation({
		mutationFn: Effect.fn(function* (ids: Video.VideoId[]) {
			if (ids.length === 0) return;

			const fiber = yield* Effect.gen(function* () {
				const results = yield* Effect.all(
					ids.map((id) => rpc.VideoDelete(id).pipe(Effect.exit)),
					{ concurrency: 10 },
				);

				const successCount = results.filter(Exit.isSuccess).length;

				const errorCount = ids.length - successCount;

				if (successCount > 0 && errorCount > 0) {
					return { success: successCount, error: errorCount };
				} else if (successCount > 0) {
					return { success: successCount };
				} else {
					return yield* Effect.fail(
						new Error(`删除 ${errorCount} 个录制内容失败`),
					);
				}
			}).pipe(Effect.fork);

			toast.promise(Effect.runPromise(fiber.await.pipe(Effect.flatten)), {
				loading: `正在删除 ${ids.length} 个录制内容……`,
				success: (data) => {
					if (data.error) {
						return `已删除 ${data.success} 个录制内容，另有 ${data.error} 个删除失败`;
					}
					return `已删除 ${data.success} 个录制内容`;
				},
				error: (error) => error.message || "删除录制内容时发生错误",
			});

			return yield* fiber.await.pipe(Effect.flatten);
		}),
		onSuccess: () => {
			setSelectedCaps([]);
			router.refresh();
		},
	});

	const { mutate: deleteCap, isPending: isDeletingCap } = useEffectMutation({
		mutationFn: (id: Video.VideoId) => rpc.VideoDelete(id),
		onSuccess: () => {
			toast.success("录制内容已删除");
			router.refresh();
		},
		onError: () => {
			toast.error("删除录制内容失败");
		},
	});

	const handleCapSelection = (capId: Video.VideoId) => {
		setSelectedCaps((prev) => {
			const newSelection = prev.includes(capId)
				? prev.filter((id) => id !== capId)
				: [...prev, capId];

			previousCountRef.current = prev.length;

			return newSelection;
		});
	};

	const analyticsQuery = useVideosAnalyticsQuery(
		initialVideos.map((video) => video.id),
		analyticsEnabled,
	);

	const [isUploading, uploadingCapId] = useUploadingStatus();
	const visibleVideos = useMemo(
		() =>
			isUploading && uploadingCapId
				? initialVideos.filter((video) => video.id !== uploadingCapId)
				: initialVideos,
		[initialVideos, isUploading, uploadingCapId],
	);

	const analytics = analyticsQuery.data || {};

	return (
		<>
			<div className="flex justify-between items-center mb-6 w-full">
				<h1 className="text-2xl font-medium text-gray-12">视频和截图</h1>
			</div>
			<div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
				{visibleVideos.length === 0 && !isUploading ? (
					<p className="col-span-full text-gray-9">
						此文件夹中还没有视频或截图。请拖放到此文件夹或上传媒体。
					</p>
				) : (
					<>
						{isUploading && (
							<UploadPlaceholderCard key={"upload-placeholder"} />
						)}
						{visibleVideos.map((video) => (
							<CapCard
								key={video.id}
								cap={video}
								analytics={analytics[video.id] || 0}
								userId={user?.id}
								isLoadingAnalytics={analyticsQuery.isLoading}
								isSelected={selectedCaps.includes(video.id)}
								anyCapSelected={selectedCaps.length > 0}
								isDeleting={isDeletingCaps || isDeletingCap}
								onSelectToggle={() => handleCapSelection(video.id)}
								onDelete={() => {
									if (selectedCaps.length > 0) {
										deleteCaps(selectedCaps);
									} else {
										deleteCap(video.id);
									}
								}}
							/>
						))}
					</>
				)}
			</div>
			<SelectedCapsBar
				selectedCaps={selectedCaps}
				setSelectedCaps={setSelectedCaps}
				deleteSelectedCaps={() => deleteCaps(selectedCaps)}
				isDeleting={isDeletingCaps || isDeletingCap}
			/>
		</>
	);
}
