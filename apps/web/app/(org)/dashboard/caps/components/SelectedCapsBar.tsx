"use client";

import { Button } from "@cap/ui";
import { faFilm, faTrash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion } from "framer-motion";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";

interface SelectedCapsBarProps {
	selectedCaps: string[];
	setSelectedCaps: (caps: Video.VideoId[]) => void;
	deleteSelectedCaps: () => void;
	isDeleting: boolean;
}

import type { Video } from "@cap/web-domain";
import { useState } from "react";

export const SelectedCapsBar = ({
	selectedCaps,
	setSelectedCaps,
	deleteSelectedCaps,
	isDeleting,
}: SelectedCapsBarProps) => {
	const [confirmOpen, setConfirmOpen] = useState(false);

	const handleConfirmDelete = () => {
		deleteSelectedCaps();
		setConfirmOpen(false);
	};

	return (
		<AnimatePresence>
			{selectedCaps.length > 0 && (
				<motion.div
					className="flex fixed right-0 left-0 bottom-12 z-50 justify-between items-center p-3 mx-auto w-full max-w-xl rounded-xl border shadow-lg border-gray-2 bg-gray-1"
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
					<div className="flex gap-1 text-sm font-medium text-gray-10">
						<NumberFlow
							value={selectedCaps.length}
							className="tabular-nums text-md text-gray-12"
						/>
						cap{selectedCaps.length !== 1 ? "s" : ""} selected
					</div>
					<div className="flex gap-2 ml-4">
						<Button
							variant="dark"
							onClick={() => setSelectedCaps([])}
							className="text-sm"
							size="sm"
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => setConfirmOpen(true)}
							disabled={isDeleting}
							className="size-[40px] min-w-[unset] p-0"
							size="sm"
						>
							<FontAwesomeIcon className="w-3.5 text-white" icon={faTrash} />
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
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
};
