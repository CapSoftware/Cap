"use client";

import { useRouter } from "next/navigation";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { watchShareVideoUpdates } from "@/lib/share-video-updates";

/**
 * Brings in a Save published after this page loaded. A viewer who hasn't
 * started the video, or has watched to the end, gets the new one straight
 * away; one part way through is offered it, so their place isn't lost.
 */
export function useShareVideoUpdates({
	videoId,
	revision,
	videoRef,
	enabled,
}: {
	videoId: string;
	revision: string | null;
	videoRef: RefObject<HTMLVideoElement | null>;
	enabled: boolean;
}) {
	const router = useRouter();
	const [newer, setNewer] = useState<string | null>(null);
	const refreshedFor = useRef<string | null>(null);

	useEffect(() => {
		setNewer(null);
		if (!enabled || revision === null) return;
		return watchShareVideoUpdates({
			videoId,
			revision,
			onNewer: (next) => {
				const video = videoRef.current;
				const midway = !!video && video.currentTime > 0 && !video.ended;
				// A refresh that still rendered the old version (a lagging read)
				// is offered rather than repeated.
				if (!midway && refreshedFor.current !== next) {
					refreshedFor.current = next;
					router.refresh();
				} else {
					setNewer(next);
				}
			},
		});
	}, [enabled, revision, videoId, videoRef, router]);

	const showLatest = useCallback(() => {
		refreshedFor.current = newer;
		router.refresh();
	}, [newer, router]);

	return { updateAvailable: newer !== null, showLatest };
}
