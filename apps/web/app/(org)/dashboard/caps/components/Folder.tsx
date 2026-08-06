"use client";
import type { Folder, Space } from "@cap/web-domain";
import { faGlobe, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { moveVideoToFolder } from "@/actions/folders/moveVideoToFolder";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { resolveMoveLocation } from "@/lib/move-items";
import { useCopyCollectionLink } from "@/lib/public-collection-client";
import { Fit, Layout, useRive } from "@/lib/rive";
import { ConfirmationDialog } from "../../_components/ConfirmationDialog";
import { useDashboardContext, useTheme } from "../../Contexts";
import { registerDropTarget } from "../../folder/[id]/components/ClientCapCard";
import { FoldersDropdown } from "./FoldersDropdown";
import { MoveItemsDialog } from "./MoveItemsDialog";

export type FolderDataType = {
	name: string;
	id: Folder.FolderId;
	color: "normal" | "blue" | "red" | "yellow";
	public: boolean;
	videoCount: number;
	spaceId?: Space.SpaceIdOrOrganisationId | null;
	parentId: Folder.FolderId | null;
	canMove?: boolean;
	moveRootLabel?: string;
};

const FolderCard = ({
	name,
	color,
	public: isPublic,
	id,
	parentId,
	videoCount,
	spaceId,
	canMove,
	moveRootLabel,
}: FolderDataType) => {
	const router = useRouter();
	const { theme } = useTheme();
	const [confirmDeleteFolderOpen, setConfirmDeleteFolderOpen] = useState(false);
	const [isRenaming, setIsRenaming] = useState(false);
	const [updateName, setUpdateName] = useState(name);
	const [publicEnabled, setPublicEnabled] = useState(isPublic);
	const nameRef = useRef<HTMLTextAreaElement>(null);
	const folderRef = useRef<HTMLFieldSetElement>(null);
	const [isDragOver, setIsDragOver] = useState(false);
	const [isMovingVideo, setIsMovingVideo] = useState(false);
	const [isMoveDialogOpen, setIsMoveDialogOpen] = useState(false);
	const { activeOrganization, setUpgradeModalOpen } = useDashboardContext();
	const ownerIsPro = Boolean(activeOrganization?.ownerIsPro);
	const folderHref = spaceId
		? `/dashboard/spaces/${spaceId}/folder/${id}`
		: `/dashboard/folder/${id}`;
	const moveEnabled = canMove ?? !spaceId;
	const effectiveMoveRootLabel =
		moveRootLabel ??
		(!spaceId ? "My Caps" : (activeOrganization?.organization.name ?? "Space"));
	const moveLocation = resolveMoveLocation(
		spaceId,
		activeOrganization?.organization.id,
	);

	const dragStateRef = useRef({
		isDragging: false,
		isAnimating: false,
	});

	const animationTimerRef = useRef<NodeJS.Timeout | null>(null);

	const artboard =
		theme === "dark" && color === "normal"
			? "folder"
			: color === "normal"
				? "folder-dark"
				: `folder-${color}`;

	const { rive, RiveComponent: FolderRive } = useRive({
		src: "/rive/dashboard.riv",
		artboard,
		animations: "idle",
		autoplay: false,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});

	const rpc = useRpcClient();
	const { copy: copyPublicLink } = useCopyCollectionLink(id);

	const deleteFolder = useEffectMutation({
		mutationFn: (id: Folder.FolderId) => rpc.FolderDelete(id),
		onSuccess: () => {
			router.refresh();
			toast.success("Folder deleted successfully");
			setConfirmDeleteFolderOpen(false);
		},
		onError: () => {
			toast.error("Failed to delete folder");
		},
	});

	const updateFolder = useEffectMutation({
		mutationFn: (data: Folder.FolderUpdate) => rpc.FolderUpdate(data),
		onSuccess: () => {
			toast.success("Folder updated successfully");
			router.refresh();
		},
		onError: () => {
			setPublicEnabled(isPublic);
			toast.error("Failed to update folder");
		},
		onSettled: () => setIsRenaming(false),
	});

	useEffect(() => {
		if (isRenaming && nameRef.current) {
			nameRef.current.focus();
			nameRef.current.select();
		}
	}, [isRenaming]);

	useEffect(() => {
		setPublicEnabled(isPublic);
	}, [isPublic]);

	useEffect(() => {
		if (!folderRef.current || !moveEnabled) return;

		const unregister = registerDropTarget(
			folderRef.current,
			async (data) => {
				if (!data || !data.id) return;

				try {
					setIsMovingVideo(true);
					await moveVideoToFolder({
						videoId: data.id,
						folderId: id,
						spaceId,
					});
					toast.success(`"${data.name}" moved to "${name}" folder`);
					router.refresh();
				} catch (error) {
					console.error("Error moving video to folder:", error);
					toast.error("Failed to move video to folder");
				} finally {
					setIsMovingVideo(false);
					dragStateRef.current.isDragging = false;
				}
			},
			// onDragOver handler
			() => {
				dragStateRef.current.isDragging = true;
				setIsDragOver(true);

				// Clear any pending animation timer
				if (animationTimerRef.current) {
					clearTimeout(animationTimerRef.current);
					animationTimerRef.current = null;
				}

				// Play the folder-open animation
				if (rive) {
					rive.stop();
					rive.play("folder-open");
				}
			},
			// onDragLeave handler
			() => {
				setIsDragOver(false);

				// Clear any pending animation timer
				if (animationTimerRef.current) {
					clearTimeout(animationTimerRef.current);
					animationTimerRef.current = null;
				}

				// Play the folder-close animation
				if (rive) {
					rive.stop();
					rive.play("folder-close");
				}
			},
		);

		// Add global drag end listener
		const handleDragEnd = () => {
			if (dragStateRef.current.isDragging) {
				dragStateRef.current.isDragging = false;
				if (!isDragOver) {
					// Only reset animation if we're not currently over this folder
					if (rive) {
						// Clear any pending animation timer
						if (animationTimerRef.current) {
							clearTimeout(animationTimerRef.current);
							animationTimerRef.current = null;
						}
					}
				}
			}
		};

		document.addEventListener("dragend", handleDragEnd);

		return () => {
			unregister();
			document.removeEventListener("dragend", handleDragEnd);
		};
	}, [id, name, rive, isDragOver, spaceId, moveEnabled, router]);

	const handleDragOver = (e: React.DragEvent<HTMLFieldSetElement>) => {
		if (!moveEnabled) return;
		e.preventDefault();
		e.stopPropagation();

		// Check if the dragged item is a CapCard
		if (e.dataTransfer.types.includes("application/cap")) {
			if (!isDragOver) {
				setIsDragOver(true);
				dragStateRef.current.isDragging = true;
				e.dataTransfer.dropEffect = "move";

				// Clear any pending animation timer
				if (animationTimerRef.current) {
					clearTimeout(animationTimerRef.current);
					animationTimerRef.current = null;
				}
				// Play the folder-open animation when first dragging over
				if (rive) {
					rive.stop();
					rive.play("folder-open");
				}
			}
		}
	};

	const handleDragLeave = (e: React.DragEvent<HTMLFieldSetElement>) => {
		e.preventDefault();
		e.stopPropagation();

		// Check if this is a real leave event (not just moving within the element)
		// by checking if the related target is not a child of our folder element
		const relatedTarget = e.relatedTarget as Node;
		if (folderRef.current && !folderRef.current.contains(relatedTarget)) {
			setIsDragOver(false);

			// Clear any pending animation timer
			if (animationTimerRef.current) {
				clearTimeout(animationTimerRef.current);
				animationTimerRef.current = null;
			}
			if (rive) {
				rive.stop();
				rive.play("folder-close");
			}
		}
	};

	const handleDrop = async (e: React.DragEvent<HTMLFieldSetElement>) => {
		if (!moveEnabled) return;
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
		dragStateRef.current.isDragging = false;

		// Clear any pending animation timer
		if (animationTimerRef.current) {
			clearTimeout(animationTimerRef.current);
			animationTimerRef.current = null;
		}

		// Keep the folder open after a successful drop
		if (rive) {
			rive.stop();
			rive.play("folder-close");
		}

		try {
			const data = e.dataTransfer.getData("application/cap");
			if (!data) return;

			const capData = JSON.parse(data);
			if (!capData.id) return;

			setIsMovingVideo(true);
			await moveVideoToFolder({ videoId: capData.id, folderId: id, spaceId });
			toast.success(`"${capData.name}" moved to "${name}" folder`);
			router.refresh();
		} catch (error) {
			console.error("Error moving video to folder:", error);
			toast.error("Failed to move video to folder");
		} finally {
			setIsMovingVideo(false);
		}
	};

	return (
		<fieldset
			ref={folderRef}
			onMouseEnter={() => {
				if (dragStateRef.current.isDragging) return;
				if (!rive) return;

				if (animationTimerRef.current) {
					clearTimeout(animationTimerRef.current);
					animationTimerRef.current = null;
				}

				animationTimerRef.current = setTimeout(() => {
					rive.stop();
					rive.play("folder-open");
				}, 50);
			}}
			onMouseLeave={() => {
				if (dragStateRef.current.isDragging) return;
				if (!rive) return;

				if (animationTimerRef.current) {
					clearTimeout(animationTimerRef.current);
					animationTimerRef.current = null;
				}

				animationTimerRef.current = setTimeout(() => {
					rive.stop();
					rive.play("folder-close");
				}, 50);
			}}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			className={clsx(
				"flex justify-between items-center px-4 py-4 w-full h-auto min-w-0 rounded-lg border transition-all duration-200 bg-gray-3 hover:bg-gray-4 hover:border-gray-6",
				isDragOver ? "border-blue-10 bg-gray-4" : "border-gray-5",
				isMovingVideo && "opacity-70",
			)}
		>
			{moveEnabled && (
				<MoveItemsDialog
					open={isMoveDialogOpen}
					onOpenChange={setIsMoveDialogOpen}
					location={moveLocation}
					rootLabel={effectiveMoveRootLabel}
					item={{
						type: "folder",
						folderId: id,
						currentParentId: parentId,
					}}
				/>
			)}
			<div className="flex flex-1 gap-3 items-center">
				<Link href={folderHref} prefetch={false} className="shrink-0">
					<FolderRive
						key={`${theme}folder${id}`}
						className="w-[50px] h-[50px]"
					/>
				</Link>
				<div className="flex flex-col justify-center h-10">
					{isRenaming ? (
						<textarea
							ref={nameRef}
							rows={1}
							value={updateName}
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
							}}
							onChange={(e) => setUpdateName(e.target.value)}
							onBlur={() => {
								setIsRenaming(false);
								if (updateName.trim() !== name)
									updateFolder.mutate({
										id,
										name: updateName.trim(),
									});
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									setIsRenaming(false);
									if (updateName.trim() !== name)
										updateFolder.mutate({
											id,
											name: updateName.trim(),
										});
								}
							}}
							className="w-full resize-none bg-transparent border-none focus:outline-none
                 focus:ring-0 focus:border-none text-gray-12 text-[15px] max-w-[116px] truncate p-0 m-0 h-[22px] leading-[22px] overflow-hidden font-normal tracking-normal"
						/>
					) : (
						<Link
							href={folderHref}
							prefetch={false}
							className="block text-left"
						>
							<span className="block text-[15px] truncate text-gray-12 w-full max-w-[116px] m-0 p-0 h-[22px] leading-[22px] font-normal tracking-normal">
								{updateName}
							</span>
						</Link>
					)}
					<div className="flex gap-2 items-center">
						<p className="text-sm truncate text-gray-10 w-fit">{`${videoCount} ${
							videoCount === 1 ? "video" : "videos"
						}`}</p>
						{publicEnabled && (
							<span className="inline-flex gap-1 items-center text-[11px] font-medium text-blue-9">
								<FontAwesomeIcon icon={faGlobe} className="size-2.5" />
								Public
							</span>
						)}
					</div>
				</div>
			</div>
			<ConfirmationDialog
				loading={deleteFolder.isPending}
				open={confirmDeleteFolderOpen}
				icon={<FontAwesomeIcon icon={faTrash} />}
				onConfirm={() => deleteFolder.mutate(id)}
				onCancel={() => setConfirmDeleteFolderOpen(false)}
				confirmLabel={deleteFolder.isPending ? "Deleting..." : "Delete"}
				title="Delete Folder"
				description={`Are you sure you want to delete the folder "${name}"? This action cannot be undone.`}
			/>
			<FoldersDropdown
				id={id}
				parentId={parentId}
				public={publicEnabled}
				setIsRenaming={setIsRenaming}
				setConfirmDeleteFolderOpen={setConfirmDeleteFolderOpen}
				nameRef={nameRef}
				onPublicToggle={() => {
					const nextPublic = !publicEnabled;
					if (nextPublic && !ownerIsPro) {
						setUpgradeModalOpen(true);
						return;
					}
					setPublicEnabled(nextPublic);
					updateFolder.mutate({
						id,
						public: nextPublic,
					});
				}}
				onCopyPublicLink={async () => {
					await copyPublicLink();
				}}
				canMove={moveEnabled}
				onMove={() => setIsMoveDialogOpen(true)}
			/>
		</fieldset>
	);
};

export default FolderCard;
