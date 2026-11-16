"use client";

import { classNames } from "@cap/utils";
import type { Space } from "@cap/web-domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	moveFolderToFolder,
	moveVideosToFolder,
} from "@/actions/folders/moveVideoToFolder";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import {
	CAP_DRAG_TYPE,
	type CapDragPayload,
	describeDraggedCaps,
	FOLDER_DRAG_TYPE,
	parseCapDrag,
	parseFolderDrag,
} from "@/lib/move-items";
import { useDashboardContext } from "../../../Contexts";
import { notifyCapsMoved } from "../../../caps/components/useCapsMoved";
import { registerDropTarget } from "./ClientCapCard";

export function ClientMyCapsLink({
	spaceId,
	compact = false,
	className,
}: {
	spaceId?: Space.SpaceIdOrOrganisationId;
	compact?: boolean;
	className?: string;
}) {
	const [isDragOver, setIsDragOver] = useState(false);
	const [isMovingVideo, setIsMovingVideo] = useState(false);
	const linkRef = useRef<HTMLAnchorElement>(null);
	const router = useRouter();
	const { activeSpace } = useDashboardContext();

	const rootName = activeSpace ? `"${activeSpace.name}"` : "My Caps";

	const processDrop = useCallback(
		async (capData: CapDragPayload) => {
			setIsDragOver(false);

			try {
				setIsMovingVideo(true);

				await moveVideosToFolder({
					videoIds: capData.ids,
					folderId: null,
					spaceId: spaceId ?? null,
				});
				notifyCapsMoved(capData.ids);
				router.refresh();
				toast.success(`Moved ${describeDraggedCaps(capData)} to ${rootName}`);
			} catch (error) {
				console.error("Error moving video:", error);
				toast.error(
					capData.ids.length > 1
						? "Failed to move Caps"
						: "Failed to move video",
				);
			} finally {
				setIsMovingVideo(false);
			}
		},
		[spaceId, router, rootName],
	);

	const handleDrop = async (e: React.DragEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		setIsDragOver(false);

		const folderPayload = parseFolderDrag(
			e.dataTransfer.getData(FOLDER_DRAG_TYPE),
		);
		if (folderPayload) {
			try {
				setIsMovingVideo(true);
				await moveFolderToFolder({
					folderId: folderPayload.id,
					parentId: null,
					spaceId: spaceId ?? null,
				});
				router.refresh();
				toast.success(`Moved "${folderPayload.name}" to ${rootName}`);
			} catch (error) {
				console.error("Error moving folder:", error);
				toast.error("Failed to move folder");
			} finally {
				setIsMovingVideo(false);
			}
			return;
		}

		const capPayload = parseCapDrag(e.dataTransfer.getData(CAP_DRAG_TYPE));
		if (capPayload) await processDrop(capPayload);
	};

	const handleDragOver = (e: React.DragEvent<HTMLAnchorElement>) => {
		e.preventDefault();

		const types = e.dataTransfer.types;
		if (types.includes(CAP_DRAG_TYPE) || types.includes(FOLDER_DRAG_TYPE)) {
			setIsDragOver(true);
		}
	};

	const handleDragLeave = () => {
		setIsDragOver(false);
	};

	useEffect(() => {
		if (!linkRef.current) return;

		const unregister = registerDropTarget(linkRef.current, (data) => {
			if (data && data.type === CAP_DRAG_TYPE && data.id) {
				processDrop({ id: data.id, name: data.name, ids: [data.id] });
			}
		});

		return () => {
			unregister();
		};
	}, [processDrop]);

	return (
		<Link
			ref={linkRef}
			href={spaceId ? `/dashboard/spaces/${spaceId}` : "/dashboard/caps"}
			className={classNames(
				"flex shrink-0 gap-2 items-center px-1 -mx-1 tracking-tight leading-6 whitespace-nowrap rounded-md transition-colors duration-200 hover:text-gray-12",
				compact &&
					"gap-0 min-w-0 max-w-full leading-4 whitespace-normal shrink",
				isDragOver ? "text-gray-12 bg-gray-4" : "text-gray-10",
				isMovingVideo && "opacity-70",
				"drag-target", // Add a class for styling when used as a drop target
				className,
			)}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{activeSpace && !compact && (
				<SignedImageUrl
					image={activeSpace.iconUrl}
					name={activeSpace.name}
					letterClass="text-xs"
					className="relative flex-shrink-0 size-5"
				/>
			)}
			<span
				className={
					compact ? "min-w-0 [overflow-wrap:anywhere]" : "min-w-0 truncate"
				}
			>
				{activeSpace ? activeSpace.name : "My Caps"}
			</span>
		</Link>
	);
}
