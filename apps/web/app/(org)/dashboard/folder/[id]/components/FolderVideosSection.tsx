"use client";

import type { Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";
import { Effect, Exit } from "effect";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { Rpc } from "@/lib/Rpcs";
import type { VideoData } from "../../../caps/Caps";
import { SelectedCapsBar } from "../../../caps/components/SelectedCapsBar";
import { UploadPlaceholderCard } from "../../../caps/components/UploadPlaceholderCard";
import { useUploadingContext } from "../../../caps/UploadingContext";
import { SharedCapCard } from "../../../spaces/[spaceId]/components/SharedCapCard";
import { ClientCapCard } from "./index";

interface FolderVideosSectionProps {
	initialVideos: VideoData & {
		sharedOrganizations: {
			id: string;
			name: string;
			iconUrl: string;
		}[];
	};
	dubApiKeyEnabled: boolean;
	cardType?: "shared" | "default";
	userId?: string;
}

export default function FolderVideosSection({
	initialVideos,
	dubApiKeyEnabled,
	cardType = "default",
	userId,
}: FolderVideosSectionProps) {
	const router = useRouter();
	const { isUploading } = useUploadingContext();
	const { activeOrganization } = useDashboardContext();

	const [selectedCaps, setSelectedCaps] = useState<Video.VideoId[]>([]);
	const previousCountRef = useRef<number>(0);

	const deleteCaps = useEffectMutation({
		mutationFn: Effect.fn(function* (ids: Video.VideoId[]) {
			if (ids.length === 0) return;

			const rpc = yield* Rpc;

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
						new Error(
							`Failed to delete ${errorCount} cap${errorCount === 1 ? "" : "s"}`,
						),
					);
				}
			}).pipe(Effect.fork);

			toast.promise(Effect.runPromise(fiber.await.pipe(Effect.flatten)), {
				loading: `Deleting ${selectedCaps.length} cap${
					selectedCaps.length === 1 ? "" : "s"
				}...`,
				success: (data) => {
					if (data.error) {
						return `Successfully deleted ${data.success} cap${
							data.success === 1 ? "" : "s"
						}, but failed to delete ${data.error} cap${
							data.error === 1 ? "" : "s"
						}`;
					}
					return `Successfully deleted ${data.success} cap${
						data.success === 1 ? "" : "s"
					}`;
				},
				error: (error) =>
					error.message || "An error occurred while deleting caps",
			});

			return yield* fiber.await.pipe(Effect.flatten);
		}),
		onSuccess: () => {
			setSelectedCaps([]);
			router.refresh();
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

	const { data: analyticsData, isLoading: isLoadingAnalytics } = useQuery({
		queryKey: ["analytics", initialVideos.map((video) => video.id)],
		queryFn: async () => {
			if (!dubApiKeyEnabled || initialVideos.length === 0) {
				return {};
			}

			const analyticsPromises = initialVideos.map(async (video) => {
				try {
					const response = await fetch(`/api/analytics?videoId=${video.id}`, {
						method: "GET",
						headers: {
							"Content-Type": "application/json",
						},
					});

					if (response.ok) {
						const responseData = await response.json();
						return { videoId: video.id, count: responseData.count || 0 };
					}
					return { videoId: video.id, count: 0 };
				} catch (error) {
					console.warn(
						`Failed to fetch analytics for video ${video.id}:`,
						error,
					);
					return { videoId: video.id, count: 0 };
				}
			});

			const results = await Promise.allSettled(analyticsPromises);
			const analyticsData: Record<string, number> = {};

			results.forEach((result) => {
				if (result.status === "fulfilled" && result.value) {
					analyticsData[result.value.videoId] = result.value.count;
				}
			});
			return analyticsData;
		},
		refetchOnWindowFocus: false,
		refetchOnMount: true,
	});

	const analytics = analyticsData || {};

	return (
		<>
			<div className="flex justify-between items-center mb-6 w-full">
				<h1 className="text-2xl font-medium text-gray-12">Videos</h1>
			</div>
			<div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
				{initialVideos.length === 0 && !isUploading ? (
					<p className="col-span-full text-gray-9">
						No videos in this folder yet. Drag and drop into the folder or
						upload.
					</p>
				) : (
					<>
						{isUploading && (
							<UploadPlaceholderCard key={"upload-placeholder"} />
						)}

						{cardType === "shared"
							? initialVideos.map((video) => (
									<SharedCapCard
										key={video.id}
										cap={video}
										hideSharedStatus
										analytics={analytics[video.id] || 0}
										organizationName={
											activeOrganization?.organization.name || ""
										}
										userId={userId}
									/>
								))
							: initialVideos.map((video) => (
									<ClientCapCard
										key={video.id}
										videoId={video.id}
										cap={video}
										analytics={analytics[video.id] || 0}
										isLoadingAnalytics={isLoadingAnalytics}
										isSelected={selectedCaps.includes(video.id)}
										anyCapSelected={selectedCaps.length > 0}
										isDeleting={deleteCaps.isPending}
										onSelectToggle={() => handleCapSelection(video.id)}
										onDelete={() => deleteCaps.mutateAsync(selectedCaps)}
									/>
								))}
					</>
				)}
			</div>
			<SelectedCapsBar
				selectedCaps={selectedCaps}
				setSelectedCaps={setSelectedCaps}
				deleteSelectedCaps={() => deleteCaps.mutateAsync(selectedCaps)}
				isDeleting={deleteCaps.isPending}
			/>
		</>
	);
}
