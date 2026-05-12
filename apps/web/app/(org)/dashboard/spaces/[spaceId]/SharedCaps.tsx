"use client";

import type { VideoMetadata } from "@cap/database/types";
import { Button } from "@cap/ui";
import type { SpaceRuleSource, ViewerSettingKey } from "@cap/web-backend";
import type {
	ImageUpload,
	Organisation,
	Space,
	User,
	Video,
} from "@cap/web-domain";
import {
	faFolderPlus,
	faGear,
	faInfoCircle,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useVideosAnalyticsQuery } from "@/lib/Queries/Analytics";
import SpaceDialog from "../../_components/Navbar/SpaceDialog";
import { useDashboardContext } from "../../Contexts";
import { CapPagination } from "../../caps/components/CapPagination";
import Folder, { type FolderDataType } from "../../caps/components/Folder";
import { NewFolderDialog } from "../../caps/components/NewFolderDialog";
import { AddVideosDialog } from "./components/AddVideosDialog";
import { AddVideosToOrganizationDialog } from "./components/AddVideosToOrganizationDialog";
import { EmptySharedCapState } from "./components/EmptySharedCapState";
import { MembersIndicator } from "./components/MembersIndicator";
import {
	OrganizationIndicator,
	type OrganizationMemberData,
} from "./components/OrganizationIndicator";
import { SharedCapCard } from "./components/SharedCapCard";
import type { SpaceMemberData } from "./page";

type SharedVideoData = {
	id: Video.VideoId;
	ownerId: string;
	name: string;
	createdAt: Date;
	public?: boolean;
	totalComments: number;
	totalReactions: number;
	ownerName: string | null;
	metadata?: VideoMetadata;
	hasPassword?: boolean;
	hasInheritedPassword?: boolean;
	inheritedPasswordSources?: SpaceRuleSource[];
	inheritedSpaceSettings?: Partial<Record<ViewerSettingKey, SpaceRuleSource[]>>;
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
}[];

type SpaceData = {
	id: Space.SpaceIdOrOrganisationId;
	name: string;
	organizationId: Organisation.OrganisationId;
	createdById: User.UserId;
	iconUrl?: ImageUpload.ImageUrl | null;
	settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
	hasPassword?: boolean;
};

export const SharedCaps = ({
	data,
	count,
	spaceData,
	spaceId,
	spaceMembers,
	organizationMembers,
	currentUserId,
	folders,
	analyticsEnabled,
	organizationData,
}: {
	data: SharedVideoData;
	count: number;
	analyticsEnabled: boolean;
	spaceData?: SpaceData;
	spaceId: Space.SpaceIdOrOrganisationId;
	hideSharedWith?: boolean;
	spaceMembers?: SpaceMemberData[];
	organizationMembers?: OrganizationMemberData[];
	currentUserId?: User.UserId;
	folders?: FolderDataType[];
	organizationData?: {
		id: Organisation.OrganisationId;
		name: string;
		ownerId: User.UserId;
	};
}) => {
	const params = useSearchParams();
	const router = useRouter();
	const page = Number(params.get("page")) || 1;
	const { activeOrganization } = useDashboardContext();
	const limit = 15;
	const [openNewFolderDialog, setOpenNewFolderDialog] = useState(false);
	const totalPages = Math.ceil(count / limit);
	const [isDraggingCap, setIsDraggingCap] = useState({
		isOwner: false,
		isDragging: false,
	});
	const [isAddVideosDialogOpen, setIsAddVideosDialogOpen] = useState(false);
	const [isSpaceSettingsOpen, setIsSpaceSettingsOpen] = useState(false);
	const [
		isAddOrganizationVideosDialogOpen,
		setIsAddOrganizationVideosDialogOpen,
	] = useState(false);

	const isSpaceOwner = spaceData?.createdById === currentUserId;
	const isOrgOwner = organizationData?.ownerId === currentUserId;

	const spaceMemberCount = spaceMembers?.length || 0;

	const organizationMemberCount = organizationMembers?.length || 0;

	const analyticsQuery = useVideosAnalyticsQuery(
		data.map((video) => video.id),
		analyticsEnabled,
	);

	const analytics = analyticsQuery.data || {};

	const handleVideosAdded = () => {
		router.refresh();
	};

	const spaceSettingsDialog = spaceData ? (
		<SpaceDialog
			edit
			open={isSpaceSettingsOpen}
			onClose={() => setIsSpaceSettingsOpen(false)}
			onSpaceUpdated={() => {
				router.refresh();
				setIsSpaceSettingsOpen(false);
			}}
			space={{
				id: spaceData.id,
				name: spaceData.name,
				members: spaceMembers?.map((member) => member.userId) ?? [],
				iconUrl: spaceData.iconUrl ?? undefined,
				settings: spaceData.settings ?? null,
				hasPassword: spaceData.hasPassword,
			}}
		/>
	) : null;

	if (data.length === 0 && folders?.length === 0) {
		return (
			<div className="flex relative flex-col w-full h-full">
				{spaceSettingsDialog}
				{spaceData && spaceMembers && (
					<div className="flex flex-wrap gap-3">
						<MembersIndicator
							memberCount={spaceMemberCount}
							members={spaceMembers}
							organizationMembers={organizationMembers || []}
							spaceId={spaceData.id}
							canManageMembers={isSpaceOwner}
							onAddVideos={() => setIsAddVideosDialogOpen(true)}
						/>
						{isSpaceOwner && (
							<Button
								variant="gray"
								size="sm"
								onClick={() => setIsSpaceSettingsOpen(true)}
							>
								<FontAwesomeIcon className="size-3" icon={faGear} />
								Space settings
							</Button>
						)}
					</div>
				)}
				{organizationData && organizationMembers && !spaceData && (
					<OrganizationIndicator
						memberCount={organizationMemberCount}
						members={organizationMembers}
						organizationName={organizationData.name}
						canManageMembers={isOrgOwner}
						onAddVideos={() => setIsAddOrganizationVideosDialogOpen(true)}
					/>
				)}
				<EmptySharedCapState
					organizationName={activeOrganization?.organization.name || ""}
					type={spaceData ? "space" : "organization"}
					spaceData={spaceData}
					currentUserId={currentUserId}
					onAddVideos={
						spaceData
							? () => setIsAddVideosDialogOpen(true)
							: () => setIsAddOrganizationVideosDialogOpen(true)
					}
				/>
				{spaceData && (
					<AddVideosDialog
						open={isAddVideosDialogOpen}
						onClose={() => setIsAddVideosDialogOpen(false)}
						spaceId={spaceId}
						spaceName={spaceData.name}
						onVideosAdded={handleVideosAdded}
					/>
				)}
				{organizationData && (
					<AddVideosToOrganizationDialog
						open={isAddOrganizationVideosDialogOpen}
						onClose={() => setIsAddOrganizationVideosDialogOpen(false)}
						organizationId={organizationData.id}
						organizationName={organizationData.name}
						onVideosAdded={handleVideosAdded}
						spaceId={spaceId}
					/>
				)}
			</div>
		);
	}

	return (
		<div className="flex relative flex-col w-full h-full">
			{spaceSettingsDialog}
			{isDraggingCap.isDragging && (
				<div className="fixed inset-0 z-50 pointer-events-none">
					<div className="flex justify-center items-center w-full h-full">
						<div className="flex gap-2 items-center px-5 py-3 text-sm font-medium text-white rounded-xl bg-blue-12">
							<FontAwesomeIcon
								className="size-3.5 text-white opacity-50"
								icon={faInfoCircle}
							/>
							<p className="text-white">
								{isDraggingCap.isOwner
									? " Drag to a space to share or folder to move"
									: "Only the video owner can drag and move the video"}
							</p>
						</div>
					</div>
				</div>
			)}
			<NewFolderDialog
				open={openNewFolderDialog}
				spaceId={spaceData?.id ?? activeOrganization?.organization.id}
				onOpenChange={setOpenNewFolderDialog}
			/>
			<div className="flex flex-wrap gap-3 mb-10">
				{spaceData && spaceMembers && (
					<>
						<MembersIndicator
							memberCount={spaceMemberCount}
							members={spaceMembers}
							organizationMembers={organizationMembers || []}
							spaceId={spaceData.id}
							canManageMembers={isSpaceOwner}
							onAddVideos={() => setIsAddVideosDialogOpen(true)}
						/>
						{isSpaceOwner && (
							<Button
								variant="gray"
								size="sm"
								onClick={() => setIsSpaceSettingsOpen(true)}
							>
								<FontAwesomeIcon className="size-3" icon={faGear} />
								Space settings
							</Button>
						)}
					</>
				)}
				{organizationData && organizationMembers && !spaceData && (
					<OrganizationIndicator
						memberCount={organizationMemberCount}
						members={organizationMembers}
						organizationName={organizationData.name}
						canManageMembers={isOrgOwner}
						onAddVideos={() => setIsAddOrganizationVideosDialogOpen(true)}
					/>
				)}
				{spaceData && (
					<AddVideosDialog
						open={isAddVideosDialogOpen}
						onClose={() => setIsAddVideosDialogOpen(false)}
						spaceId={spaceId}
						spaceName={spaceData.name}
						onVideosAdded={handleVideosAdded}
					/>
				)}
				{organizationData && (
					<AddVideosToOrganizationDialog
						open={isAddOrganizationVideosDialogOpen}
						onClose={() => setIsAddOrganizationVideosDialogOpen(false)}
						organizationId={organizationData.id}
						organizationName={organizationData.name}
						onVideosAdded={handleVideosAdded}
						spaceId={spaceId}
					/>
				)}
				<Button
					onClick={() => setOpenNewFolderDialog(true)}
					size="sm"
					variant="dark"
					className="flex gap-2 items-center w-fit"
				>
					<FontAwesomeIcon className="size-3.5" icon={faFolderPlus} />
					New Folder
				</Button>
			</div>
			{folders && folders.length > 0 && (
				<>
					<h1 className="mb-6 text-2xl font-medium text-gray-12">Folders</h1>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4 mb-10">
						{folders.map((folder) => (
							<Folder key={folder.id} {...folder} />
						))}
					</div>
				</>
			)}

			{data.length > 0 && (
				<>
					<h1 className="mb-4 text-2xl font-medium text-gray-12">Videos</h1>
					<div className="grid grid-cols-1 gap-4 sm:gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
						{data.map((cap) => {
							const isOwner = cap.ownerId === currentUserId;
							return (
								<SharedCapCard
									key={cap.id}
									cap={cap}
									hideSharedStatus
									isLoadingAnalytics={analyticsQuery.isLoading}
									analytics={analytics[cap.id] || 0}
									organizationName={activeOrganization?.organization.name || ""}
									spaceName={spaceData?.name || ""}
									userId={currentUserId}
									onDragStart={() =>
										setIsDraggingCap({ isOwner, isDragging: true })
									}
									onDragEnd={() =>
										setIsDraggingCap({ isOwner, isDragging: false })
									}
								/>
							);
						})}
					</div>
					{(data.length > limit || data.length === limit || page !== 1) && (
						<div className="mt-4">
							<CapPagination currentPage={page} totalPages={totalPages} />
						</div>
					)}
				</>
			)}
		</div>
	);
};
