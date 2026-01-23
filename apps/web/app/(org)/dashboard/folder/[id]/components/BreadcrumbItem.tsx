"use client";

import type { Folder, Space } from "@inflight/web-domain";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { moveVideoToFolder } from "@/actions/folders/moveVideoToFolder";
import { useDashboardContext } from "../../../Contexts";
import { AllFolders } from "../../../caps/components/Folders";

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

	const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();

		// Check if the dragged item is a CapCard
		if (e.dataTransfer.types.includes("application/cap")) {
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

		try {
			const data = e.dataTransfer.getData("application/cap");
			if (!data) return;

			const capData = JSON.parse(data);
			if (!capData.id) return;

			setIsMoving(true);
			await moveVideoToFolder({
				videoId: capData.id,
				folderId: id,
				spaceId: spaceId ?? null,
			});
			router.refresh();
			toast.success(`"${capData.name}" moved to "${name}" folder`);
		} catch (error) {
			console.error("Error moving video to folder:", error);
			toast.error("Failed to move video to folder");
		} finally {
			setIsMoving(false);
		}
	};

	if (isLast) {
		return (
			<div
				className="flex gap-1.5 px-2 items-center"
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<AllFolders color={color} className="size-5" />
				<p
					className={clsx(`text-xl whitespace-nowrap text-gray-12`, {
						"opacity-70": isMoving,
					})}
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
					activeSpace
						? `/dashboard/spaces/${activeSpace.id}/folder/${id}`
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
