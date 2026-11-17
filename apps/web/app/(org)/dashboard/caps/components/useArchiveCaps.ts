"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { setVideosArchived } from "@/actions/videos/archive";
import { chunkIds, MAX_ARCHIVE_ITEMS } from "@/lib/video-archive";

const capsLabel = (count: number) =>
	`${count.toLocaleString("en-US")} Cap${count === 1 ? "" : "s"}`;

class PartialArchiveError extends Error {
	constructor(readonly doneIds: Video.VideoId[]) {
		super("Some Caps were not updated");
	}
}

async function applyArchive(ids: Video.VideoId[], archived: boolean) {
	const done: Video.VideoId[] = [];
	for (const chunk of chunkIds(ids, MAX_ARCHIVE_ITEMS)) {
		try {
			await setVideosArchived({ videoIds: chunk, archived });
		} catch (error) {
			if (done.length > 0) throw new PartialArchiveError(done);
			throw error;
		}
		done.push(...chunk);
	}
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
			} catch (error) {
				if (error instanceof PartialArchiveError) {
					onDoneRef.current?.(error.doneIds);
					router.refresh();
					toast.error(
						`${archived ? "Archived" : "Unarchived"} ${error.doneIds.length.toLocaleString("en-US")} of ${capsLabel(ids.length)}. Try again for the rest.`,
					);
					return;
				}
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
