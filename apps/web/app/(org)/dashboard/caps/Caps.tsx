"use client";

import type { VideoMetadata } from "@cap/database/types";
import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { faFolderPlus, faInfoCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useQuery } from "@tanstack/react-query";
import { Effect, Exit } from "effect";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { Rpc, withRpc } from "@/lib/Rpcs";
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
import { useUploadingContext, useUploadingStatus } from "./UploadingContext";

export type VideoData = {
	id: Video.VideoId;
	ownerId: string;
	name: string;
	createdAt: Date;
	public: boolean;
	totalComments: number;
	totalReactions: number;
	foldersData: FolderDataType[];
	sharedOrganizations: { id: string; name: string; iconUrl?: string }[];
	sharedSpaces?: {
		id: string;
		name: string;
		iconUrl: string;
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
	customDomain,
	domainVerified,
	dubApiKeyEnabled,
	folders,
}: {
	data: VideoData;
	count: number;
	customDomain: string | null;
	domainVerified: boolean;
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

	const videoIds = data.map((video) => video.id).sort();

	const { data: analyticsData, isLoading: isLoadingAnalytics } = useQuery({
		queryKey: ["analytics", videoIds],
		queryFn: async () => {
			if (!dubApiKeyEnabled || data.length === 0) {
				return {};
			}

			const analyticsPromises = data.map(async (video) => {
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

	const { mutate: deleteCaps, isPending: isDeletingCaps } = useEffectMutation({
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
		mutationFn: (id: Video.VideoId) => withRpc((r) => r.VideoDelete(id)),
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

	if (count === 0) return <EmptyCapState />;

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
									customDomain={customDomain}
									isLoadingAnalytics={isLoadingAnalytics}
									domainVerified={domainVerified}
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
