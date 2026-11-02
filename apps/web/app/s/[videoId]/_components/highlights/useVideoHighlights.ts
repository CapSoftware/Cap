"use client";

import type { Video } from "@cap/web-domain";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	createHighlight,
	deleteHighlight,
	renameHighlight,
} from "@/actions/videos/highlights";
import { sortHighlights, type VideoHighlight } from "@/lib/video-highlights";

export type ShareHighlight = VideoHighlight & { pending?: boolean };

export interface VideoHighlightsController {
	highlights: ShareHighlight[];
	add: (timestamp: number, label?: string | null) => Promise<boolean>;
	rename: (id: string, label: string | null) => Promise<void>;
	remove: (id: string) => Promise<void>;
}

const errorMessage = (error: unknown, fallback: string) =>
	error instanceof Error && error.message ? error.message : fallback;

export function useVideoHighlights({
	videoId,
	initialHighlights,
	viewer,
}: {
	videoId: Video.VideoId;
	initialHighlights: readonly VideoHighlight[];
	viewer: { id: string; name: string | null } | null;
}): VideoHighlightsController {
	const [items, setItems] = useState<ShareHighlight[]>(() =>
		sortHighlights(initialHighlights),
	);

	const add = useCallback(
		async (timestamp: number, label?: string | null) => {
			if (!viewer) return false;
			const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const now = new Date();
			setItems((prev) =>
				sortHighlights([
					...prev,
					{
						id: tempId,
						videoId,
						authorId: viewer.id,
						authorName: viewer.name,
						timestamp: Math.max(0, Math.round(timestamp * 10) / 10),
						label: label?.trim() || null,
						createdAt: now,
						updatedAt: now,
						pending: true,
					},
				]),
			);
			try {
				const saved = await createHighlight({ videoId, timestamp, label });
				setItems((prev) =>
					sortHighlights(prev.map((h) => (h.id === tempId ? saved : h))),
				);
				return true;
			} catch (error) {
				setItems((prev) => prev.filter((h) => h.id !== tempId));
				toast.error(errorMessage(error, "Couldn't add highlight"));
				return false;
			}
		},
		[videoId, viewer],
	);

	const rename = useCallback(async (id: string, label: string | null) => {
		let previous: string | null = null;
		setItems((prev) =>
			prev.map((h) => {
				if (h.id !== id) return h;
				previous = h.label;
				return { ...h, label: label?.trim() || null };
			}),
		);
		try {
			const saved = await renameHighlight({ highlightId: id, label });
			setItems((prev) =>
				prev.map((h) => (h.id === id ? { ...h, label: saved.label } : h)),
			);
		} catch (error) {
			setItems((prev) =>
				prev.map((h) => (h.id === id ? { ...h, label: previous } : h)),
			);
			toast.error(errorMessage(error, "Couldn't rename highlight"));
		}
	}, []);

	const remove = useCallback(async (id: string) => {
		let removed: ShareHighlight | undefined;
		setItems((prev) => {
			removed = prev.find((h) => h.id === id);
			return prev.filter((h) => h.id !== id);
		});
		try {
			await deleteHighlight({ highlightId: id });
		} catch (error) {
			const restore = removed;
			if (restore) setItems((prev) => sortHighlights([...prev, restore]));
			toast.error(errorMessage(error, "Couldn't delete highlight"));
		}
	}, []);

	return useMemo(
		() => ({ highlights: items, add, rename, remove }),
		[items, add, rename, remove],
	);
}
