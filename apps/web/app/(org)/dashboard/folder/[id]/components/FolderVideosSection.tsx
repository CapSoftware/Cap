"use client";

import type { Folder, Video } from "@cap/web-domain";
import clsx from "clsx";
import { Effect, Exit } from "effect";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import type { MoveLocation } from "@/lib/move-items";
import { useVideosAnalyticsQuery } from "@/lib/Queries/Analytics";
import {
	EmptyFolderDoodle,
	libraryDoodleHost,
} from "../../../_components/library-doodles";
import type { VideoData } from "../../../caps/Caps";
import { CapCard } from "../../../caps/components/CapCard/CapCard";
import { DragHint } from "../../../caps/components/DragHint";
import { SelectedCapsBar } from "../../../caps/components/SelectedCapsBar";
import { UploadPlaceholderCard } from "../../../caps/components/UploadPlaceholderCard";
import { useCapsMoved } from "../../../caps/components/useCapsMoved";
import { useUploadingStatus } from "../../../caps/UploadingContext";

interface FolderVideosSectionProps {
	initialVideos: VideoData;
	analyticsEnabled: boolean;
	location: MoveLocation;
	rootLabel: string;
	currentFolderId: Folder.FolderId;
	canMove: boolean;
	allowBulkDelete?: boolean;
}

export default function FolderVideosSection({
	initialVideos,
	analyticsEnabled,
	location,
	rootLabel,
	currentFolderId,
	canMove,
	allowBulkDelete = false,
}: FolderVideosSectionProps) {
	const router = useRouter();
	const { user } = useDashboardContext();

	const [selectedCaps, setSelectedCaps] = useState<Video.VideoId[]>([]);
	const previousCountRef = useRef<number>(0);

	useCapsMoved((ids) =>
		setSelectedCaps((current) => current.filter((id) => !ids.includes(id))),
	);

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
						new Error(
							`Failed to delete ${errorCount} cap${errorCount === 1 ? "" : "s"}`,
						),
					);
				}
			}).pipe(Effect.fork);

			toast.promise(Effect.runPromise(fiber.await.pipe(Effect.flatten)), {
				loading: `Deleting ${ids.length} cap${ids.length === 1 ? "" : "s"}...`,
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

	const { mutate: deleteCap, isPending: isDeletingCap } = useEffectMutation({
		mutationFn: (id: Video.VideoId) => rpc.VideoDelete(id),
		onSuccess: () => {
			toast.success("Cap deleted successfully");
			router.refresh();
		},
		onError: () => {
			toast.error("Failed to delete cap");
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
				<h1 className="text-2xl font-medium text-gray-12">
					Videos and screenshots
				</h1>
			</div>
			<div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
				{visibleVideos.length === 0 && !isUploading ? (
					<div
						className={clsx(
							libraryDoodleHost,
							"flex flex-col col-span-full gap-3 items-center px-6 py-12 text-center rounded-2xl border border-dashed border-gray-5 bg-gray-1",
						)}
					>
						<EmptyFolderDoodle />
						<div className="flex flex-col gap-1 items-center">
							<p className="text-base font-medium text-gray-12">
								This folder is empty
							</p>
							<p className="max-w-sm text-sm text-gray-10 text-pretty">
								{canMove
									? "Drag Caps onto this folder from My Caps, use Move on any Cap, or upload one here."
									: "Caps added to this folder will show up here."}
							</p>
						</div>
					</div>
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
								onSelectToggle={
									canMove || allowBulkDelete
										? () => handleCapSelection(video.id)
										: undefined
								}
								selectedIds={selectedCaps}
								canMove={canMove}
								moveLocation={location}
								moveRootLabel={rootLabel}
								currentFolderId={currentFolderId}
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
			{canMove && (
				<DragHint caps="Drop on a folder or the path above to move" />
			)}
			<SelectedCapsBar
				selectedCaps={selectedCaps}
				setSelectedCaps={setSelectedCaps}
				deleteSelectedCaps={
					allowBulkDelete ? () => deleteCaps(selectedCaps) : undefined
				}
				isDeleting={isDeletingCaps || isDeletingCap}
				moveLocation={canMove ? location : undefined}
				moveRootLabel={canMove ? rootLabel : undefined}
				currentFolderId={currentFolderId}
			/>
		</>
	);
}
