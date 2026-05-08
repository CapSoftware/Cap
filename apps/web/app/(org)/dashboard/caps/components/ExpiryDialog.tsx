"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { faClock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import moment from "moment";
import { toast } from "sonner";

type ExpiryPreset = Video.VideoExpiryPreset;

interface ExpiryDialogProps {
	isOpen: boolean;
	onClose: () => void;
	videoId: Video.VideoId;
	expiresAt?: Date | null;
	onExpiryUpdated: () => void;
}

const options: {
	preset: ExpiryPreset;
	label: string;
	description: string;
}[] = [
	{
		preset: "7d",
		label: "Delete after 7 days",
		description: "Best for short-lived shares and keeping storage low.",
	},
	{
		preset: "30d",
		label: "Delete after 30 days",
		description: "Keeps the link around longer while still cleaning R2.",
	},
	{
		preset: "never",
		label: "Keep permanently",
		description: "Stores the video until you delete it manually.",
	},
];

export const ExpiryDialog: React.FC<ExpiryDialogProps> = ({
	isOpen,
	onClose,
	videoId,
	expiresAt,
	onExpiryUpdated,
}) => {
	const currentStatus = expiresAt
		? `Currently deletes ${moment(expiresAt).fromNow()}`
		: "Currently kept permanently";

	const updateExpiry = useMutation({
		mutationFn: async (preset: ExpiryPreset) => {
			const response = await fetch("/api/video/expiry", {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ videoId, preset }),
			});

			if (!response.ok) throw new Error("Failed to update expiry");

			return response.json();
		},
		onSuccess: (_data, preset) => {
			toast.success(
				preset === "never"
					? "Video will be kept permanently"
					: `Video will be deleted ${
							preset === "7d" ? "after 7 days" : "after 30 days"
						}`,
			);
			onExpiryUpdated();
			onClose();
		},
		onError: () => {
			toast.error("Failed to update expiry");
		},
	});

	return (
		<Dialog open={isOpen} onOpenChange={onClose}>
			<DialogContent className="p-0 w-full max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader
					icon={<FontAwesomeIcon icon={faClock} className="size-3.5" />}
					description={currentStatus}
				>
					<DialogTitle>Video expiry</DialogTitle>
				</DialogHeader>
				<div className="p-5 space-y-2">
					{options.map((option) => (
						<button
							key={option.preset}
							type="button"
							className={clsx(
								"w-full text-left rounded-lg border border-gray-4 bg-gray-1 px-4 py-3 transition-colors hover:border-blue-8 hover:bg-gray-2",
								updateExpiry.isPending && "pointer-events-none opacity-60",
							)}
							onClick={() => updateExpiry.mutate(option.preset)}
							disabled={updateExpiry.isPending}
						>
							<p className="text-sm font-medium text-gray-12">{option.label}</p>
							<p className="mt-1 text-xs text-gray-10">{option.description}</p>
						</button>
					))}
				</div>
				<DialogFooter className="p-5 border-t border-gray-4">
					<Button
						size="sm"
						variant="gray"
						onClick={onClose}
						disabled={updateExpiry.isPending}
					>
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
