"use client";

import type { Video } from "@cap/web-domain";
import { faVideo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";

/**
 * The owner's delete confirmation, self-contained so its RPC mutation — and
 * the Effect runtime it drags along — loads only once deletion is actually
 * requested, not on every share-page view.
 */
export default function DeleteCapDialog({
	open,
	videoId,
	videoTitle,
	onClose,
}: {
	open: boolean;
	videoId: Video.VideoId;
	videoTitle: string;
	onClose: () => void;
}) {
	const { push } = useRouter();
	const rpc = useRpcClient();

	const deleteMutation = useEffectMutation({
		mutationFn: () => rpc.VideoDelete(videoId),
		onSuccess: () => {
			toast.success("Cap deleted successfully");
			push("/dashboard/caps?page=1");
		},
		onError: () => {
			toast.error("Failed to delete Cap");
		},
		onSettled: () => {
			onClose();
		},
	});

	return (
		<ConfirmationDialog
			open={open}
			icon={<FontAwesomeIcon icon={faVideo} />}
			title="Delete Cap"
			description={`Are you sure you want to delete the cap "${videoTitle}"? This action cannot be undone.`}
			confirmLabel={deleteMutation.isPending ? "Deleting..." : "Delete"}
			confirmVariant="destructive"
			loading={deleteMutation.isPending}
			onConfirm={() => deleteMutation.mutate()}
			onCancel={onClose}
		/>
	);
}
