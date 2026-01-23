"use client";

import type { Space, Video } from "@inflight/web-domain";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { moveVideoToFolder } from "@/actions/folders/moveVideoToFolder";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { useDashboardContext } from "../../../Contexts";
import { registerDropTarget } from "./ClientCapCard";

export function ClientMyCapsLink({
	spaceId,
}: {
	spaceId?: Space.SpaceIdOrOrganisationId;
}) {
	const [isDragOver, setIsDragOver] = useState(false);
	const [isMovingVideo, setIsMovingVideo] = useState(false);
	const linkRef = useRef<HTMLAnchorElement>(null);
	const router = useRouter();
	const { activeSpace } = useDashboardContext();

	const processDrop = useCallback(
		async (capData: { id: Video.VideoId; name: string }) => {
			setIsDragOver(false);

			try {
				if (!capData || !capData.id) {
					console.error("Invalid cap data");
					return;
				}

				setIsMovingVideo(true);

				await moveVideoToFolder({
					videoId: capData.id,
					folderId: null,
					spaceId: spaceId ?? null,
				});
				router.refresh();
				if (activeSpace) {
					toast.success(`Moved "${capData.name}" to "${activeSpace.name}"`);
				} else {
					toast.success(`Moved "${capData.name}" to My Caps`);
				}
			} catch (error) {
				console.error("Error moving video:", error);
				toast.error("Failed to move video");
			} finally {
				setIsMovingVideo(false);
			}
		},
		[spaceId, router, activeSpace],
	);

	const handleDrop = useCallback(
		async (
			e:
				| React.DragEvent<HTMLAnchorElement>
				| { id: Video.VideoId; name: string },
		) => {
			if ("preventDefault" in e) {
				e.preventDefault();

				try {
					const capData = JSON.parse(e.dataTransfer.getData("application/cap"));

					if (!capData || !capData.id) {
						console.error("Invalid cap data");
						return;
					}

					await processDrop(capData);
				} catch (error) {
					console.error("Error processing drop:", error);
					toast.error("Failed to move video");
				}
			} else {
				await processDrop(e);
			}
		},
		[processDrop],
	);

	const handleDragOver = (e: React.DragEvent<HTMLAnchorElement>) => {
		e.preventDefault();

		if (e.dataTransfer.types.includes("application/cap")) {
			setIsDragOver(true);
		}
	};

	const handleDragLeave = () => {
		setIsDragOver(false);
	};

	useEffect(() => {
		if (!linkRef.current) return;

		const unregister = registerDropTarget(linkRef.current, (data) => {
			if (data && data.type === "application/cap") {
				handleDrop({ id: data.id, name: data.name });
			}
		});

		return () => {
			unregister();
		};
	}, [handleDrop]);

	return (
		<Link
			ref={linkRef}
			href={spaceId ? `/dashboard/spaces/${spaceId}` : "/dashboard/caps"}
			className={clsx(
				"text-xl whitespace-nowrap flex items-center gap-1.5 transition-colors duration-200 hover:text-gray-12",
				isDragOver ? "text-blue-10" : "text-gray-9",
				isMovingVideo && "opacity-70",
				"drag-target", // Add a class for styling when used as a drop target
			)}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{activeSpace && (
				<SignedImageUrl
					image={activeSpace.iconUrl}
					name={activeSpace.name}
					letterClass="text-xs"
					className="relative flex-shrink-0 size-5"
				/>
			)}
			{activeSpace ? activeSpace.name : "My Caps"}
		</Link>
	);
}
