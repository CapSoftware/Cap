"use client";

import { Button } from "@cap/ui";
import type { Folder, Video } from "@cap/web-domain";
import { faBoxArchive } from "@fortawesome/free-solid-svg-icons/faBoxArchive";
import { faBoxOpen } from "@fortawesome/free-solid-svg-icons/faBoxOpen";
import { faFilm } from "@fortawesome/free-solid-svg-icons/faFilm";
import { faTrash } from "@fortawesome/free-solid-svg-icons/faTrash";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion } from "framer-motion";
import { FolderInput } from "lucide-react";
import { useState } from "react";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { FontAwesomeIcon } from "@/components/FontAwesomeIcon";
import type { MoveLocation } from "@/lib/move-items";
import { MoveItemsDialog } from "./MoveItemsDialog";
import type { CapSelection } from "./useCapSelection";

interface SelectedCapsBarProps {
	selectedCaps: Video.VideoId[];
	setSelectedCaps: (caps: Video.VideoId[]) => void;
	deleteSelectedCaps?: () => void;
	isDeleting?: boolean;
	moveLocation?: MoveLocation;
	moveRootLabel?: string;
	currentFolderId?: Folder.FolderId | null;
	selection?: Pick<
		CapSelection,
		| "canSelectAllMatching"
		| "isAllMatching"
		| "matchingTruncated"
		| "selectAllLimit"
		| "isSelectingAll"
		| "selectAllMatching"
		| "totalCount"
	>;
	archive?: {
		mode: "archive" | "unarchive";
		onArchive: () => void;
		isPending?: boolean;
	};
}

export const SelectedCapsBar = ({
	selectedCaps,
	setSelectedCaps,
	deleteSelectedCaps,
	isDeleting = false,
	moveLocation,
	moveRootLabel,
	currentFolderId = null,
	selection,
	archive,
}: SelectedCapsBarProps) => {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [moveOpen, setMoveOpen] = useState(false);

	const handleConfirmDelete = () => {
		deleteSelectedCaps?.();
		setConfirmOpen(false);
	};

	return (
		<AnimatePresence>
			{selectedCaps.length > 0 && (
				<>
					<motion.div
						className="flex fixed inset-x-3 bottom-24 z-50 gap-3 justify-between items-center p-3 mx-auto max-w-2xl rounded-xl border shadow-lg sm:inset-x-0 sm:bottom-12 border-gray-2 bg-gray-1"
						initial={{ opacity: 0, y: 10, scale: 0.9 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{
							opacity: 0,
							y: 10,
							scale: 0.9,
							transition: { duration: 0.2 },
						}}
						transition={{
							opacity: { duration: 0.2, ease: "easeOut" },
							y: { type: "spring", damping: 15, stiffness: 300 },
							scale: { type: "spring", damping: 15, stiffness: 300 },
						}}
					>
						<div className="flex flex-col min-w-0">
							<output
								aria-live="polite"
								className="flex gap-1 text-sm font-medium whitespace-nowrap text-gray-10"
							>
								<NumberFlow
									value={selectedCaps.length}
									className="tabular-nums text-md text-gray-12"
								/>
								<span className="hidden sm:inline">
									cap{selectedCaps.length !== 1 ? "s" : ""}
								</span>
								selected
							</output>
							{selection?.canSelectAllMatching && !selection.isAllMatching ? (
								<button
									type="button"
									onClick={() => void selection.selectAllMatching()}
									disabled={selection.isSelectingAll}
									className="self-start text-xs font-medium text-blue-11 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 disabled:opacity-60"
								>
									{selection.isSelectingAll
										? "Selecting..."
										: (selection.totalCount ?? 0) > selection.selectAllLimit
											? `Select the first ${selection.selectAllLimit.toLocaleString("en-US")}`
											: `Select all ${selection.totalCount?.toLocaleString("en-US")}`}
								</button>
							) : selection?.isAllMatching ? (
								<p className="text-xs text-gray-10">
									{selection.matchingTruncated
										? `The first ${selection.selectAllLimit.toLocaleString("en-US")} are selected`
										: "Every Cap here is selected"}
								</p>
							) : (
								moveLocation &&
								moveRootLabel && (
									<p className="hidden text-xs truncate sm:block text-gray-10">
										Drag them onto a folder, or use Move
									</p>
								)
							)}
						</div>
						<div className="flex gap-2 shrink-0">
							{moveLocation && moveRootLabel && (
								<Button
									variant="gray"
									onClick={() => setMoveOpen(true)}
									className="flex gap-2 items-center text-sm"
									size="sm"
								>
									<FolderInput className="size-4" />
									Move
								</Button>
							)}
							{archive && (
								<Button
									variant="gray"
									onClick={archive.onArchive}
									disabled={archive.isPending}
									className="flex gap-2 items-center text-sm"
									size="sm"
								>
									<FontAwesomeIcon
										className="size-3.5"
										icon={archive.mode === "archive" ? faBoxArchive : faBoxOpen}
									/>
									<span className="hidden sm:inline">
										{archive.mode === "archive" ? "Archive" : "Unarchive"}
									</span>
								</Button>
							)}
							<Button
								variant="dark"
								onClick={() => setSelectedCaps([])}
								className="text-sm"
								size="sm"
							>
								Cancel
							</Button>
							{deleteSelectedCaps && (
								<>
									<Button
										variant="destructive"
										onClick={() => setConfirmOpen(true)}
										disabled={isDeleting}
										className="size-[40px] min-w-[unset] p-0"
										size="sm"
									>
										<FontAwesomeIcon
											className="w-3.5 text-white"
											icon={faTrash}
										/>
									</Button>
									<ConfirmationDialog
										open={confirmOpen}
										icon={<FontAwesomeIcon icon={faFilm} />}
										title="Delete selected Caps"
										description={`Are you sure you want to delete ${
											selectedCaps.length
										} cap${
											selectedCaps.length === 1 ? "" : "s"
										}? This action cannot be undone.`}
										confirmLabel={isDeleting ? "Deleting..." : "Delete"}
										cancelLabel="Cancel"
										confirmVariant="dark"
										loading={isDeleting}
										onConfirm={handleConfirmDelete}
										onCancel={() => setConfirmOpen(false)}
									/>
								</>
							)}
						</div>
					</motion.div>
					{moveLocation && moveRootLabel && (
						<MoveItemsDialog
							open={moveOpen}
							onOpenChange={setMoveOpen}
							location={moveLocation}
							rootLabel={moveRootLabel}
							item={{
								type: "videos",
								videoIds: selectedCaps,
								currentFolderId,
							}}
							onMoved={() => setSelectedCaps([])}
						/>
					)}
				</>
			)}
		</AnimatePresence>
	);
};
