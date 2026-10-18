"use client";

import { useSyncExternalStore } from "react";

/**
 * Upload progress for in-flight media comments, keyed by comment id (the temp
 * id while optimistic). Module-level for the same reason as the blob-url
 * registry: the sending card renders in trees (sidebar, timeline hover card,
 * mobile sheet) far from the recorder that owns the upload.
 *
 * Values are 0..1 fractions. An entry exists for the whole pipeline — a card
 * can therefore distinguish "preparing" (entry at 0, conversion/thumbnail
 * still running) from actual byte progress without extra state.
 */
const fractions = new Map<string, number>();
const listeners = new Set<() => void>();

const notify = () => {
	for (const listener of listeners) listener();
};

export function setUploadProgress(commentId: string, fraction: number) {
	const clamped = Math.max(0, Math.min(1, fraction));
	// Progress events fire per uploaded chunk; skip no-op notifications so
	// subscribed cards only render when the visible percent actually moves.
	if (
		Math.round((fractions.get(commentId) ?? -1) * 100) ===
		Math.round(clamped * 100)
	)
		return;
	fractions.set(commentId, clamped);
	notify();
}

export function clearUploadProgress(commentId: string) {
	if (!fractions.delete(commentId)) return;
	notify();
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

/** Fraction 0..1 while the comment's media is uploading, undefined otherwise. */
export function useUploadProgress(commentId: string): number | undefined {
	return useSyncExternalStore(
		subscribe,
		() => fractions.get(commentId),
		() => undefined,
	);
}
