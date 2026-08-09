"use client";

import { useSyncExternalStore } from "react";

/**
 * Blob URLs for just-recorded media comments, keyed by comment id (temp id
 * first, remapped to the real id once the row exists). Module-level because
 * the optimistic card renders in trees (sidebar, timeline) far from the
 * recorder that owns the blob.
 */
const urls = new Map<string, string>();
const listeners = new Set<() => void>();

const notify = () => {
	for (const listener of listeners) listener();
};

const REVOKE_AFTER_REMAP_MS = 5 * 60 * 1000;

export function setLocalMediaUrl(commentId: string, url: string) {
	urls.set(commentId, url);
	notify();
}

/** Point the real comment id at the same blob; schedule the eventual revoke. */
export function remapLocalMediaUrl(tempId: string, realId: string) {
	const url = urls.get(tempId);
	if (!url) return;
	urls.delete(tempId);
	urls.set(realId, url);
	notify();
	// By then the uploaded copy is servable and any in-flight playback of the
	// blob has long finished or moved on.
	setTimeout(() => {
		if (urls.get(realId) !== url) return;
		urls.delete(realId);
		URL.revokeObjectURL(url);
		notify();
	}, REVOKE_AFTER_REMAP_MS);
}

export function dropLocalMediaUrl(commentId: string) {
	const url = urls.get(commentId);
	if (!url) return;
	urls.delete(commentId);
	URL.revokeObjectURL(url);
	notify();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export function useLocalMediaUrl(commentId: string): string | undefined {
	return useSyncExternalStore(
		subscribe,
		() => urls.get(commentId),
		() => undefined,
	);
}
