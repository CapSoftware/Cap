"use client";

import type { VideoMetadata } from "@cap/database/types";
import { buildEnv, NODE_ENV } from "@cap/env";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import type { ImageUpload, Video } from "@cap/web-domain";
import { HttpClient } from "@effect/platform";
import {
	faCheck,
	faCopy,
	faDownload,
	faEllipsis,
	faGear,
	faLink,
	faLock,
	faShare,
	faTrash,
	faUnlock,
	faVideo,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Effect, Option } from "effect";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type PropsWithChildren, useState } from "react";
import { toast } from "sonner";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useFeatureFlag } from "@/app/Layout/features";
import ProgressCircle, {
	useUploadProgress,
} from "@/app/s/[videoId]/_components/ProgressCircle";
import {
	type ImageLoadingStatus,
	VideoThumbnail,
} from "@/components/VideoThumbnail";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import { usePublicEnv } from "@/utils/public-env";
import { PasswordDialog } from "../PasswordDialog";
import { SettingsDialog } from "../SettingsDialog";
import { SharingDialog } from "../SharingDialog";
import { CapCardAnalytics } from "./CapCardAnalytics";
import { CapCardButton } from "./CapCardButton";
import { CapCardContent } from "./CapCardContent";

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
		}[];
		ownerName: string | null;
		metadata?: VideoMetadata;
		hasPassword?: boolean;
		hasActiveUpload: boolean | undefined;
		duration?: number;
		settings?: {
			disableComments?: boolean;
			disableSummary?: boolean;
			disableCaptions?: boolean;
			disableChapters?: boolean;
			disableReactions?: boolean;
			disableTranscript?: boolean;
		};
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
	const { webUrl } = usePublicEnv();

	const [copyPressed, setCopyPressed] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
	const { isSubscribed, setUpgradeModalOpen } = useDashboardContext();

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

	const uploadProgress = useUploadProgress(
		cap.id,
		cap.hasActiveUpload || false,
	);
	const [imageStatus, setImageStatus] = useState<ImageLoadingStatus>("loading");

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

	const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
		if (anyCapSelected || !isOwner) return;

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
		navigator.clipboard.writeText(text);
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

	const handleCardClick = (e: React.MouseEvent) => {
		if (anyCapSelected) {
			e.preventDefault();
			e.stopPropagation();
			if (onSelectToggle) {
				onSelectToggle();
			}
		}
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

	return (
		<>
			<SharingDialog
				isOpen={isSharingDialogOpen}
				onClose={() => setIsSharingDialogOpen(false)}
				capId={cap.id}
				capName={cap.name}
				sharedSpaces={cap.sharedSpaces || []}
				onSharingUpdated={handleSharingUpdated}
				isPublic={cap.public}
			/>
			<SettingsDialog
				isOpen={isSettingsDialogOpen}
				settingsData={cap.settings}
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
			<div
				onClick={handleCardClick}
				draggable={isOwner && !anyCapSelected}
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
					isOwner && !anyCapSelected && "cursor-grab active:cursor-grabbing",
				)}
			>
				{anyCapSelected && !sharedCapCard && (
					<div className="absolute inset-0 z-10" onClick={handleCardClick} />
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

					<CapCardButton
						tooltipContent="Download Cap"
						onClick={(e) => {
							e.stopPropagation();
							handleDownload();
						}}
						className="delay-0"
						icon={<FontAwesomeIcon icon={faDownload} />}
					/>

					{!isOwner && (
						<CapCardButton
							tooltipContent="Copy link"
							onClick={(e) => {
								e.stopPropagation();
								copyLinkHandler();
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
										className="text-gray-12 size-5 svgpathanimation"
									>
										<path d="M20 6 9 17l-5-5" />
									</svg>
								)
							}
						/>
					)}

					{isOwner && (
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
										copyLinkHandler();
										toast.success("Link copied to clipboard");
									}}
									className="flex gap-2 items-center rounded-lg"
								>
									<FontAwesomeIcon className="size-3" icon={faLink} />
									<p className="text-sm text-gray-12">Copy link</p>
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => {
										toast.promise(duplicateMutation.mutateAsync(), {
											loading: "Duplicating cap...",
											success: "Cap duplicated successfully",
											error: "Failed to duplicate cap",
										});
									}}
									disabled={duplicateMutation.isPending || cap.hasActiveUpload}
									className="flex gap-2 items-center rounded-lg"
								>
									<FontAwesomeIcon className="size-3" icon={faCopy} />
									<p className="text-sm text-gray-12">Duplicate</p>
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => {
										if (!isSubscribed) setUpgradeModalOpen(true);
										else setIsPasswordDialogOpen(true);
									}}
									className="flex gap-2 items-center rounded-lg"
								>
									<FontAwesomeIcon
										className="size-3"
										icon={passwordProtected ? faLock : faUnlock}
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
							</DropdownMenuContent>
						</DropdownMenu>
					)}

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
					<div
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
					</div>
				)}

				<div className="relative">
					<Link
						className={clsx(
							"relative",
							// "block group",
							anyCapSelected && "cursor-pointer pointer-events-none",
						)}
						onClick={(e) => {
							if (isDeleting) e.preventDefault();
						}}
						href={`/s/${cap.id}`}
					>
						{imageStatus !== "success" &&
						uploadProgress &&
						uploadProgress?.status !== "fetching" ? (
							<div className="relative inset-0 z-20 w-full h-full">
								<div className="overflow-hidden relative mx-auto w-full h-full bg-black rounded-t-xl border-b border-gray-3 aspect-video z-5">
									<div className="flex absolute inset-0 justify-center items-center rounded-t-xl">
										{uploadProgress.status === "failed" ? (
											<div className="flex flex-col items-center">
												<div className="flex justify-center items-center mb-2 w-8 h-8 bg-red-500 rounded-full">
													<FontAwesomeIcon
														icon={faVideo}
														className="text-white size-3"
													/>
												</div>
												<p className="text-[13px] text-center text-white">
													Upload failed
												</p>
											</div>
										) : (
											<div className="relative size-20 md:size-16">
												<ProgressCircle
													progressTextClassName="md:!text-[11px]"
													subTextClassName="!mt-0 md:!text-[7px] !text-[10px] mb-1"
													className="md:scale-[1.5] scale-[1.2]"
													progress={uploadProgress.progress}
												/>
											</div>
										)}
									</div>
								</div>
							</div>
						) : null}

						<VideoThumbnail
							videoDuration={cap.duration}
							imageClass={clsx(
								anyCapSelected
									? "opacity-50"
									: isDropdownOpen
										? "opacity-30"
										: "group-hover:opacity-30",
								"transition-opacity duration-200",
							)}
							containerClass={clsx(
								imageStatus !== "success" && uploadProgress ? "hidden" : "",
								"absolute inset-0",
							)}
							videoId={cap.id}
							alt={`${cap.name} Thumbnail`}
							imageStatus={imageStatus}
							setImageStatus={setImageStatus}
						/>
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
			</div>
		</>
	);
};
