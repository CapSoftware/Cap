"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { setVideosArchived } from "@/actions/videos/archive";
import { chunkIds, MAX_ARCHIVE_ITEMS } from "@/lib/video-archive";

const capsLabel = (count: number) =>
	`${count.toLocaleString("en-US")} Cap${count === 1 ? "" : "s"}`;

async function applyArchive(ids: Video.VideoId[], archived: boolean) {
	let updated = 0;
	for (const chunk of chunkIds(ids, MAX_ARCHIVE_ITEMS)) {
		const result = await setVideosArchived({ videoIds: chunk, archived });
		updated += result.updated;
	}
	return updated;
}

export function useArchiveCaps({
	onDone,
}: {
	onDone?: (ids: Video.VideoId[]) => void;
} = {}) {
	const router = useRouter();
	const [isPending, setIsPending] = useState(false);
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;

	const mutate = useCallback(
		async ({ ids, archived }: { ids: Video.VideoId[]; archived: boolean }) => {
			if (ids.length === 0) return;
			setIsPending(true);
			try {
				await applyArchive(ids, archived);
			} catch {
				toast.error(
					archived
						? "Couldn't archive. Please try again."
						: "Couldn't unarchive. Please try again.",
				);
				return;
			} finally {
				setIsPending(false);
			}
			onDoneRef.current?.(ids);
			router.refresh();
			toast.success(
				archived
					? `${capsLabel(ids.length)} archived`
					: `${capsLabel(ids.length)} unarchived`,
				{
					action: {
						label: "Undo",
						onClick: () => {
							void applyArchive(ids, !archived)
								.then(() => router.refresh())
								.catch(() => toast.error("Couldn't undo. Please try again."));
						},
					},
				},
			);
		},
		[router],
	);

	return { mutate, isPending };
}
