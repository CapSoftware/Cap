"use client";

import type { VideoMetadata } from "@cap/database/types";
import { Button } from "@cap/ui";
import type { ImageUpload, Video } from "@cap/web-domain";
import { faFolderPlus, faInfoCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Effect, Exit } from "effect";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { useVideosAnalyticsQuery } from "@/lib/Queries/Analytics";
import { useDashboardContext } from "../Contexts";
import {
	NewFolderDialog,
	SelectedCapsBar,
	UploadCapButton,
	UploadPlaceholderCard,
} from "./components";
import { CapCard } from "./components/CapCard/CapCard";
import { CapPagination } from "./components/CapPagination";
import { EmptyCapState } from "./components/EmptyCapState";
import type { FolderDataType } from "./components/Folder";
import Folder from "./components/Folder";
import { useUploadingStatus } from "./UploadingContext";

export type VideoData = {
	id: Video.VideoId;
	ownerId: string;
	name: string;
	createdAt: Date;
	public: boolean;
	totalComments: number;
	totalReactions: number;
	foldersData: FolderDataType[];
	sharedOrganizations: {
		id: string;
		name: string;
		iconUrl?: ImageUpload.ImageUrl | null;
	}[];
	sharedSpaces?: {
		id: string;
		name: string;
		isOrg: boolean;
		organizationId: string;
	}[];
	ownerName: string;
	metadata?: VideoMetadata;
	hasPassword: boolean;
	hasActiveUpload: boolean;
}[];

export const Caps = ({
	data,
	count,
	dubApiKeyEnabled,
	folders,
}: {
	data: VideoData;
	count: number;
	folders: FolderDataType[];
	dubApiKeyEnabled: boolean;
}) => {
	const router = useRouter();
	const params = useSearchParams();
	const page = Number(params.get("page")) || 1;
	const { user } = useDashboardContext();
	const limit = 15;
	const [openNewFolderDialog, setOpenNewFolderDialog] = useState(false);
	const totalPages = Math.ceil(count / limit);
	const previousCountRef = useRef<number>(0);
	const [selectedCaps, setSelectedCaps] = useState<Video.VideoId[]>([]);
	const [isDraggingCap, setIsDraggingCap] = useState(false);

	const anyCapSelected = selectedCaps.length > 0;

	const analyticsQuery = useVideosAnalyticsQuery(
		data.map((video) => video.id),
		dubApiKeyEnabled,
	);
	const analytics = analyticsQuery.data || {};

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && selectedCaps.length > 0) {
				setSelectedCaps([]);
			}

			if (
				(e.key === "Delete" || e.key === "Backspace") &&
				selectedCaps.length > 0
			) {
				if (e.key === "Backspace") {
					e.preventDefault();
				}

				if (
					!["INPUT", "TEXTAREA", "SELECT"].includes(
						document.activeElement?.tagName || "",
					)
				) {
					deleteCaps(selectedCaps);
				}
			}

			if (e.key === "a" && (e.ctrlKey || e.metaKey) && data.length > 0) {
				if (
					!["INPUT", "TEXTAREA", "SELECT"].includes(
						document.activeElement?.tagName || "",
					)
				) {
					e.preventDefault();
					setSelectedCaps(data.map((cap) => cap.id));
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);

		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [selectedCaps.length, data]);

	useEffect(() => {
		const handleDragStart = () => setIsDraggingCap(true);
		const handleDragEnd = () => setIsDraggingCap(false);

		window.addEventListener("dragstart", handleDragStart);
		window.addEventListener("dragend", handleDragEnd);

		return () => {
			window.removeEventListener("dragstart", handleDragStart);
			window.removeEventListener("dragend", handleDragEnd);
		};
	}, []);

	const handleCapSelection = (capId: Video.VideoId) => {
		setSelectedCaps((prev) => {
			const newSelection = prev.includes(capId)
				? prev.filter((id) => id !== capId)
				: [...prev, capId];

			previousCountRef.current = prev.length;

			return newSelection;
		});
	};

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
		onError: () => toast.error("Failed to delete cap"),
	});

	const [isUploading, uploadingCapId] = useUploadingStatus();
	const visibleVideos = useMemo(
		() =>
			isUploading && uploadingCapId
				? data.filter((video) => video.id !== uploadingCapId)
				: data,
		[data, isUploading, uploadingCapId],
	);

	if (count === 0 && folders.length === 0) return <EmptyCapState />;

	return (
		<div className="flex relative flex-col w-full h-full">
			<NewFolderDialog
				open={openNewFolderDialog}
				onOpenChange={setOpenNewFolderDialog}
			/>
			<div className="flex gap-3 items-center mb-10 w-full">
				<Button
					onClick={() => setOpenNewFolderDialog(true)}
					size="sm"
					variant="dark"
					className="flex gap-2 items-center w-fit"
				>
					<FontAwesomeIcon className="size-3.5" icon={faFolderPlus} />
					New Folder
				</Button>
				<UploadCapButton size="sm" />
			</div>
			{folders.length > 0 && (
				<>
					<div className="flex gap-3 items-center mb-6 w-full">
						<h1 className="text-2xl font-medium text-gray-12">Folders</h1>
					</div>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4 mb-10">
						{folders.map((folder) => (
							<Folder key={folder.id} {...folder} />
						))}
					</div>
				</>
			)}
			{visibleVideos.length > 0 && (
				<>
					<div className="flex justify-between items-center mb-6 w-full">
						<h1 className="text-2xl font-medium text-gray-12">Videos</h1>
					</div>

					<div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
						{isUploading && (
							<UploadPlaceholderCard key={"upload-placeholder"} />
						)}
						{visibleVideos.map((video) => {
							return (
								<CapCard
									key={video.id}
									cap={video}
									analytics={analytics[video.id] || 0}
									onDelete={() => {
										if (selectedCaps.length > 0) {
											deleteCaps(selectedCaps);
										} else {
											deleteCap(video.id);
										}
									}}
									userId={user?.id}
									isLoadingAnalytics={analyticsQuery.isLoading}
									isSelected={selectedCaps.includes(video.id)}
									anyCapSelected={anyCapSelected}
									onSelectToggle={() => handleCapSelection(video.id)}
								/>
							);
						})}
					</div>
				</>
			)}
			{(data.length > limit || data.length === limit || page !== 1) && (
				<div className="mt-7">
					<CapPagination currentPage={page} totalPages={totalPages} />
				</div>
			)}
			<SelectedCapsBar
				selectedCaps={selectedCaps}
				setSelectedCaps={setSelectedCaps}
				deleteSelectedCaps={() => deleteCaps(selectedCaps)}
				isDeleting={isDeletingCaps || isDeletingCap}
			/>
			{isDraggingCap && (
				<div className="fixed inset-0 z-50 pointer-events-none">
					<div className="flex justify-center items-center w-full h-full">
						<div className="flex gap-2 items-center px-5 py-3 text-sm font-medium text-white rounded-xl bg-blue-12">
							<FontAwesomeIcon
								className="size-3.5 text-white opacity-50"
								icon={faInfoCircle}
							/>
							<p className="text-white">
								Drag to a space to share or folder to move
							</p>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};
