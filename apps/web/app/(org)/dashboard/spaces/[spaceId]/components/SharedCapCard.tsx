"use client";

import type { VideoMetadata } from "@cap/database/types";
import type { SpaceRuleSource, ViewerSettingKey } from "@cap/web-backend";
import type { Folder, ImageUpload, Video } from "@cap/web-domain";
import { faBuilding, faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { MoveLocation } from "@/lib/move-items";
import { CapCard } from "../../../caps/components/CapCard/CapCard";

interface SharedCapCardProps {
	cap: {
		id: Video.VideoId;
		ownerId: string;
		name: string;
		createdAt: Date;
		public?: boolean;
		totalComments: number;
		totalReactions: number;
		ownerName: string | null;
		metadata?: VideoMetadata;
		isScreenshot: boolean;
		hasPassword?: boolean;
		hasInheritedPassword?: boolean;
		inheritedPasswordSources?: SpaceRuleSource[];
		inheritedSpaceSettings?: Partial<
			Record<ViewerSettingKey, SpaceRuleSource[]>
		>;
		sharedSpaces?: {
			id: string;
			name: string;
			isOrg: boolean;
			organizationId: string;
			iconUrl?: ImageUpload.ImageUrl | null;
			settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
			hasPassword?: boolean;
		}[];
		hasActiveUpload: boolean | undefined;
		settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
	};
	analytics: number;
	isLoadingAnalytics: boolean;
	organizationName: string;
	userId?: string;
	hideSharedStatus?: boolean;
	spaceName?: string;
	onDragStart?: () => void;
	onDragEnd?: () => void;
	canMove?: boolean;
	moveLocation?: MoveLocation;
	moveRootLabel?: string;
	currentFolderId?: Folder.FolderId | null;
	isSelected?: boolean;
	anyCapSelected?: boolean;
	onSelectToggle?: () => void;
}

export const SharedCapCard: React.FC<SharedCapCardProps> = ({
	cap,
	analytics,
	organizationName,
	userId,
	hideSharedStatus,
	isLoadingAnalytics,
	spaceName,
	onDragStart,
	onDragEnd,
	canMove,
	moveLocation,
	moveRootLabel,
	currentFolderId,
	isSelected,
	anyCapSelected,
	onSelectToggle,
}) => {
	const displayCount =
		analytics === 0
			? Math.max(cap.totalComments, cap.totalReactions)
			: analytics;
	const isOwner = userId === cap.ownerId;

	return (
		<li className="list-none" onDragStart={onDragStart} onDragEnd={onDragEnd}>
			<CapCard
				hideSharedStatus={hideSharedStatus}
				isLoadingAnalytics={isLoadingAnalytics}
				cap={cap}
				analytics={displayCount}
				userId={userId}
				canMove={canMove}
				moveLocation={moveLocation}
				moveRootLabel={moveRootLabel}
				currentFolderId={currentFolderId}
				isSelected={isSelected}
				anyCapSelected={anyCapSelected}
				onSelectToggle={onSelectToggle}
			>
				<div className="mb-2 space-y-1">
					{cap.ownerName && (
						<div className="flex gap-2 items-center">
							<FontAwesomeIcon icon={faUser} className="text-gray-10 size-3" />
							<span className="text-sm text-gray-10">{cap.ownerName}</span>
						</div>
					)}
					{isOwner && (
						<div className="flex gap-2 items-center">
							<FontAwesomeIcon
								icon={faBuilding}
								className="text-gray-10 size-2.5"
							/>
							<p className="text-sm pointer-events-none text-gray-10">
								Shared with{" "}
								<span className="text-sm font-medium text-gray-12">
									{spaceName || organizationName}
								</span>
							</p>
						</div>
					)}
				</div>
			</CapCard>
		</li>
	);
};
