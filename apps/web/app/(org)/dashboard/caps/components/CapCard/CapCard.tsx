"use client";

import type { videos as videosSchema } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { buildEnv, NODE_ENV } from "@cap/env";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import { calculateStrokeDashoffset, getProgressCircleConfig } from "@cap/utils";
import type { SpaceRuleSource, ViewerSettingKey } from "@cap/web-backend";
import type { Folder, ImageUpload, Video } from "@cap/web-domain";
import { HttpClient } from "@effect/platform";
import {
	faChartSimple,
	faCheck,
	faCopy,
	faDownload,
	faEllipsis,
	faGear,
	faImage,
	faLink,
	faLock,
	faScissors,
	faShare,
	faTrash,
	faUnlock,
	faVideo,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Effect, Option } from "effect";
import { FolderInput } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type PropsWithChildren, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useUploadProgress } from "@/app/s/[videoId]/_components/ProgressCircle";
import { UpgradeModal } from "@/components/UpgradeModal";
import {
	type ImageLoadingStatus,
	VideoThumbnail,
} from "@/components/VideoThumbnail";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import type { MoveLocation } from "@/lib/move-items";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";
import {
	copyRichVideoLink,
	videoPreviewImageUrl,
} from "@/lib/video-share-clipboard";
import { usePublicEnv } from "@/utils/public-env";
import { MoveItemsDialog } from "../MoveItemsDialog";
import { PasswordDialog } from "../PasswordDialog";
import { SettingsDialog } from "../SettingsDialog";
import { SharingDialog } from "../SharingDialog";
import { CapCardAnalytics } from "./CapCardAnalytics";
import { CapCardButton } from "./CapCardButton";
import { CapCardContent } from "./CapCardContent";

const { circumference } = getProgressCircleConfig();

function getProgressStatusText(
	status: "uploading" | "processing" | "generating_thumbnail",
) {
	switch (status) {
		case "processing":
			return "Processing";
		case "generating_thumbnail":
			return "Finishing up";
		default:
			return "Uploading";
	}
}

export interface CapCardProps extends PropsWithChildren {
	cap: {
		id: Video.VideoId;
		ownerId: string;
		name: string;
		createdAt: Date;
		public?: boolean;
		totalComments: number;
		totalReactions: number;
		sharedOrganizations?: {
			id: string;
			name: string;
			iconUrl?: ImageUpload.ImageUrl | null;
		}[];
		sharedSpaces?: {
			id: string;
			name: string;
			iconUrl?: ImageUpload.ImageUrl | null;
			organizationId: string;
			isOrg?: boolean;
			settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
			hasPassword?: boolean;
		}[];
		ownerName: string | null;
		metadata?: VideoMetadata;
		source?: typeof videosSchema.$inferSelect.source;
		isScreenshot?: boolean;
		hasPassword?: boolean;
		hasInheritedPassword?: boolean;
		inheritedPasswordSources?: SpaceRuleSource[];
		inheritedSpaceSettings?: Partial<
			Record<ViewerSettingKey, SpaceRuleSource[]>
		>;
		hasActiveUpload: boolean | undefined;
		duration?: number;
		settings?: {
			disableComments?: boolean;
			disableSummary?: boolean;
			disableCaptions?: boolean;
			disableChapters?: boolean;
			disableReactions?: boolean;
			disableTranscript?: boolean;
		} | null;
	};
	analytics: number;
	isLoadingAnalytics: boolean;
	onDelete?: () => void;
	userId?: string;
	sharedCapCard?: boolean;
	isSelected?: boolean;
	onSelectToggle?: () => void;
	hideSharedStatus?: boolean;
	anyCapSelected?: boolean;
	isDeleting?: boolean;
	onDragStart?: () => void;
	onDragEnd?: () => void;
	canMove?: boolean;
	moveLocation?: MoveLocation;
	moveRootLabel?: string;
	currentFolderId?: Folder.FolderId | null;
}

export const CapCard = ({
	cap,
	analytics,
	children,
	onDelete,
	userId,
	isLoadingAnalytics,
	sharedCapCard = false,
	hideSharedStatus = false,
	isSelected = false,
	onSelectToggle,
	anyCapSelected = false,
	isDeleting = false,
	canMove = false,
	moveLocation,
	moveRootLabel,
	currentFolderId = null,
}: CapCardProps) => {
	const { activeOrganization } = useDashboardContext();
	const customDomain = activeOrganization?.organization.customDomain;
	const domainVerified = activeOrganization?.organization.domainVerified;

	const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
	const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
	const [isDropdownOpen, setIsDropdownOpen] = useState(false);
	const [passwordProtected, setPasswordProtected] = useState(
		cap.hasPassword || false,
	);
	const effectivePasswordProtected =
		passwordProtected || Boolean(cap.hasInheritedPassword);
	const { webUrl } = usePublicEnv();

	const [copyPressed, setCopyPressed] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
	const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
	const { user, setUpgradeModalOpen } = useDashboardContext();
	const [editUpgradeModalOpen, setEditUpgradeModalOpen] = useState(false);

	const [confirmOpen, setConfirmOpen] = useState(false);

	const router = useRouter();
	const rpc = useRpcClient();

	const downloadMutation = useEffectMutation({
		mutationFn: () =>
			Effect.gen(function* () {
				const result = yield* rpc.VideoGetDownloadInfo(cap.id);
				const httpClient = yield* HttpClient.HttpClient;
				if (Option.isSome(result)) {
					const fetchResponse = yield* httpClient.get(result.value.downloadUrl);
					const blob = yield* fetchResponse.arrayBuffer;

					const blobUrl = window.URL.createObjectURL(new Blob([blob]));
					const link = document.createElement("a");
					link.href = blobUrl;
					link.download = result.value.fileName;
					link.style.display = "none";
					document.body.appendChild(link);
					link.click();
					document.body.removeChild(link);

					window.URL.revokeObjectURL(blobUrl);
				} else {
					throw new Error("Failed to get download URL");
				}
			}),
	});

	const deleteMutation = useMutation({
		mutationFn: async () => {
			await onDelete?.();
		},
		onError: (error) => {
			console.error("Error deleting cap:", error);
		},
		onSuccess: () => {
			router.refresh();
		},
		onSettled: () => {
			setConfirmOpen(false);
		},
	});

	const duplicateMutation = useEffectMutation({
		mutationFn: () => rpc.VideoDuplicate(cap.id),
		onSuccess: () => {
			router.refresh();
		},
	});

	const handleSharingUpdated = () => {
		router.refresh();
	};

	const handlePasswordUpdated = (protectedStatus: boolean) => {
		setPasswordProtected(protectedStatus);
		router.refresh();
	};

	const isOwner = userId === cap.ownerId;
	const moveEnabled = Boolean(canMove && moveLocation && moveRootLabel);

	const queryClient = useQueryClient();
	const uploadProgress = useUploadProgress(
		cap.id,
		cap.hasActiveUpload || false,
	);
	const hasRawFallback =
		uploadProgress?.status === "error" && uploadProgress.hasRawFallback;
	const hasVisibleUploadProgress =
		uploadProgress !== null &&
		uploadProgress.status !== "fetching" &&
		!hasRawFallback;
	const [imageStatus, setImageStatus] = useState<ImageLoadingStatus>("loading");
	const prevUploadProgressRef = useRef(uploadProgress);

	useEffect(() => {
		const prev = prevUploadProgressRef.current;
		const wasActive =
			prev !== null &&
			prev.status !== "fetching" &&
			prev.status !== "failed" &&
			prev.status !== "error";
		const isNowComplete = uploadProgress === null;

		if (wasActive && isNowComplete) {
			queryClient.invalidateQueries({
				queryKey: ThumbnailRequest.queryKey(cap.id),
			});
			setImageStatus("loading");
		}

		prevUploadProgressRef.current = uploadProgress;
	}, [uploadProgress, queryClient, cap.id]);

	// Helper function to create a drag preview element
	const createDragPreview = (text: string): HTMLElement => {
		// Create the element
		const element = document.createElement("div");

		// Add text content
		element.textContent = text;

		// Apply Tailwind-like styles directly
		element.className =
			"px-2 py-1.5 text-sm font-medium rounded-lg shadow-md text-gray-1 bg-gray-12";

		// Position off-screen
		element.style.position = "absolute";
		element.style.top = "-9999px";
		element.style.left = "-9999px";

		return element;
	};

	const handleDragStart = (e: React.DragEvent<HTMLElement>) => {
		if (anyCapSelected || !moveEnabled) return;

		// Set the data transfer
		e.dataTransfer.setData(
			"application/cap",
			JSON.stringify({
				id: cap.id,
				name: cap.name,
			}),
		);

		// Set drag effect to 'move' to avoid showing the + icon
		e.dataTransfer.effectAllowed = "move";

		// Set the drag image using the helper function
		try {
			const dragPreview = createDragPreview(cap.name);
			document.body.appendChild(dragPreview);
			e.dataTransfer.setDragImage(dragPreview, 10, 10);

			// Clean up after a short delay
			setTimeout(() => document.body.removeChild(dragPreview), 100);
		} catch (error) {
			console.error("Error setting drag image:", error);
		}

		setIsDragging(true);
	};

	const handleDragEnd = () => {
		setIsDragging(false);
	};

	const handleCopy = (text: string) => {
		copyRichVideoLink({
			url: text,
			title: cap.name || "Cap Recording",
			previewImageUrl: videoPreviewImageUrl(webUrl, cap.id),
		});
		setCopyPressed(true);
		setTimeout(() => {
			setCopyPressed(false);
		}, 2000);
	};

	const handleDownload = async () => {
		if (downloadMutation.isPending) return;

		toast.promise(downloadMutation.mutateAsync(), {
			loading: "Preparing download...",
			success: "Download started successfully",
			error: (error) => {
				if (error instanceof Error) {
					return error.message;
				}
				return "Failed to download video - please try again.";
			},
		});
	};

	const handleSelectClick = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (onSelectToggle) {
			onSelectToggle();
		}
	};

	const copyLinkHandler = () => {
		handleCopy(
			NODE_ENV === "development"
				? `${webUrl}/s/${cap.id}`
				: buildEnv.NEXT_PUBLIC_IS_CAP && customDomain && domainVerified
					? `https://${customDomain}/s/${cap.id}`
					: buildEnv.NEXT_PUBLIC_IS_CAP && !customDomain && !domainVerified
						? `https://cap.link/${cap.id}`
						: `${webUrl}/s/${cap.id}`,
		);
	};
	const canEditVideo =
		isOwner &&
		!sharedCapCard &&
		cap.isScreenshot !== true &&
		!cap.hasActiveUpload &&
		(cap.source?.type === "desktopMP4" || cap.source?.type === "webMP4") &&
		Boolean(cap.duration && cap.duration > 0);
	const handleEditVideo = () => {
		if (!canEditVideo) return;
		if (!user.isPro) {
			setEditUpgradeModalOpen(true);
			return;
		}
		router.push(`/s/${cap.id}/edit`);
	};

	return (
		<>
			<UpgradeModal
				open={editUpgradeModalOpen}
				onOpenChange={setEditUpgradeModalOpen}
			/>
			<SharingDialog
				isOpen={isSharingDialogOpen}
				onClose={() => setIsSharingDialogOpen(false)}
				capId={cap.id}
				capName={cap.name}
				sharedSpaces={cap.sharedSpaces || []}
				onSharingUpdated={handleSharingUpdated}
				isPublic={cap.public}
				hasPassword={passwordProtected}
				inheritedPasswordSources={cap.inheritedPasswordSources}
				onPasswordUpdated={handlePasswordUpdated}
			/>
			<SettingsDialog
				isOpen={isSettingsDialogOpen}
				settingsData={cap.settings ?? undefined}
				inheritedSpaceSettings={cap.inheritedSpaceSettings}
				capId={cap.id}
				onClose={() => setIsSettingsDialogOpen(false)}
			/>
			<PasswordDialog
				isOpen={isPasswordDialogOpen}
				onClose={() => setIsPasswordDialogOpen(false)}
				videoId={cap.id}
				hasPassword={passwordProtected}
				onPasswordUpdated={handlePasswordUpdated}
			/>
			{moveEnabled && moveLocation && moveRootLabel && (
				<MoveItemsDialog
					open={isMoveDialogOpen}
					onOpenChange={setIsMoveDialogOpen}
					location={moveLocation}
					rootLabel={moveRootLabel}
					item={{
						type: "videos",
						videoIds: [cap.id],
						currentFolderId,
					}}
				/>
			)}
			<fieldset
				aria-label={cap.name}
				draggable={moveEnabled && !anyCapSelected}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
				className={clsx(
					"flex relative overflow-hidden transition-colors duration-200 flex-col gap-4 w-full h-full rounded-xl cursor-default bg-gray-1 border border-gray-3 group z-10",
					isSelected
						? "!border-blue-10"
						: anyCapSelected
							? "border-blue-10 hover:border-blue-10"
							: "hover:border-blue-10",
					isDragging && "opacity-50",
					moveEnabled &&
						!anyCapSelected &&
						"cursor-grab active:cursor-grabbing",
				)}
			>
				{anyCapSelected && !sharedCapCard && (
					<button
						type="button"
						aria-label={`Select ${cap.name}`}
						className="absolute inset-0 z-10"
						onClick={handleSelectClick}
					/>
				)}

				<div
					className={clsx(
						"flex absolute duration-200",
						anyCapSelected
							? "opacity-0"
							: isDropdownOpen
								? "opacity-100"
								: "opacity-0 group-hover:opacity-100",
						"top-2 right-2 flex-col gap-2 z-[51]",
					)}
				>
					<CapCardButton
						tooltipContent="Copy link"
						onClick={(e) => {
							e.stopPropagation();
							copyLinkHandler();
							toast.success("Link copied to clipboard");
						}}
						className="delay-0"
						icon={
							!copyPressed ? (
								<FontAwesomeIcon
									className="text-gray-12 size-4"
									icon={faLink}
								/>
							) : (
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="24"
									height="24"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
									className="text-gray-12 size-5 svgpathanimation"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
							)
						}
					/>
					{isOwner && (
						<CapCardButton
							tooltipContent="Share"
							onClick={(e) => {
								e.stopPropagation();
								setIsSharingDialogOpen(true);
							}}
							className="delay-0"
							icon={<FontAwesomeIcon icon={faShare} />}
						/>
					)}

					<DropdownMenu modal={false} onOpenChange={setIsDropdownOpen}>
						<DropdownMenuTrigger asChild suppressHydrationWarning>
							<div>
								<CapCardButton
									tooltipContent="More options"
									className="delay-75"
									icon={<FontAwesomeIcon icon={faEllipsis} />}
								/>
							</div>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							sideOffset={5}
							suppressHydrationWarning
						>
							{isOwner && (
								<>
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											setIsSettingsDialogOpen(true);
										}}
										className="flex gap-2 items-center rounded-lg"
									>
										<FontAwesomeIcon className="size-3" icon={faGear} />
										<p className="text-sm text-gray-12">Settings</p>
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											router.push(`/dashboard/analytics/s/${cap.id}`);
										}}
										className="flex gap-2 items-center rounded-lg"
									>
										<FontAwesomeIcon className="size-3" icon={faChartSimple} />
										<p className="text-sm text-gray-12">View analytics</p>
									</DropdownMenuItem>
								</>
							)}
							<DropdownMenuItem
								onClick={(e) => {
									e.stopPropagation();
									handleDownload();
								}}
								className="flex gap-2 items-center rounded-lg"
							>
								<FontAwesomeIcon icon={faDownload} />
								<p className="text-sm text-gray-12">Download</p>
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={(e) => {
									e.stopPropagation();
									copyLinkHandler();
									toast.success("Link copied to clipboard");
								}}
								className="flex gap-2 items-center rounded-lg"
							>
								<FontAwesomeIcon className="size-3" icon={faLink} />
								<p className="text-sm text-gray-12">Copy link</p>
							</DropdownMenuItem>
							{moveEnabled && (
								<DropdownMenuItem
									onClick={(event) => {
										event.stopPropagation();
										setIsMoveDialogOpen(true);
									}}
									className="flex gap-2 items-center rounded-lg"
								>
									<FolderInput className="size-3" />
									<p className="text-sm text-gray-12">Move</p>
								</DropdownMenuItem>
							)}
							{isOwner && (
								<>
									<DropdownMenuItem
										onClick={() => {
											toast.promise(duplicateMutation.mutateAsync(), {
												loading: "Duplicating cap...",
												success: "Cap duplicated successfully",
												error: "Failed to duplicate cap",
											});
										}}
										disabled={
											duplicateMutation.isPending || cap.hasActiveUpload
										}
										className="flex gap-2 items-center rounded-lg"
									>
										<FontAwesomeIcon className="size-3" icon={faCopy} />
										<p className="text-sm text-gray-12">Duplicate</p>
									</DropdownMenuItem>
									{canEditVideo && (
										<DropdownMenuItem
											onClick={(e) => {
												e.stopPropagation();
												handleEditVideo();
											}}
											className="flex gap-2 items-center rounded-lg"
										>
											<FontAwesomeIcon className="size-3" icon={faScissors} />
											<p className="text-sm text-gray-12">Edit video</p>
										</DropdownMenuItem>
									)}
									<DropdownMenuItem
										onClick={() => {
											if (!user.isPro) setUpgradeModalOpen(true);
											else setIsPasswordDialogOpen(true);
										}}
										className="flex gap-2 items-center rounded-lg"
									>
										<FontAwesomeIcon
											className="size-3"
											icon={effectivePasswordProtected ? faLock : faUnlock}
										/>
										<p className="text-sm text-gray-12">
											{passwordProtected ? "Edit password" : "Add password"}
										</p>
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											setConfirmOpen(true);
										}}
										className="flex gap-2 items-center rounded-lg"
									>
										<FontAwesomeIcon className="size-3" icon={faTrash} />
										<p className="text-sm text-gray-12">Delete Cap</p>
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>

					<ConfirmationDialog
						open={confirmOpen}
						icon={<FontAwesomeIcon icon={faVideo} />}
						title="Delete Cap"
						description={`Are you sure you want to delete the cap "${cap.name}"? This action cannot be undone.`}
						confirmLabel={deleteMutation.isPending ? "Deleting..." : "Delete"}
						cancelLabel="Cancel"
						loading={deleteMutation.isPending}
						onConfirm={() => deleteMutation.mutate()}
						onCancel={() => setConfirmOpen(false)}
					/>
				</div>

				{!sharedCapCard && onSelectToggle && (
					<button
						type="button"
						aria-label={isSelected ? "Deselect cap" : "Select cap"}
						className={clsx(
							"absolute top-2 left-2 z-[49] duration-200",
							isSelected || anyCapSelected || isDropdownOpen
								? "opacity-100"
								: "group-hover:opacity-100 opacity-0",
						)}
						onClick={(e) => {
							e.stopPropagation();
							handleSelectClick(e);
						}}
					>
						<div
							className={clsx(
								"flex justify-center items-center w-6 h-6 rounded-md border transition-colors cursor-pointer hover:bg-gray-3/60",
								isSelected
									? "bg-blue-10 border-blue-10"
									: "border-white-95 bg-gray-1/80",
							)}
						>
							{isSelected && (
								<FontAwesomeIcon icon={faCheck} className="text-white size-3" />
							)}
						</div>
					</button>
				)}

				<div className="relative aspect-video w-full">
					<Link
						className={clsx(
							"relative block w-full h-full",
							// "block group",
							anyCapSelected && "cursor-pointer pointer-events-none",
						)}
						onClick={(e) => {
							if (isDeleting) e.preventDefault();
						}}
						href={`/s/${cap.id}`}
					>
						{hasVisibleUploadProgress && (
							<>
								<div className="absolute inset-0 z-20 transition-all duration-300 bg-black/60 rounded-t-xl" />
								<div className="flex absolute bottom-3 left-3 gap-2 items-center z-30">
									{uploadProgress.status === "failed" ||
									uploadProgress.status === "error" ? (
										<span className="text-sm font-semibold text-red-400">
											{uploadProgress.status === "error"
												? "Processing failed"
												: "Upload failed"}
										</span>
									) : (
										<>
											<span className="text-sm font-semibold text-white">
												{getProgressStatusText(
													uploadProgress.status === "processing"
														? "processing"
														: uploadProgress.status === "generating_thumbnail"
															? "generating_thumbnail"
															: "uploading",
												)}
												{uploadProgress.status === "uploading" &&
													uploadProgress.progress > 0 &&
													` ${Math.round(uploadProgress.progress)}%`}
											</span>
											{(uploadProgress.status === "processing" ||
												uploadProgress.status === "generating_thumbnail") &&
											uploadProgress.progress === 0 ? (
												<svg
													className="w-4 h-4 animate-spin"
													viewBox="0 0 20 20"
													aria-hidden="true"
												>
													<circle
														cx="10"
														cy="10"
														r="8"
														stroke="currentColor"
														strokeWidth="3"
														fill="none"
														className="text-white/30"
													/>
													<circle
														cx="10"
														cy="10"
														r="8"
														stroke="currentColor"
														strokeWidth="3"
														fill="none"
														strokeLinecap="round"
														className="text-white"
														strokeDasharray="12.5 37.5"
													/>
												</svg>
											) : (
												<svg
													className="w-4 h-4 transform -rotate-90"
													viewBox="0 0 20 20"
													aria-hidden="true"
												>
													<circle
														cx="10"
														cy="10"
														r="8"
														stroke="currentColor"
														strokeWidth="3"
														fill="none"
														className="text-white/30"
													/>
													<circle
														cx="10"
														cy="10"
														r="8"
														stroke="currentColor"
														strokeWidth="3"
														fill="none"
														strokeLinecap="round"
														className="text-white transition-all duration-200 ease-out"
														style={{
															strokeDasharray: `${circumference} ${circumference}`,
															strokeDashoffset: `${calculateStrokeDashoffset(
																uploadProgress.progress,
																circumference,
															)}`,
														}}
													/>
												</svg>
											)}
										</>
									)}
								</div>
							</>
						)}

						<VideoThumbnail
							videoDuration={
								hasVisibleUploadProgress || cap.isScreenshot
									? undefined
									: cap.duration
							}
							imageClass={clsx(
								anyCapSelected
									? "opacity-50"
									: isDropdownOpen
										? "opacity-30"
										: "group-hover:opacity-30",
								"transition-opacity duration-200",
							)}
							containerClass="absolute inset-0"
							videoId={cap.id}
							alt={`${cap.name} Thumbnail`}
							imageStatus={imageStatus}
							setImageStatus={setImageStatus}
							showPreview={cap.isScreenshot !== true}
							hasActiveUpload={
								uploadProgress !== null &&
								uploadProgress.status !== "fetching" &&
								uploadProgress.status !== "failed" &&
								uploadProgress.status !== "error"
							}
						/>
						{cap.isScreenshot === true && !hasVisibleUploadProgress && (
							<span
								title="Screenshot"
								className="absolute bottom-3 left-3 z-30 flex size-6 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm"
							>
								<FontAwesomeIcon icon={faImage} className="size-3" />
								<span className="sr-only">Screenshot</span>
							</span>
						)}
						{effectivePasswordProtected && (
							<div
								className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-full bg-black/70 text-white"
								title={
									cap.hasInheritedPassword
										? "Password required by space"
										: "Password protected"
								}
							>
								<FontAwesomeIcon icon={faLock} className="size-3" />
							</div>
						)}
					</Link>
				</div>
				<div
					className={clsx(
						"flex flex-col flex-grow gap-3 px-4 pb-4 w-full",
						!sharedCapCard ? "cursor-pointer" : "cursor-default",
					)}
				>
					<CapCardContent
						cap={cap}
						userId={userId}
						sharedCapCard={sharedCapCard}
						hideSharedStatus={hideSharedStatus}
						isOwner={isOwner}
						setIsSharingDialogOpen={setIsSharingDialogOpen}
					/>
					{children}
					<CapCardAnalytics
						capId={cap.id}
						displayCount={analytics}
						isLoadingAnalytics={isLoadingAnalytics}
						totalComments={cap.totalComments}
						totalReactions={cap.totalReactions}
					/>
				</div>
			</fieldset>
		</>
	);
};
