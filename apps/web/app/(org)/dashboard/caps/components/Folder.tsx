"use client";
import type { Folder, Space } from "@cap/web-domain";
import { faGlobe } from "@fortawesome/free-solid-svg-icons/faGlobe";
import { faTrash } from "@fortawesome/free-solid-svg-icons/faTrash";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	moveFolderToFolder,
	moveVideosToFolder,
	moveVideoToFolder,
} from "@/actions/folders/moveVideoToFolder";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import {
	CAP_DRAG_TYPE,
	describeDraggedCaps,
	FOLDER_DRAG_TYPE,
	moveLocationKey,
	parseCapDrag,
	parseFolderDrag,
	resolveMoveLocation,
	serializeFolderDrag,
} from "@/lib/move-items";
import { useCopyCollectionLink } from "@/lib/public-collection-client";
import { Fit, Layout, useRive } from "@/lib/rive";
import { ConfirmationDialog } from "../../_components/ConfirmationDialog";
import { libraryDoodleStyles } from "../../_components/library-doodles";
import { useDashboardContext, useTheme } from "../../Contexts";
import { registerDropTarget } from "../../folder/[id]/components/ClientCapCard";
import { FoldersDropdown } from "./FoldersDropdown";
import { MoveItemsDialog } from "./MoveItemsDialog";
import { notifyCapsMoved } from "./useCapsMoved";

export type FolderLayout = "grid" | "list";

export type FolderDataType = {
	name: string;
	id: Folder.FolderId;
	color: "normal" | "blue" | "red" | "yellow";
	public: boolean;
	videoCount: number;
	// Drives "Newest/Oldest first" sorting. Optional so older callers that only
	// need the card for a move menu keep working; missing dates sort as oldest.
	createdAt?: Date | string | null;
	spaceId?: Space.SpaceIdOrOrganisationId | null;
	parentId: Folder.FolderId | null;
	canMove?: boolean;
	moveRootLabel?: string;
	layout?: FolderLayout;
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
	layout = "grid",
}: FolderDataType) => {
	const isList = layout === "list";
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
	const [isDraggingSelf, setIsDraggingSelf] = useState(false);
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
		onError: (_error, variables) => {
			setPublicEnabled(isPublic);
			const failedName = variables.name;
			// Only undo the rename that failed, not one typed since.
			if (failedName !== undefined)
				setUpdateName((current) => (current === failedName ? name : current));
			toast.error("Failed to update folder");
		},
		onSettled: () => setIsRenaming(false),
	});

	const commitRename = () => {
		setIsRenaming(false);
		const nextName = updateName.trim();
		if (!nextName) {
			setUpdateName(name);
			return;
		}
		setUpdateName(nextName);
		if (nextName !== name) updateFolder.mutate({ id, name: nextName });
	};

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

	const handleDragStart = (e: React.DragEvent<HTMLFieldSetElement>) => {
		if (!moveEnabled || isRenaming) return;

		e.dataTransfer.setData(
			FOLDER_DRAG_TYPE,
			serializeFolderDrag({
				id,
				name: updateName,
				locationKey: moveLocationKey(moveLocation),
			}),
		);
		e.dataTransfer.effectAllowed = "move";

		try {
			const dragPreview = document.createElement("div");
			dragPreview.textContent = updateName;
			dragPreview.className =
				"px-2 py-1.5 text-sm font-medium rounded-lg shadow-md text-gray-1 bg-gray-12";
			dragPreview.style.position = "absolute";
			dragPreview.style.top = "-9999px";
			dragPreview.style.left = "-9999px";
			document.body.appendChild(dragPreview);
			e.dataTransfer.setDragImage(dragPreview, 10, 10);
			setTimeout(() => dragPreview.remove(), 100);
		} catch (error) {
			console.error("Error setting drag image:", error);
		}

		setIsDraggingSelf(true);
	};

	const handleDragOver = (e: React.DragEvent<HTMLFieldSetElement>) => {
		if (!moveEnabled || isDraggingSelf) return;
		const types = e.dataTransfer.types;
		if (!types.includes(CAP_DRAG_TYPE) && !types.includes(FOLDER_DRAG_TYPE))
			return;

		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "move";

		if (!isDragOver) {
			setIsDragOver(true);
			dragStateRef.current.isDragging = true;

			if (animationTimerRef.current) {
				clearTimeout(animationTimerRef.current);
				animationTimerRef.current = null;
			}
			if (rive) {
				rive.stop();
				rive.play("folder-open");
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

		const folderPayload = parseFolderDrag(
			e.dataTransfer.getData(FOLDER_DRAG_TYPE),
		);
		if (folderPayload) {
			if (
				folderPayload.id === id ||
				folderPayload.locationKey !== moveLocationKey(moveLocation)
			)
				return;

			try {
				setIsMovingVideo(true);
				await moveFolderToFolder({
					folderId: folderPayload.id,
					parentId: id,
					spaceId,
				});
				toast.success(`"${folderPayload.name}" moved into "${name}"`);
				router.refresh();
			} catch (error) {
				console.error("Error moving folder:", error);
				toast.error("Failed to move folder");
			} finally {
				setIsMovingVideo(false);
			}
			return;
		}

		const capPayload = parseCapDrag(e.dataTransfer.getData(CAP_DRAG_TYPE));
		if (!capPayload) return;

		try {
			setIsMovingVideo(true);
			await moveVideosToFolder({
				videoIds: capPayload.ids,
				folderId: id,
				spaceId,
			});
			toast.success(
				`${describeDraggedCaps(capPayload)} moved to "${name}" folder`,
			);
			notifyCapsMoved(capPayload.ids);
			router.refresh();
		} catch (error) {
			console.error("Error moving video to folder:", error);
			toast.error(
				capPayload.ids.length > 1
					? "Failed to move Caps to folder"
					: "Failed to move video to folder",
			);
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
			draggable={moveEnabled && !isRenaming}
			onDragStart={handleDragStart}
			onDragEnd={() => setIsDraggingSelf(false)}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			className={clsx(
				"flex relative justify-between items-center w-full h-auto min-w-0 rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-all duration-200 bg-gray-1 hover:border-gray-5 hover:shadow-[0_6px_20px_-8px_rgba(0,0,0,0.12)]",
				isList ? "gap-3 px-3 py-2" : "gap-2 px-4 py-3.5 min-h-[94px]",
				isDragOver ? "border-transparent bg-gray-2" : "border-gray-3",
				isMovingVideo && "opacity-70",
				isDraggingSelf && "opacity-50",
			)}
		>
			{isDragOver && (
				<svg className={libraryDoodleStyles.dropZone} aria-hidden="true">
					<rect
						x="1"
						y="1"
						rx="11"
						className={clsx(
							libraryDoodleStyles.accent,
							libraryDoodleStyles.march,
						)}
						strokeWidth={2}
					/>
				</svg>
			)}
			{!isRenaming && (
				<Link
					href={folderHref}
					prefetch={false}
					aria-label={`Open folder ${updateName}`}
					className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-1"
				/>
			)}
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
			<div className="flex flex-1 gap-3 items-center min-w-0">
				<div className="shrink-0 pointer-events-none">
					<FolderRive
						key={`${theme}folder${id}`}
						className={isList ? "size-9" : "w-[50px] h-[50px]"}
					/>
				</div>
				<div
					className={clsx(
						"flex flex-1 min-w-0",
						isList ? "gap-3 items-center" : "flex-col justify-center",
					)}
				>
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
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitRename();
							}}
							className={clsx(
								"relative z-10 flex-1 w-full min-w-0 resize-none bg-transparent border-none focus:outline-none focus:ring-0 focus:border-none text-gray-12 truncate p-0 m-0 h-[22px] leading-[22px] overflow-hidden font-normal tracking-normal",
								isList ? "text-[14px]" : "text-[15px]",
							)}
						/>
					) : (
						<div
							title={updateName}
							className={clsx(
								"block min-w-0 text-left",
								isList ? "flex-1" : "w-full",
							)}
						>
							<span
								className={clsx(
									"text-gray-12 m-0 p-0 font-normal tracking-normal",
									isList
										? "block text-[14px] truncate h-[22px] leading-[22px]"
										: "text-[15px] leading-[22px] line-clamp-2 break-words",
								)}
							>
								{updateName}
							</span>
						</div>
					)}
					<div
						className={clsx(
							"flex gap-2 items-center",
							isList && "shrink-0 justify-end w-32",
						)}
					>
						{publicEnabled && isList && (
							<span className="inline-flex gap-1 items-center text-[11px] font-medium text-blue-9">
								<FontAwesomeIcon icon={faGlobe} className="size-2.5" />
								Public
							</span>
						)}
						<p
							className={clsx(
								"text-sm truncate text-gray-10 w-fit",
								isList && "tabular-nums",
							)}
						>{`${videoCount} ${videoCount === 1 ? "video" : "videos"}`}</p>
						{publicEnabled && !isList && (
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
			<div className="relative z-10 shrink-0">
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
					canEdit={moveEnabled}
					canMove={moveEnabled}
					onMove={() => setIsMoveDialogOpen(true)}
				/>
			</div>
		</fieldset>
	);
};

export default FolderCard;
