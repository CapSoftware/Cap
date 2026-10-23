"use client";

import { DropdownMenuItem } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { faCopy } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useIsMutating } from "@tanstack/react-query";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";

/**
 * The "Duplicate Cap" row of the owner menu, self-contained so its RPC
 * mutation — and the Effect runtime it drags along — loads only when the menu
 * is actually opened, not on every share-page view.
 */
export default function DuplicateCapMenuItem({
	videoId,
	disabled,
}: {
	videoId: Video.VideoId;
	disabled?: boolean;
}) {
	const rpc = useRpcClient();

	const duplicateMutation = useEffectMutation({
		mutationKey: ["videoDuplicate", videoId],
		mutationFn: () => rpc.VideoDuplicate(videoId),
		onSuccess: () => {
			toast.success("Cap duplicated successfully");
		},
		onError: () => {
			toast.error("Failed to duplicate Cap");
		},
	});
	// Read pending state through the cache, not the hook instance: the menu
	// content remounts every time it opens, and a fresh instance would forget
	// an in-flight duplication and allow a second one.
	const isDuplicating =
		useIsMutating({ mutationKey: ["videoDuplicate", videoId] }) > 0;

	return (
		<DropdownMenuItem
			onClick={() => duplicateMutation.mutate()}
			disabled={isDuplicating || disabled}
			className="flex items-center gap-2 rounded-lg"
		>
			<FontAwesomeIcon className="size-3" icon={faCopy} />
			<p className="text-sm text-gray-12">
				{isDuplicating ? "Duplicating..." : "Duplicate Cap"}
			</p>
		</DropdownMenuItem>
	);
}
