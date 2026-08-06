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
import type { Folder as FolderDomain, Video } from "@cap/web-domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Folder, FolderInput, FolderRoot, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	getMoveFolderDestinations,
	moveFolder,
	moveVideos,
} from "@/actions/folders/move-items";
import {
	buildMoveFolderDestinationRows,
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
	item: MoveItem;
	onMoved?: () => void;
}

export function MoveItemsDialog({
	open,
	onOpenChange,
	location,
	rootLabel,
	item,
	onMoved,
}: MoveItemsDialogProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const currentDestinationId =
		item.type === "videos" ? item.currentFolderId : item.currentParentId;
	const [selectedFolderId, setSelectedFolderId] =
		useState<FolderDomain.FolderId | null>(currentDestinationId);
	const [search, setSearch] = useState("");

	useEffect(() => {
		if (!open) return;
		setSelectedFolderId(currentDestinationId);
		setSearch("");
	}, [currentDestinationId, open]);

	const destinations = useQuery({
		queryKey: ["move-folder-destinations", moveLocationKey(location)],
		queryFn: () => getMoveFolderDestinations(location),
		enabled: open,
		staleTime: 30_000,
	});

	const rows = useMemo(
		() =>
			buildMoveFolderDestinationRows(
				destinations.data ?? [],
				item.type === "folder" ? item.folderId : undefined,
			),
		[destinations.data, item],
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
				await moveVideos({
					videoIds: item.videoIds,
					folderId: selectedFolderId,
					location,
				});
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
					: `${count} Cap${count === 1 ? "" : "s"} moved`,
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
	const destinationChanged = selectedFolderId !== currentDestinationId;

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
									disabled={currentDestinationId === null}
									onClick={() => setSelectedFolderId(null)}
									className={clsx(
										"flex gap-3 items-center px-3 w-full h-11 text-left transition-colors",
										currentDestinationId === null
											? "cursor-not-allowed opacity-50"
											: "hover:bg-gray-3",
										selectedFolderId === null &&
											currentDestinationId !== null &&
											"bg-blue-3",
									)}
								>
									<FolderRoot className="shrink-0 size-4 text-gray-10" />
									<span className="flex-1 min-w-0 text-sm truncate text-gray-12">
										{rootLabel}
									</span>
									{selectedFolderId === null &&
										currentDestinationId !== null && (
											<Check className="shrink-0 size-4 text-blue-10" />
										)}
								</button>

								{filteredRows.map((row) => {
									const isCurrent = row.id === currentDestinationId;
									const isDisabled = row.disabled || isCurrent;
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
							destinations.isLoading ||
							destinations.isError ||
							moveMutation.isPending
						}
						onClick={() => moveMutation.mutate()}
					>
						{moveMutation.isPending ? "Moving..." : "Move"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
