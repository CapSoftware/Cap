"use client";

import type { VideoMetadata } from "@cap/database/types";
import { Button } from "@cap/ui";
import type { SpaceRuleSource, ViewerSettingKey } from "@cap/web-backend";
import type {
	ImageUpload,
	Organisation,
	PublicCollection,
	Space,
	User,
	Video,
} from "@cap/web-domain";
import { faFolderPlus } from "@fortawesome/free-solid-svg-icons/faFolderPlus";
import { faGear } from "@fortawesome/free-solid-svg-icons/faGear";
import clsx from "clsx";
import { motion, useReducedMotion } from "framer-motion";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
	type DragEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";
import { reorderSpaceVideos } from "@/actions/spaces/video-order";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import {
	type SeededThumbnails,
	SeededThumbnailsProvider,
} from "@/components/VideoThumbnail";
import { DEFAULT_DASHBOARD_PAGE_SIZE } from "@/lib/dashboard-page-size";
import { CAP_DRAG_TYPE, parseCapDrag } from "@/lib/move-items";
import { parsePageParam } from "@/lib/page-param";
import {
	canManageOrganizationMembers,
	canManageSpace,
	getEffectiveOrganizationRole,
	getEffectiveSpaceRole,
} from "@/lib/permissions/roles";
import { useVideosAnalyticsQuery } from "@/lib/Queries/Analytics";
import {
	MAX_REORDER_ITEMS,
	type ReorderPlacement,
	reorderIds,
	reorderShortcutDirection,
	type SpaceVideoOrder,
} from "@/lib/space-video-order";
import { CollectionShareControl } from "../../_components/CollectionShareControl";
import SpaceDialog from "../../_components/Navbar/SpaceDialog";
import { useDashboardContext } from "../../Contexts";
import {
	CapListHeader,
	PageSizeSelect,
} from "../../caps/components/CapListHeader";
import { CapPagination } from "../../caps/components/CapPagination";
import { DragHint } from "../../caps/components/DragHint";
import type { FolderDataType } from "../../caps/components/Folder";
import { FoldersSection } from "../../caps/components/FoldersSection";
import { NewFolderDialog } from "../../caps/components/NewFolderDialog";
import { SelectedCapsBar } from "../../caps/components/SelectedCapsBar";
import { useCapSelection } from "../../caps/components/useCapSelection";
import { useCapsMoved } from "../../caps/components/useCapsMoved";
import { AddVideosDialog } from "./components/AddVideosDialog";
import { AddVideosToOrganizationDialog } from "./components/AddVideosToOrganizationDialog";
import { EmptySharedCapState } from "./components/EmptySharedCapState";
import { MembersIndicator } from "./components/MembersIndicator";
import {
	OrganizationIndicator,
	type OrganizationMemberData,
} from "./components/OrganizationIndicator";
import { SharedCapCard } from "./components/SharedCapCard";
import { SpaceOrderSelect } from "./components/SpaceOrderSelect";
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
	isScreenshot: boolean;
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
	settings?:
		| (Partial<Record<ViewerSettingKey, boolean>> & {
				publicPage?: PublicCollection.PublicPageSettings;
		  })
		| null;
	hasPassword?: boolean;
	public?: boolean;
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
	thumbnails,
	pageSize = DEFAULT_DASHBOARD_PAGE_SIZE,
	videoOrder = "newest",
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
	thumbnails?: SeededThumbnails;
	pageSize?: number;
	videoOrder?: SpaceVideoOrder;
}) => {
	const params = useSearchParams();
	const pathname = usePathname();
	const router = useRouter();
	const page = parsePageParam(params.get("page"));
	const { activeOrganization } = useDashboardContext();
	const [openNewFolderDialog, setOpenNewFolderDialog] = useState(false);
	const totalPages = Math.ceil(count / pageSize);
	const [isAddVideosDialogOpen, setIsAddVideosDialogOpen] = useState(false);
	const [isSpaceSettingsOpen, setIsSpaceSettingsOpen] = useState(false);
	const [
		isAddOrganizationVideosDialogOpen,
		setIsAddOrganizationVideosDialogOpen,
	] = useState(false);

	const currentOrgMember = organizationMembers?.find(
		(member) => member.userId === currentUserId,
	);
	const currentOrganizationRole = getEffectiveOrganizationRole({
		userId: currentUserId,
		ownerId:
			organizationData?.ownerId ?? activeOrganization?.organization.ownerId,
		memberRole: currentOrgMember?.role,
	});
	const currentSpaceMember = spaceMembers?.find(
		(member) => member.userId === currentUserId,
	);
	const currentSpaceRole = getEffectiveSpaceRole({
		userId: currentUserId,
		createdById: spaceData?.createdById,
		memberRole: currentSpaceMember?.role,
	});
	const canManageCurrentSpace = canManageSpace({
		organizationRole: currentOrganizationRole,
		spaceRole: currentSpaceRole,
	});
	const canManageCurrentOrganization = canManageOrganizationMembers(
		currentOrganizationRole,
	);
	const canManageCurrentSharedCollection = spaceData
		? canManageCurrentSpace
		: canManageCurrentOrganization;
	const moveLocation = spaceData
		? ({ type: "space", spaceId } as const)
		: ({ type: "organization" } as const);
	const moveRootLabel =
		spaceData?.name ??
		organizationData?.name ??
		activeOrganization?.organization.name ??
		"All organization";
	const [orderedData, setOrderedData] = useState(data);
	useEffect(() => setOrderedData(data), [data]);
	const pageIds = useMemo(
		() => orderedData.map((video) => video.id),
		[orderedData],
	);
	const selectAllView = useMemo(
		() =>
			spaceData
				? ({ type: "space", spaceId } as const)
				: ({
						type: "organization",
						organizationId: organizationData?.id ?? spaceId,
					} as const),
		[spaceData, spaceId, organizationData?.id],
	);
	const selection = useCapSelection({
		pageIds,
		enabled: canManageCurrentSharedCollection,
		totalCount: count,
		view: selectAllView,
	});
	const selectedCaps = selection.selected;
	const setSelectedCaps = selection.setSelected;
	useCapsMoved((ids) =>
		setSelectedCaps((current) => current.filter((id) => !ids.includes(id))),
	);

	const canReorder =
		Boolean(spaceData) && canManageCurrentSpace && videoOrder === "custom";
	const reduceMotion = useReducedMotion();
	const [dropTarget, setDropTarget] = useState<{
		id: Video.VideoId;
		side: "before" | "after";
	} | null>(null);

	useEffect(() => {
		if (!canReorder) return;
		const clear = () => setDropTarget(null);
		window.addEventListener("dragend", clear);
		window.addEventListener("drop", clear, true);
		return () => {
			window.removeEventListener("dragend", clear);
			window.removeEventListener("drop", clear, true);
		};
	}, [canReorder]);

	const [reorderAnnouncement, setReorderAnnouncement] = useState("");

	const reorderTo = async (
		videoIds: Video.VideoId[],
		placement: ReorderPlacement,
	) => {
		const previous = orderedData;
		if (placement.type !== "start" || page === 1) {
			const byId = new Map(previous.map((video) => [video.id, video]));
			const nextIds = reorderIds(pageIds, videoIds, placement);
			setOrderedData(
				nextIds.flatMap((id) => {
					const video = byId.get(id as Video.VideoId);
					return video ? [video] : [];
				}),
			);
			const [firstId] = videoIds;
			const moved = firstId ? byId.get(firstId) : undefined;
			const index = firstId ? nextIds.indexOf(firstId) : -1;
			if (moved && index >= 0 && videoIds.length === 1) {
				setReorderAnnouncement(
					`Moved ${moved.name} to position ${(page - 1) * pageSize + index + 1}`,
				);
			}
		}
		try {
			await reorderSpaceVideos({ spaceId, videoIds, placement });
		} catch {
			setOrderedData(previous);
			toast.error("Couldn't save the new order. Please try again.");
		}
		router.refresh();
	};

	const handleReorderDragOver = (
		event: DragEvent<HTMLFieldSetElement>,
		id: Video.VideoId,
	) => {
		if (!event.dataTransfer.types.includes(CAP_DRAG_TYPE)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const rect = event.currentTarget.getBoundingClientRect();
		const side =
			event.clientX < rect.left + rect.width / 2 ? "before" : "after";
		setDropTarget((current) =>
			current?.id === id && current.side === side ? current : { id, side },
		);
	};

	const handleReorderKeyDown = (
		event: KeyboardEvent<HTMLFieldSetElement>,
		id: Video.VideoId,
		index: number,
	) => {
		const direction = reorderShortcutDirection(event);
		if (direction === "earlier") {
			if (page === 1 && index === 0) return;
			event.preventDefault();
			void reorderTo([id], { type: "earlier" });
		} else if (direction === "later") {
			if (page >= totalPages && index === orderedData.length - 1) return;
			event.preventDefault();
			void reorderTo([id], { type: "later" });
		}
	};

	const handleReorderDrop = (
		event: DragEvent<HTMLFieldSetElement>,
		id: Video.VideoId,
	) => {
		if (!event.dataTransfer.types.includes(CAP_DRAG_TYPE)) return;
		event.preventDefault();
		event.stopPropagation();
		const side =
			dropTarget?.id === id
				? dropTarget.side
				: event.clientX <
						event.currentTarget.getBoundingClientRect().left +
							event.currentTarget.getBoundingClientRect().width / 2
					? "before"
					: "after";
		setDropTarget(null);
		const payload = parseCapDrag(event.dataTransfer.getData(CAP_DRAG_TYPE));
		if (!payload) return;
		if (payload.ids.length === 0 || payload.ids.includes(id)) return;
		if (payload.ids.length > MAX_REORDER_ITEMS) {
			toast.error(`You can reorder up to ${MAX_REORDER_ITEMS} Caps at once`);
			return;
		}
		void reorderTo(payload.ids, { type: side, targetId: id });
	};

	const spaceMemberCount = spaceMembers?.length || 0;

	const organizationMemberCount = organizationMembers?.length || 0;

	const analyticsQuery = useVideosAnalyticsQuery(pageIds, analyticsEnabled);

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
				public: spaceData.public,
			}}
		/>
	) : null;

	const collectionShareControl = spaceData ? (
		<CollectionShareControl
			kind="space"
			collectionId={spaceData.id}
			isPublic={Boolean(spaceData.public)}
			canManage={canManageCurrentSpace}
			isPro={Boolean(activeOrganization?.ownerIsPro)}
			settings={
				canManageCurrentSpace ? (spaceData.settings?.publicPage ?? null) : null
			}
		/>
	) : null;

	if (count === 0 && folders?.length === 0) {
		return (
			<div className="flex relative flex-col w-full h-full">
				{spaceSettingsDialog}
				{canManageCurrentSharedCollection && (
					<NewFolderDialog
						open={openNewFolderDialog}
						spaceId={spaceId}
						onOpenChange={setOpenNewFolderDialog}
					/>
				)}
				<div className="flex flex-wrap gap-2 items-center">
					{spaceData && spaceMembers && (
						<>
							{canManageCurrentSpace && (
								<Button
									variant="secondary"
									size="sm"
									className="gap-2 px-4 h-9"
									onClick={() => setIsSpaceSettingsOpen(true)}
								>
									<FontAwesomeIcon
										className="size-3 text-gray-10"
										icon={faGear}
									/>
									Space settings
								</Button>
							)}
							{collectionShareControl}
							<MembersIndicator
								memberCount={spaceMemberCount}
								members={spaceMembers}
								organizationMembers={organizationMembers || []}
								spaceId={spaceData.id}
								canManageMembers={canManageCurrentSpace}
								onAddVideos={
									canManageCurrentSpace
										? () => setIsAddVideosDialogOpen(true)
										: undefined
								}
							/>
						</>
					)}
					{organizationData && organizationMembers && !spaceData && (
						<OrganizationIndicator
							memberCount={organizationMemberCount}
							members={organizationMembers}
							organizationName={organizationData.name}
							canManageMembers={canManageCurrentOrganization}
							onAddVideos={
								canManageCurrentOrganization
									? () => setIsAddOrganizationVideosDialogOpen(true)
									: undefined
							}
						/>
					)}
					{canManageCurrentSharedCollection && (
						<Button
							onClick={() => setOpenNewFolderDialog(true)}
							size="sm"
							variant="secondary"
							className="flex gap-2 items-center px-4 h-9 w-fit"
						>
							<FontAwesomeIcon
								className="size-3.5 text-gray-10"
								icon={faFolderPlus}
							/>
							New folder
						</Button>
					)}
				</div>
				<EmptySharedCapState
					organizationName={activeOrganization?.organization.name || ""}
					type={spaceData ? "space" : "organization"}
					spaceData={spaceData}
					currentUserId={currentUserId}
					canAddVideos={canManageCurrentSpace}
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
			<DragHint
				caps={
					canReorder
						? "Drop between Caps to reorder, or on a folder to move"
						: "Drop on a folder to move"
				}
			/>
			{canManageCurrentSharedCollection && (
				<NewFolderDialog
					open={openNewFolderDialog}
					spaceId={spaceId}
					onOpenChange={setOpenNewFolderDialog}
				/>
			)}
			<div className="flex flex-wrap gap-2 items-center mb-10">
				{spaceData && spaceMembers && (
					<>
						{canManageCurrentSpace && (
							<Button
								variant="secondary"
								size="sm"
								className="gap-2 px-4 h-9"
								onClick={() => setIsSpaceSettingsOpen(true)}
							>
								<FontAwesomeIcon
									className="size-3 text-gray-10"
									icon={faGear}
								/>
								Space settings
							</Button>
						)}
						{collectionShareControl}
						<MembersIndicator
							memberCount={spaceMemberCount}
							members={spaceMembers}
							organizationMembers={organizationMembers || []}
							spaceId={spaceData.id}
							canManageMembers={canManageCurrentSpace}
							onAddVideos={
								canManageCurrentSpace
									? () => setIsAddVideosDialogOpen(true)
									: undefined
							}
						/>
					</>
				)}
				{organizationData && organizationMembers && !spaceData && (
					<OrganizationIndicator
						memberCount={organizationMemberCount}
						members={organizationMembers}
						organizationName={organizationData.name}
						canManageMembers={canManageCurrentOrganization}
						onAddVideos={
							canManageCurrentOrganization
								? () => setIsAddOrganizationVideosDialogOpen(true)
								: undefined
						}
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
				{canManageCurrentSharedCollection && (
					<Button
						onClick={() => setOpenNewFolderDialog(true)}
						size="sm"
						variant="secondary"
						className="flex gap-2 items-center px-4 h-9 w-fit"
					>
						<FontAwesomeIcon
							className="size-3.5 text-gray-10"
							icon={faFolderPlus}
						/>
						New folder
					</Button>
				)}
			</div>
			{folders && (
				<FoldersSection
					title="Folders"
					scope={`space:${spaceId}`}
					folders={folders}
					canMove={canManageCurrentSharedCollection}
					moveRootLabel={moveRootLabel}
				/>
			)}

			{orderedData.length > 0 && (
				<>
					<CapListHeader
						title="Videos and screenshots"
						count={count}
						selectionState={
							canManageCurrentSharedCollection ? selection.pageState : undefined
						}
						onToggleSelectAll={selection.togglePage}
						actions={
							<>
								{spaceData && canManageCurrentSpace && (
									<SpaceOrderSelect spaceId={spaceId} order={videoOrder} />
								)}
								<PageSizeSelect pageSize={pageSize} />
							</>
						}
					/>
					<SeededThumbnailsProvider value={thumbnails}>
						<div className="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
							{orderedData.map((cap, index) => {
								const card = (
									<SharedCapCard
										key={cap.id}
										cap={cap}
										hideSharedStatus
										isLoadingAnalytics={analyticsQuery.isLoading}
										analytics={analytics[cap.id] || 0}
										organizationName={
											activeOrganization?.organization.name || ""
										}
										spaceName={spaceData?.name || ""}
										userId={currentUserId}
										canMove={canManageCurrentSharedCollection}
										moveLocation={moveLocation}
										moveRootLabel={moveRootLabel}
										isSelected={
											canManageCurrentSharedCollection &&
											selectedCaps.includes(cap.id)
										}
										anyCapSelected={
											canManageCurrentSharedCollection &&
											selectedCaps.length > 0
										}
										onSelectToggle={
											canManageCurrentSharedCollection
												? (options) => selection.toggle(cap.id, options)
												: undefined
										}
										selectedIds={selectedCaps}
										href={
											spaceData
												? `/s/${cap.id}?space=${encodeURIComponent(spaceId)}`
												: undefined
										}
										reorder={
											canReorder
												? {
														onMoveToStart:
															page === 1 && index === 0
																? undefined
																: () =>
																		void reorderTo([cap.id], { type: "start" }),
														onMoveEarlier:
															page === 1 && index === 0
																? undefined
																: () =>
																		void reorderTo([cap.id], {
																			type: "earlier",
																		}),
														onMoveLater:
															page >= totalPages &&
															index === orderedData.length - 1
																? undefined
																: () =>
																		void reorderTo([cap.id], { type: "later" }),
													}
												: undefined
										}
									/>
								);
								if (!canReorder) return card;
								const indicator =
									dropTarget?.id === cap.id ? dropTarget.side : null;
								return (
									<motion.fieldset
										key={cap.id}
										layout={reduceMotion ? false : "position"}
										layoutDependency={orderedData}
										transition={{ type: "spring", stiffness: 520, damping: 42 }}
										className="relative min-w-0"
										onDragOver={(event) => handleReorderDragOver(event, cap.id)}
										onDrop={(event) => handleReorderDrop(event, cap.id)}
										onKeyDown={(event) =>
											handleReorderKeyDown(event, cap.id, index)
										}
									>
										{card}
										<span
											aria-hidden
											className={clsx(
												"absolute -inset-y-1 w-[3px] rounded-full bg-blue-9 transition-opacity duration-150 pointer-events-none",
												indicator === "before" ? "-left-3" : "-right-3",
												indicator ? "opacity-100" : "opacity-0",
											)}
										/>
									</motion.fieldset>
								);
							})}
						</div>
					</SeededThumbnailsProvider>
					{canReorder && (
						<p aria-live="polite" className="sr-only">
							{reorderAnnouncement}
						</p>
					)}
				</>
			)}
			{(data.length >= pageSize || page !== 1) && (
				<div className="mt-4">
					<CapPagination
						currentPage={page}
						totalPages={totalPages}
						hrefForPage={(targetPage) =>
							targetPage <= 1 ? pathname : `${pathname}?page=${targetPage}`
						}
					/>
				</div>
			)}
			{canManageCurrentSharedCollection && (
				<SelectedCapsBar
					selectedCaps={selectedCaps}
					setSelectedCaps={setSelectedCaps}
					moveLocation={moveLocation}
					moveRootLabel={moveRootLabel}
					selection={selection}
				/>
			)}
		</div>
	);
};
