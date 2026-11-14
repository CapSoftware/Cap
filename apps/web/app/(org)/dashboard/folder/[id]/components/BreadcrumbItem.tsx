"use client";

import type { Folder, Space } from "@cap/web-domain";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import {
	moveFolderToFolder,
	moveVideosToFolder,
} from "@/actions/folders/moveVideoToFolder";
import {
	CAP_DRAG_TYPE,
	describeDraggedCaps,
	FOLDER_DRAG_TYPE,
	parseCapDrag,
	parseFolderDrag,
} from "@/lib/move-items";
import { useDashboardContext } from "../../../Contexts";
import { AllFolders } from "../../../caps/components/Folders";
import { notifyCapsMoved } from "../../../caps/components/useCapsMoved";

interface BreadcrumbItemProps {
	id: Folder.FolderId;
	name: string;
	color: "normal" | "blue" | "red" | "yellow";
	spaceId?: Space.SpaceIdOrOrganisationId | null;
	isLast: boolean;
}

export function BreadcrumbItem({
	id,
	name,
	color,
	isLast,
	spaceId,
}: BreadcrumbItemProps) {
	const [isDragOver, setIsDragOver] = useState(false);
	const [isMoving, setIsMoving] = useState(false);
	const router = useRouter();
	const { activeSpace } = useDashboardContext();
	// The route's space comes first: the context only knows spaces the viewer
	// created, joined or can see publicly.
	const linkSpaceId = spaceId ?? activeSpace?.id;

	const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();

		const types = e.dataTransfer.types;
		if (
			types.includes(CAP_DRAG_TYPE) ||
			(!isLast && types.includes(FOLDER_DRAG_TYPE))
		) {
			setIsDragOver(true);
			e.dataTransfer.dropEffect = "move";
		}
	};

	const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	};

	const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);

		const folderPayload = parseFolderDrag(
			e.dataTransfer.getData(FOLDER_DRAG_TYPE),
		);
		if (folderPayload) {
			if (isLast || folderPayload.id === id) return;

			try {
				setIsMoving(true);
				await moveFolderToFolder({
					folderId: folderPayload.id,
					parentId: id,
					spaceId: spaceId ?? null,
				});
				router.refresh();
				toast.success(`"${folderPayload.name}" moved into "${name}"`);
			} catch (error) {
				console.error("Error moving folder:", error);
				toast.error("Failed to move folder");
			} finally {
				setIsMoving(false);
			}
			return;
		}

		const capPayload = parseCapDrag(e.dataTransfer.getData(CAP_DRAG_TYPE));
		if (!capPayload) return;

		try {
			setIsMoving(true);
			await moveVideosToFolder({
				videoIds: capPayload.ids,
				folderId: id,
				spaceId: spaceId ?? null,
			});
			notifyCapsMoved(capPayload.ids);
			router.refresh();
			toast.success(
				`${describeDraggedCaps(capPayload)} moved to "${name}" folder`,
			);
		} catch (error) {
			console.error("Error moving video to folder:", error);
			toast.error(
				capPayload.ids.length > 1
					? "Failed to move Caps to folder"
					: "Failed to move video to folder",
			);
		} finally {
			setIsMoving(false);
		}
	};

	if (isLast) {
		return (
			<div
				className="flex gap-2 items-center px-2 min-w-0"
				title={name}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<AllFolders color={color} className="size-5 shrink-0" />
				<p
					className={clsx(
						"text-xl font-semibold tracking-tight truncate text-gray-12",
						{
							"opacity-70": isMoving,
						},
					)}
				>
					{name}
				</p>
			</div>
		);
	}

	return (
		<div
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			className={clsx(`relative px-2`, {
				"rounded-lg bg-gray-5": isDragOver,
				"opacity-70": isMoving,
			})}
		>
			<Link
				href={
					linkSpaceId
						? `/dashboard/spaces/${linkSpaceId}/folder/${id}`
						: `/dashboard/folder/${id}`
				}
				className="flex gap-1.5 items-center transition-colors duration-200 z-10 relative"
			>
				<AllFolders color={color} className="size-5" />
				<p
					className={clsx(
						"text-lg whitespace-nowrap transition-colors duration-200 hover:text-gray-11",
						isDragOver ? "text-gray-12" : "text-gray-9",
					)}
				>
					{name}
				</p>
			</Link>
		</div>
	);
}
