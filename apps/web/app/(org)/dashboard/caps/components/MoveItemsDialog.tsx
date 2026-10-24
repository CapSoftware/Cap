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
import { Check, Folder, FolderInput, FolderRoot, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
import {
	buildMoveFolderDestinationRows,
	type MoveDestinationGroup,
	type MoveLocation,
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
	const currentDestinationId =
		item.type === "videos" ? item.currentFolderId : item.currentParentId;
	const [selectedFolderId, setSelectedFolderId] =
		useState<FolderDomain.FolderId | null>(currentDestinationId);
	const sourceLocationKey = moveLocationKey(location);
	const [selectedLocationKey, setSelectedLocationKey] =
		useState(sourceLocationKey);
	const ownedVideos = item.type === "videos" && location.type === "personal";
	const [search, setSearch] = useState("");

	useEffect(() => {
		if (!open) return;
		setSelectedFolderId(currentDestinationId);
		setSelectedLocationKey(sourceLocationKey);
		setSearch("");
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
						},
					],
		enabled: open,
		staleTime: 30_000,
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

	const itemCount = item.type === "videos" ? item.videoIds.length : 1;
	const title =
		item.type === "folder"
			? "Move folder"
			: `Move ${itemCount} Cap${itemCount === 1 ? "" : "s"}`;
	const destinationChanged =
		!sameLocation || selectedFolderId !== currentDestinationId;
	const sharing = !sameLocation && selectedGroup?.location.type !== "personal";

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!moveMutation.isPending) onOpenChange(nextOpen);
			}}
		>
			<DialogContent className="flex flex-col p-0 w-[calc(100%-20px)] max-w-lg max-h-[min(620px,calc(100vh-40px))] rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader icon={<FolderInput className="size-4" />}>
					<DialogTitle className="text-lg text-gray-12">{title}</DialogTitle>
				</DialogHeader>

				<div className="flex overflow-hidden flex-col flex-1 gap-3 p-5 min-h-0">
					{ownedVideos && destinations.data && (
						<label className="flex flex-col gap-2 text-sm text-gray-12">
							Location
							<select
								value={selectedLocationKey}
								disabled={moveMutation.isPending}
								onChange={(event) => {
									const key = event.target.value;
									setSelectedLocationKey(key);
									setSelectedFolderId(
										key === sourceLocationKey ? currentDestinationId : null,
									);
									setSearch("");
								}}
								className="h-10 rounded-lg border border-gray-4 bg-gray-1 px-3"
							>
								{destinations.data.map((group) => (
									<option
										key={moveLocationKey(group.location)}
										value={moveLocationKey(group.location)}
									>
										{group.name}
									</option>
								))}
							</select>
						</label>
					)}
					{sharing && (
						<p className="text-sm text-gray-11">
							People with access to {selectedGroup?.name} will be able to view
							these Caps. Existing sharing and their location in My Caps will be
							kept.
						</p>
					)}
					<div className="relative shrink-0">
						<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 pointer-events-none text-gray-9" />
						<Input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search folders"
							className="pl-9"
						/>
					</div>

					<div className="overflow-y-auto flex-1 min-h-64 rounded-lg border bg-gray-1 border-gray-4 custom-scroll">
						{destinations.isLoading ? (
							<div className="flex justify-center items-center h-64">
								<LoadingSpinner size={28} />
							</div>
						) : destinations.isError ? (
							<div className="flex flex-col gap-3 justify-center items-center px-6 h-64 text-center">
								<p className="text-sm text-gray-11">Unable to load folders.</p>
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
								<button
									type="button"
									disabled={
										moveMutation.isPending ||
										(sameLocation && currentDestinationId === null)
									}
									onClick={() => setSelectedFolderId(null)}
									className={clsx(
										"flex gap-3 items-center px-3 w-full h-11 text-left transition-colors",
										sameLocation && currentDestinationId === null
											? "cursor-not-allowed opacity-50"
											: "hover:bg-gray-3",
										selectedFolderId === null &&
											(!sameLocation || currentDestinationId !== null) &&
											"bg-blue-3",
									)}
								>
									<FolderRoot className="shrink-0 size-4 text-gray-10" />
									<span className="flex-1 min-w-0 text-sm truncate text-gray-12">
										{selectedGroup?.name ?? rootLabel}
									</span>
									{selectedFolderId === null &&
										(!sameLocation || currentDestinationId !== null) && (
											<Check className="shrink-0 size-4 text-blue-10" />
										)}
								</button>

								{filteredRows.map((row) => {
									const isCurrent =
										sameLocation && row.id === currentDestinationId;
									const isDisabled =
										moveMutation.isPending || row.disabled || isCurrent;
									const isSelected = row.id === selectedFolderId && !isCurrent;

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
											{isSelected && (
												<Check className="shrink-0 size-4 text-blue-10" />
											)}
										</button>
									);
								})}

								{filteredRows.length === 0 && normalizedSearch && (
									<div className="flex justify-center items-center px-5 h-24 text-sm text-gray-10">
										No folders found
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="gray"
						size="sm"
						disabled={moveMutation.isPending}
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						variant="dark"
						size="sm"
						spinner={moveMutation.isPending}
						disabled={
							!destinationChanged ||
							!selectedGroup ||
							destinations.isLoading ||
							destinations.isError ||
							moveMutation.isPending
						}
						onClick={() => moveMutation.mutate()}
					>
						{moveMutation.isPending
							? "Saving..."
							: sharing
								? "Share & move"
								: "Move"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
