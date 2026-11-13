"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	LoadingSpinner,
} from "@cap/ui";
import type {
	Folder as FolderDomain,
	Organisation,
	Video,
} from "@cap/web-domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Option } from "effect";
import { Folder, FolderPlus, FolderRoot, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	getMoveFolderDestinations,
	getOwnedVideoMoveDestinations,
	moveFolder,
	moveVideos,
	placeOwnedVideos,
} from "@/actions/folders/move-items";
import {
	CheckDoodle,
	EyeDoodle,
	FOLDER_TINTS,
	FolderDoodle,
	libraryDoodleHost,
	MoveDoodle,
	PersonDoodle,
	SpaceDoodle,
	TeamDoodle,
} from "@/app/(org)/dashboard/_components/library-doodles";
import { useDashboardContext } from "@/app/(org)/dashboard/DashboardContext";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import {
	buildMoveFolderDestinationRows,
	type MoveDestinationGroup,
	type MoveLocation,
	moveLocationFolderSpaceId,
	moveLocationKey,
} from "@/lib/move-items";

type MoveItem =
	| {
			type: "videos";
			videoIds: Video.VideoId[];
			currentFolderId: FolderDomain.FolderId | null;
	  }
	| {
			type: "folder";
			folderId: FolderDomain.FolderId;
			currentParentId: FolderDomain.FolderId | null;
	  };

interface MoveItemsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	location: MoveLocation;
	rootLabel: string;
	organizationId?: Organisation.OrganisationId;
	item: MoveItem;
	onMoved?: () => void;
}

const SEARCH_THRESHOLD = 6;
const LOCATION_SEARCH_THRESHOLD = 6;

const LOCATIONS = {
	personal: { Doodle: PersonDoodle, hint: "Only you" },
	organization: { Doodle: TeamDoodle, hint: "Everyone on the team" },
	space: { Doodle: SpaceDoodle, hint: "Space members" },
} as const;

export function MoveItemsDialog({
	open,
	onOpenChange,
	location,
	rootLabel,
	organizationId,
	item,
	onMoved,
}: MoveItemsDialogProps) {
	const router = useRouter();
	const user = useCurrentUser();
	const { activeOrganization } = useDashboardContext();
	const queryClient = useQueryClient();
	const rpc = useRpcClient();
	const currentDestinationId =
		item.type === "videos" ? item.currentFolderId : item.currentParentId;
	const [selectedFolderId, setSelectedFolderId] =
		useState<FolderDomain.FolderId | null>(currentDestinationId);
	const sourceLocationKey = moveLocationKey(location);
	const [selectedLocationKey, setSelectedLocationKey] =
		useState(sourceLocationKey);
	const ownedVideos = item.type === "videos" && location.type === "personal";
	const [search, setSearch] = useState("");
	const [locationSearch, setLocationSearch] = useState("");
	const contentRef = useRef<HTMLDivElement>(null);
	const [newFolderName, setNewFolderName] = useState<string | null>(null);
	const browsedOrganizationId =
		organizationId ?? activeOrganization?.organization.id;

	useEffect(() => {
		if (!open) return;
		setSelectedFolderId(currentDestinationId);
		setSelectedLocationKey(sourceLocationKey);
		setSearch("");
		setLocationSearch("");
		setNewFolderName(null);
	}, [currentDestinationId, open, sourceLocationKey]);

	const destinations = useQuery({
		queryKey: [
			"move-folder-destinations",
			sourceLocationKey,
			user?.id,
			organizationId ?? activeOrganization?.organization.id,
			ownedVideos,
		],
		queryFn: async (): Promise<MoveDestinationGroup[]> =>
			ownedVideos
				? getOwnedVideoMoveDestinations(organizationId)
				: [
						{
							location,
							name: rootLabel,
							folders: await getMoveFolderDestinations(location),
							canCreateFolder: true,
						},
					],
		enabled: open,
		// Folders are created, renamed and deleted elsewhere on the page
		// without touching this cache, so every open fetches them again.
		staleTime: 0,
	});

	const selectedGroup = destinations.data?.find(
		(group) => moveLocationKey(group.location) === selectedLocationKey,
	);
	const sameLocation = selectedLocationKey === sourceLocationKey;
	const manyLocations =
		(destinations.data?.length ?? 0) > LOCATION_SEARCH_THRESHOLD;
	const normalizedLocationSearch = locationSearch.trim().toLocaleLowerCase();
	const visibleGroups =
		destinations.data?.filter(
			(group) =>
				!normalizedLocationSearch ||
				group.name.toLocaleLowerCase().includes(normalizedLocationSearch),
		) ?? [];
	const rows = useMemo(
		() =>
			buildMoveFolderDestinationRows(
				selectedGroup?.folders ?? [],
				item.type === "folder" ? item.folderId : undefined,
			),
		[selectedGroup, item],
	);
	const normalizedSearch = search.trim().toLocaleLowerCase();
	const filteredRows = useMemo(
		() =>
			normalizedSearch
				? rows.filter((row) =>
						row.path.toLocaleLowerCase().includes(normalizedSearch),
					)
				: rows,
		[normalizedSearch, rows],
	);

	const moveMutation = useMutation({
		mutationFn: async () => {
			if (item.type === "videos") {
				if (!selectedGroup) throw new Error("Select a destination");
				const placement = {
					videoIds: item.videoIds,
					folderId: selectedFolderId,
					location: selectedGroup.location,
				};
				await (ownedVideos
					? placeOwnedVideos({ ...placement, organizationId })
					: moveVideos(placement));
				return;
			}

			await moveFolder({
				folderId: item.folderId,
				parentId: selectedFolderId,
				location,
			});
		},
		onSuccess: () => {
			const count = item.type === "videos" ? item.videoIds.length : 1;
			toast.success(
				item.type === "folder"
					? "Folder moved"
					: `${count} Cap${count === 1 ? "" : "s"} ${sameLocation ? "moved" : `added to ${selectedGroup?.name}`}`,
			);
			onMoved?.();
			if (item.type === "folder") {
				queryClient.invalidateQueries({
					queryKey: ["move-folder-destinations", moveLocationKey(location)],
				});
			}
			onOpenChange(false);
			router.refresh();
		},
		onError: (error) => {
			toast.error(error instanceof Error ? error.message : "Move failed");
		},
	});

	const selectedRow = rows.find((row) => row.id === selectedFolderId);
	const newFolderParent =
		selectedRow && !selectedRow.disabled ? selectedRow : null;
	const canCreateFolder =
		Boolean(selectedGroup?.canCreateFolder) && Boolean(browsedOrganizationId);

	const createFolder = useEffectMutation({
		mutationFn: (variables: {
			name: string;
			group: MoveDestinationGroup;
			parentId: FolderDomain.FolderId | null;
			organizationId: Organisation.OrganisationId;
		}) =>
			rpc.FolderCreate({
				name: variables.name,
				color: "normal",
				public: false,
				spaceId: Option.fromNullable(
					moveLocationFolderSpaceId(
						variables.group.location,
						variables.organizationId,
					),
				),
				parentId: Option.fromNullable(variables.parentId),
			}),
		onSuccess: async (_result, variables) => {
			const known = new Set(variables.group.folders.map((folder) => folder.id));
			const groupKey = moveLocationKey(variables.group.location);
			const refreshed = await destinations.refetch();
			const created = refreshed.data
				?.find((group) => moveLocationKey(group.location) === groupKey)
				?.folders.find(
					(folder) =>
						!known.has(folder.id) &&
						folder.name === variables.name &&
						folder.parentId === variables.parentId,
				);
			if (created) setSelectedFolderId(created.id);
			setNewFolderName(null);
			setSearch("");
			router.refresh();
		},
		onError: () => {
			toast.error("Failed to create folder");
		},
	});

	const submitNewFolder = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const name = newFolderName?.trim();
		if (
			!name ||
			!selectedGroup ||
			!browsedOrganizationId ||
			createFolder.isPending
		)
			return;
		createFolder.mutate({
			name,
			group: selectedGroup,
			parentId: newFolderParent?.id ?? null,
			organizationId: browsedOrganizationId,
		});
	};

	const itemCount = item.type === "videos" ? item.videoIds.length : 1;
	const plural = itemCount !== 1;
	const title =
		item.type === "folder"
			? "Move folder"
			: `Move ${itemCount} Cap${plural ? "s" : ""}`;
	const destinationChanged =
		!sameLocation || selectedFolderId !== currentDestinationId;
	const sharing = !sameLocation && selectedGroup?.location.type !== "personal";
	const busy = moveMutation.isPending || createFolder.isPending;
	const rootSelectable = !sameLocation || currentDestinationId !== null;
	const rootSelected = selectedFolderId === null && rootSelectable;

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!busy) onOpenChange(nextOpen);
			}}
		>
			<DialogContent
				ref={contentRef}
				onOpenAutoFocus={(event) => {
					// The first field is a search box; focusing it would open the
					// on-screen keyboard on phones every time the dialog opens.
					event.preventDefault();
					contentRef.current?.focus();
				}}
				className="flex flex-col p-0 w-[calc(100%-20px)] max-w-lg max-h-[min(640px,calc(100vh-40px))] rounded-xl border bg-gray-2 border-gray-4"
			>
				<DialogHeader
					className={clsx(libraryDoodleHost, "shrink-0")}
					icon={<MoveDoodle size={24} />}
					description={
						ownedVideos
							? "Pick a folder, or add it to a space your team can see."
							: `Pick a folder in ${rootLabel}.`
					}
				>
					<DialogTitle className="text-lg leading-7 text-gray-12">
						{title}
					</DialogTitle>
				</DialogHeader>

				<div className="flex overflow-y-auto flex-col flex-1 gap-3 p-5 min-h-0 custom-scroll">
					{ownedVideos && destinations.data && (
						<fieldset className="flex flex-col min-w-0 shrink-0">
							<legend className="mb-2 text-sm font-medium text-gray-12">
								Where to
							</legend>
							{manyLocations && (
								<div className="relative mb-2">
									<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 pointer-events-none text-gray-9" />
									<Input
										value={locationSearch}
										onChange={(event) => setLocationSearch(event.target.value)}
										placeholder={`Search ${destinations.data.length} places`}
										aria-label="Search places"
										className="pl-9 h-9"
									/>
								</div>
							)}
							<div
								className={clsx(
									"grid overflow-y-auto grid-cols-2 gap-2 p-0.5 sm:grid-cols-3 custom-scroll",
									manyLocations
										? "max-h-[176px] [mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)] pb-4"
										: "max-h-[236px]",
								)}
							>
								{visibleGroups.length === 0 && (
									<p className="col-span-full py-4 text-sm text-center text-gray-10">
										Nothing matches "{locationSearch.trim()}"
									</p>
								)}
								{visibleGroups.map((group) => {
									const key = moveLocationKey(group.location);
									const { Doodle, hint } = LOCATIONS[group.location.type];
									const active = key === selectedLocationKey;
									return (
										<button
											type="button"
											key={key}
											title={group.name}
											aria-pressed={active}
											disabled={busy}
											onClick={() => {
												if (active) return;
												setSelectedLocationKey(key);
												setSelectedFolderId(
													key === sourceLocationKey
														? currentDestinationId
														: null,
												);
												setSearch("");
												setNewFolderName(null);
											}}
											className={clsx(
												libraryDoodleHost,
												"flex relative flex-col gap-2 items-start p-3 min-w-0 text-left rounded-xl border transition-[border-color,background-color,box-shadow] duration-200",
												active
													? "shadow-sm border-gray-12 bg-gray-1"
													: "border-gray-4 bg-gray-1/60 hover:border-gray-6 hover:bg-gray-1",
											)}
										>
											<span className="flex justify-center items-center rounded-lg size-9 bg-gray-3">
												<Doodle size={24} />
											</span>
											<span className="flex flex-col min-w-0 max-w-full">
												<span className="text-sm font-medium truncate text-gray-12">
													{group.name}
												</span>
												<span className="text-xs truncate text-gray-10">
													{hint}
												</span>
											</span>
											{active && (
												<span className="absolute top-2.5 right-2.5">
													<CheckDoodle size={16} />
												</span>
											)}
										</button>
									);
								})}
							</div>
						</fieldset>
					)}
					{sharing && (
						<div
							className={clsx(
								libraryDoodleHost,
								"flex gap-3 items-center p-3 rounded-xl border shrink-0 border-gray-4 bg-gray-1",
							)}
						>
							<EyeDoodle size={22} />
							<p className="text-[13px] leading-5 text-gray-11 text-pretty">
								People in {selectedGroup?.name} will be able to watch{" "}
								{plural ? "them" : "it"}.{" "}
								{plural ? "They also stay" : "It also stays"} in My Caps, and
								existing sharing is kept.
							</p>
						</div>
					)}

					<div className="flex overflow-hidden flex-col flex-1 min-h-52 rounded-lg border transition-colors shrink-0 bg-gray-1 border-gray-4 focus-within:border-gray-7 sm:shrink">
						{rows.length > SEARCH_THRESHOLD && (
							<div className="relative border-b shrink-0 border-gray-4">
								<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 pointer-events-none text-gray-9" />
								<Input
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									placeholder="Search folders"
									aria-label="Search folders"
									className="pl-9 bg-transparent rounded-none border-0 ring-0 hover:bg-transparent focus:bg-transparent focus:ring-0 focus:ring-offset-0 focus:border-0 focus:outline-none"
								/>
							</div>
						)}
						<div className="overflow-y-auto flex-1 custom-scroll">
							{destinations.isLoading ? (
								<div className="flex justify-center items-center h-56">
									<LoadingSpinner size={28} />
								</div>
							) : destinations.isError ? (
								<div className="flex flex-col gap-3 justify-center items-center px-6 h-56 text-center">
									<p className="text-sm text-gray-11">
										Unable to load folders.
									</p>
									<Button
										variant="gray"
										size="sm"
										onClick={() => destinations.refetch()}
									>
										Retry
									</Button>
								</div>
							) : (
								<div className="py-1">
									{!normalizedSearch && (
										<button
											type="button"
											disabled={busy || !rootSelectable}
											title={selectedGroup?.name ?? rootLabel}
											onClick={() => setSelectedFolderId(null)}
											className={clsx(
												"flex gap-3 items-center px-3 w-full h-11 text-left transition-colors",
												rootSelectable
													? "hover:bg-gray-3"
													: "cursor-not-allowed opacity-50",
												rootSelected && "bg-gray-3",
											)}
										>
											<FolderRoot className="shrink-0 size-4 text-gray-10" />
											<span className="flex-1 min-w-0 text-sm truncate text-gray-12">
												{selectedGroup?.name ?? rootLabel}
											</span>
											{rootSelected ? (
												<CheckDoodle key="root" />
											) : (
												<span className="text-xs shrink-0 text-gray-9">
													{rootSelectable ? "No folder" : "Current"}
												</span>
											)}
										</button>
									)}

									{filteredRows.map((row) => {
										const isCurrent =
											sameLocation && row.id === currentDestinationId;
										const isDisabled = busy || row.disabled || isCurrent;
										const isSelected =
											row.id === selectedFolderId && !isCurrent;

										return (
											<button
												type="button"
												key={row.id}
												title={row.path}
												disabled={isDisabled}
												onClick={() => setSelectedFolderId(row.id)}
												className={clsx(
													"flex gap-3 items-center pr-3 w-full h-11 text-left transition-colors",
													isDisabled
														? "cursor-not-allowed opacity-50"
														: "hover:bg-gray-3",
													isSelected && "bg-gray-3",
												)}
												style={{
													paddingLeft: `${12 + Math.min(row.depth, 8) * 16}px`,
												}}
											>
												<Folder
													className="shrink-0 size-4 text-gray-10"
													fill={FOLDER_TINTS[row.color ?? "normal"]}
												/>
												<span className="flex-1 min-w-0">
													<span className="block text-sm truncate text-gray-12">
														{row.name}
													</span>
													{normalizedSearch && row.path !== row.name && (
														<span className="block text-xs truncate text-gray-9">
															{row.path}
														</span>
													)}
												</span>
												{isSelected ? (
													<CheckDoodle key={row.id} />
												) : (
													isCurrent && (
														<span className="text-xs shrink-0 text-gray-9">
															Current
														</span>
													)
												)}
											</button>
										);
									})}

									{rows.length === 0 && !normalizedSearch && (
										<div
											className={clsx(
												libraryDoodleHost,
												"flex flex-col gap-2 items-center px-6 pt-6 pb-3 text-center",
											)}
										>
											<FolderDoodle size={40} />
											<p className="text-sm text-gray-10">
												No folders in {selectedGroup?.name ?? rootLabel} yet.
											</p>
										</div>
									)}

									{filteredRows.length === 0 && normalizedSearch && (
										<div className="flex justify-center items-center px-5 h-24 text-sm text-gray-10">
											No folders found
										</div>
									)}

									{canCreateFolder &&
										!normalizedSearch &&
										(newFolderName === null ? (
											<button
												type="button"
												disabled={busy}
												onClick={() => setNewFolderName("")}
												className="flex gap-3 items-center px-3 w-full h-11 text-sm text-left transition-colors text-gray-11 hover:bg-gray-3 hover:text-gray-12"
											>
												<FolderPlus className="shrink-0 size-4 text-gray-10" />
												New folder
											</button>
										) : (
											<form
												onSubmit={submitNewFolder}
												className="flex gap-2 items-center px-3 py-1.5"
											>
												<FolderPlus className="shrink-0 size-4 text-gray-10" />
												<Input
													autoFocus
													value={newFolderName}
													disabled={createFolder.isPending}
													maxLength={255}
													onChange={(event) =>
														setNewFolderName(event.target.value)
													}
													onKeyDown={(event) => {
														if (event.key !== "Escape") return;
														event.preventDefault();
														event.stopPropagation();
														setNewFolderName(null);
													}}
													placeholder={
														newFolderParent
															? `New folder in ${newFolderParent.name}`
															: "Folder name"
													}
													aria-label="New folder name"
													className="flex-1 min-w-0 h-9"
												/>
												<Button
													type="submit"
													variant="dark"
													size="sm"
													spinner={createFolder.isPending}
													disabled={
														!newFolderName.trim() || createFolder.isPending
													}
												>
													Create
												</Button>
											</form>
										))}
								</div>
							)}
						</div>
					</div>
				</div>

				<DialogFooter className="shrink-0">
					<Button
						variant="gray"
						size="sm"
						disabled={busy}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						variant="dark"
						size="sm"
						spinner={moveMutation.isPending}
						title={sharing ? `Add to ${selectedGroup?.name}` : undefined}
						className="w-full min-w-0 sm:w-auto sm:max-w-[60%]"
						disabled={
							!destinationChanged ||
							!selectedGroup ||
							destinations.isLoading ||
							destinations.isError ||
							busy
						}
						onClick={() => moveMutation.mutate()}
					>
						<span className="truncate">
							{moveMutation.isPending
								? "Saving..."
								: sharing
									? `Add to ${selectedGroup?.name}`
									: "Move"}
						</span>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
