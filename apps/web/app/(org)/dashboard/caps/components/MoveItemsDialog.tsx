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
import {
	Building2,
	Check,
	Folder,
	FolderInput,
	FolderPlus,
	FolderRoot,
	Layers,
	Search,
	UserRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	getMoveFolderDestinations,
	getOwnedVideoMoveDestinations,
	moveFolder,
	moveVideos,
	placeOwnedVideos,
} from "@/actions/folders/move-items";
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

const LOCATION_ICONS = {
	personal: UserRound,
	organization: Building2,
	space: Layers,
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
	const [newFolderName, setNewFolderName] = useState<string | null>(null);
	const browsedOrganizationId =
		organizationId ?? activeOrganization?.organization.id;

	useEffect(() => {
		if (!open) return;
		setSelectedFolderId(currentDestinationId);
		setSelectedLocationKey(sourceLocationKey);
		setSearch("");
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
			<DialogContent className="flex flex-col p-0 w-[calc(100%-20px)] max-w-lg max-h-[min(640px,calc(100vh-40px))] rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FolderInput className="size-4" />}
					description={
						ownedVideos
							? "Pick a folder, or add it to a space your team can see."
							: `Pick a folder in ${rootLabel}.`
					}
				>
					<DialogTitle className="text-lg text-gray-12">{title}</DialogTitle>
				</DialogHeader>

				<div className="flex overflow-hidden flex-col flex-1 gap-3 p-5 min-h-0">
					{ownedVideos && destinations.data && (
						<fieldset className="flex flex-col gap-2 min-w-0 shrink-0">
							<legend className="mb-2 text-sm font-medium text-gray-12">
								Where to
							</legend>
							<div className="flex overflow-y-auto flex-wrap gap-1.5 max-h-[84px] custom-scroll">
								{destinations.data.map((group) => {
									const key = moveLocationKey(group.location);
									const Icon = LOCATION_ICONS[group.location.type];
									const active = key === selectedLocationKey;
									return (
										<button
											type="button"
											key={key}
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
												"flex gap-1.5 items-center px-3 max-w-full h-9 text-sm rounded-full border transition-colors",
												active
													? "font-medium border-gray-12 bg-gray-12 text-gray-1"
													: "border-gray-4 bg-gray-1 text-gray-12 hover:border-gray-6 hover:bg-gray-3",
											)}
										>
											<Icon className="shrink-0 size-3.5" />
											<span className="truncate">{group.name}</span>
										</button>
									);
								})}
							</div>
						</fieldset>
					)}
					{sharing && (
						<p className="text-[13px] leading-5 text-gray-11 text-pretty shrink-0">
							People in {selectedGroup?.name} will be able to watch{" "}
							{plural ? "them" : "it"}.{" "}
							{plural ? "They also stay" : "It also stays"} in My Caps, and
							existing sharing is kept.
						</p>
					)}

					<div className="flex overflow-hidden flex-col flex-1 min-h-56 rounded-lg border bg-gray-1 border-gray-4">
						{rows.length > SEARCH_THRESHOLD && (
							<div className="relative border-b shrink-0 border-gray-4">
								<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 pointer-events-none text-gray-9" />
								<Input
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									placeholder="Search folders"
									aria-label="Search folders"
									className="pl-9 bg-transparent rounded-none border-0 ring-0 focus:ring-0 focus:border-0"
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
											onClick={() => setSelectedFolderId(null)}
											className={clsx(
												"flex gap-3 items-center px-3 w-full h-11 text-left transition-colors",
												rootSelectable
													? "hover:bg-gray-3"
													: "cursor-not-allowed opacity-50",
												rootSelected && "bg-blue-3",
											)}
										>
											<FolderRoot className="shrink-0 size-4 text-gray-10" />
											<span className="flex-1 min-w-0 text-sm truncate text-gray-12">
												{selectedGroup?.name ?? rootLabel}
											</span>
											{rootSelected ? (
												<Check className="shrink-0 size-4 text-blue-10" />
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
												disabled={isDisabled}
												onClick={() => setSelectedFolderId(row.id)}
												className={clsx(
													"flex gap-3 items-center pr-3 w-full h-11 text-left transition-colors",
													isDisabled
														? "cursor-not-allowed opacity-50"
														: "hover:bg-gray-3",
													isSelected && "bg-blue-3",
												)}
												style={{
													paddingLeft: `${12 + Math.min(row.depth, 8) * 16}px`,
												}}
											>
												<Folder className="shrink-0 size-4 text-gray-10" />
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
													<Check className="shrink-0 size-4 text-blue-10" />
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

				<DialogFooter>
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
						className="max-w-[60%]"
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
