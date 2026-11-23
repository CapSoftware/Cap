"use client";

import type { Video } from "@cap/web-domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { listCapIdsInView } from "@/actions/caps/list-view-ids";
import {
	deselectPage,
	isSelectionShortcutTarget,
	type PageSelectionState,
	pageSelectionState,
	selectPage,
	toggleSelection,
} from "@/lib/cap-selection";
import {
	MAX_SELECT_ALL_ITEMS,
	type SelectAllView,
} from "@/lib/select-all-view";

export type CapSelection = ReturnType<typeof useCapSelection>;

export function useCapSelection({
	pageIds,
	enabled = true,
	totalCount,
	view,
}: {
	pageIds: readonly Video.VideoId[];
	enabled?: boolean;
	totalCount?: number;
	view?: SelectAllView;
}) {
	const [selected, setSelectedState] = useState<Video.VideoId[]>([]);
	const [matchingCount, setMatchingCount] = useState<number | null>(null);
	const [matchingTruncated, setMatchingTruncated] = useState(false);
	const [isSelectingAll, setIsSelectingAll] = useState(false);
	const anchorRef = useRef<Video.VideoId | null>(null);
	const selectedRef = useRef(selected);
	useEffect(() => {
		selectedRef.current = selected;
	}, [selected]);

	const setSelected = useCallback(
		(
			next: Video.VideoId[] | ((current: Video.VideoId[]) => Video.VideoId[]),
		) => {
			setSelectedState((current) => {
				const value = typeof next === "function" ? next(current) : next;
				if (value.length === 0) anchorRef.current = null;
				return value;
			});
		},
		[],
	);

	const toggle = useCallback(
		(id: Video.VideoId, options?: { shiftKey?: boolean }) => {
			setSelectedState((current) => {
				const result = toggleSelection({
					orderedIds: pageIds,
					selected: current,
					anchorId: anchorRef.current,
					targetId: id,
					shiftKey: options?.shiftKey === true,
				});
				anchorRef.current = result.anchorId;
				return result.selected;
			});
		},
		[pageIds],
	);

	const pageState: PageSelectionState = useMemo(
		() => pageSelectionState(pageIds, selected),
		[pageIds, selected],
	);

	const togglePage = useCallback(() => {
		setSelectedState((current) =>
			pageSelectionState(pageIds, current) === "all"
				? deselectPage(pageIds, current)
				: selectPage(pageIds, current),
		);
	}, [pageIds]);

	const clear = useCallback(() => {
		anchorRef.current = null;
		setSelectedState([]);
	}, []);

	const canSelectAllMatching =
		Boolean(view) &&
		typeof totalCount === "number" &&
		totalCount > pageIds.length &&
		pageState === "all";
	const isAllMatching =
		matchingCount !== null && selected.length === matchingCount;

	const selectAllMatching = useCallback(async () => {
		if (!view) return;
		setIsSelectingAll(true);
		const requestedFrom = selectedRef.current;
		try {
			const { ids, truncated } = await listCapIdsInView(view);
			if (selectedRef.current !== requestedFrom) return;
			setSelectedState(ids);
			setMatchingCount(ids.length);
			setMatchingTruncated(truncated);
		} catch {
			toast.error("Couldn't select every Cap. Please try again.");
		} finally {
			setIsSelectingAll(false);
		}
	}, [view]);

	useEffect(() => {
		if (matchingCount !== null && selected.length !== matchingCount)
			setMatchingCount(null);
	}, [matchingCount, selected.length]);

	const pageKey = pageIds.join(",");
	const previousPageKey = useRef(pageKey);
	useEffect(() => {
		if (previousPageKey.current === pageKey) return;
		previousPageKey.current = pageKey;
		anchorRef.current = null;
	}, [pageKey]);

	useEffect(() => {
		if (!enabled) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!isSelectionShortcutTarget(event.target)) return;
			if (
				event.key.toLowerCase() === "a" &&
				(event.metaKey || event.ctrlKey) &&
				!event.altKey &&
				!event.shiftKey &&
				pageIds.length > 0
			) {
				event.preventDefault();
				setSelectedState((current) => selectPage(pageIds, current));
				return;
			}
			if (event.key === "Escape") {
				setSelectedState((current) => {
					if (current.length === 0) return current;
					anchorRef.current = null;
					return [];
				});
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [enabled, pageIds]);

	return {
		selected,
		setSelected,
		toggle,
		togglePage,
		clear,
		pageState,
		canSelectAllMatching,
		isAllMatching,
		matchingTruncated: isAllMatching && matchingTruncated,
		selectAllLimit: MAX_SELECT_ALL_ITEMS,
		isSelectingAll,
		selectAllMatching,
		totalCount,
	};
}
