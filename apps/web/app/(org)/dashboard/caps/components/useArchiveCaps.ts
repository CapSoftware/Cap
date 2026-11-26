"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	onLeave,
	onReturn,
}: {
	onDone?: (ids: Video.VideoId[]) => void;
	onLeave?: (ids: Video.VideoId[]) => void;
	onReturn?: (ids: Video.VideoId[]) => void;
} = {}) {
	const router = useRouter();
	const [isPending, setIsPending] = useState(false);
	const callbacks = useRef({ onDone, onLeave, onReturn });
	callbacks.current = { onDone, onLeave, onReturn };

	const mutate = useCallback(
		async ({ ids, archived }: { ids: Video.VideoId[]; archived: boolean }) => {
			if (ids.length === 0) return;
			setIsPending(true);
			callbacks.current.onLeave?.(ids);
			try {
				await applyArchive(ids, archived);
			} catch (error) {
				if (error instanceof PartialArchiveError) {
					const done = new Set<string>(error.doneIds);
					callbacks.current.onReturn?.(ids.filter((id) => !done.has(id)));
					callbacks.current.onDone?.(error.doneIds);
					router.refresh();
					toast.error(
						`${archived ? "Archived" : "Unarchived"} ${error.doneIds.length.toLocaleString("en-US")} of ${capsLabel(ids.length)}. Try again for the rest.`,
					);
					return;
				}
				callbacks.current.onReturn?.(ids);
				toast.error(
					archived
						? "Couldn't archive. Please try again."
						: "Couldn't unarchive. Please try again.",
				);
				return;
			} finally {
				setIsPending(false);
			}
			callbacks.current.onDone?.(ids);
			router.refresh();
			toast.success(
				archived
					? `${capsLabel(ids.length)} archived`
					: `${capsLabel(ids.length)} unarchived`,
				{
					action: {
						label: "Undo",
						onClick: () => {
							callbacks.current.onReturn?.(ids);
							void applyArchive(ids, !archived)
								.then(() => router.refresh())
								.catch(() => {
									router.refresh();
									toast.error("Couldn't undo. Please try again.");
								});
						},
					},
				},
			);
		},
		[router],
	);

	return { mutate, isPending };
}

// Cards hidden here leave with an exit animation before the server confirms,
// and come back (animating in) if the request fails or the toast is undone.
// Anything else that changes the list, like paging, swaps cards instantly.
export function useLeavingCaps<T extends { id: Video.VideoId }>(items: T[]) {
	const [leaving, setLeaving] = useState<ReadonlySet<string>>(
		() => new Set<string>(),
	);
	const [returning, setReturning] = useState<ReadonlySet<string>>(
		() => new Set<string>(),
	);

	const leave = useCallback((ids: Video.VideoId[]) => {
		setLeaving((current) => new Set([...current, ...ids]));
	}, []);

	const restore = useCallback((ids: Video.VideoId[]) => {
		setLeaving((current) => {
			const next = new Set(current);
			for (const id of ids) next.delete(id);
			return next.size === current.size ? current : next;
		});
		setReturning((current) => new Set([...current, ...ids]));
	}, []);

	const present = useMemo(
		() => items.filter((item) => !leaving.has(item.id)),
		[items, leaving],
	);

	useEffect(() => {
		const ids = new Set<string>(items.map((item) => item.id));
		setLeaving((current) => {
			if (current.size === 0) return current;
			const next = new Set([...current].filter((id) => ids.has(id)));
			return next.size === current.size ? current : next;
		});
		setReturning((current) => {
			if (current.size === 0) return current;
			const next = new Set([...current].filter((id) => !ids.has(id)));
			return next.size === current.size ? current : next;
		});
	}, [items]);

	return {
		present,
		leaving,
		returning,
		leavingCount: items.length - present.length,
		leave,
		restore,
	};
}
