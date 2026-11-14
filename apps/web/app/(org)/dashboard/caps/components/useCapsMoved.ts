"use client";

import type { Video } from "@cap/web-domain";
import { useEffect, useRef } from "react";

const CAPS_MOVED_EVENT = "cap:caps-moved";

export function notifyCapsMoved(ids: Video.VideoId[]) {
	window.dispatchEvent(
		new CustomEvent<Video.VideoId[]>(CAPS_MOVED_EVENT, { detail: ids }),
	);
}

export function useCapsMoved(onMoved: (ids: Video.VideoId[]) => void) {
	const handler = useRef(onMoved);
	handler.current = onMoved;

	useEffect(() => {
		const listener = (event: Event) => {
			const ids = (event as CustomEvent<Video.VideoId[]>).detail;
			if (Array.isArray(ids)) handler.current(ids);
		};
		window.addEventListener(CAPS_MOVED_EVENT, listener);
		return () => window.removeEventListener(CAPS_MOVED_EVENT, listener);
	}, []);
}
