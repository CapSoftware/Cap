"use client";

import type { Video } from "@cap/web-domain";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

const RecordingPublisher = dynamic(
	() => import("./recording-publisher").then((m) => m.RecordingPublisher),
	{ ssr: false },
);

/**
 * Holds the decision to publish across refreshes, which render the page
 * again without the one-off `from=recording` it was made from.
 */
export function RecordingPublisherSlot({
	start,
	...publisher
}: {
	start: boolean;
	videoId: Video.VideoId;
	userId: string;
	captionsEnabled: boolean;
	savedAt: string | null;
}) {
	const [active, setActive] = useState(start);
	const done = useCallback(() => setActive(false), []);

	// The decision is made once. Left in the URL, a refresh after a render
	// that failed would tell the page a publish is starting that never runs.
	// A null state is what lets the router adopt the new URL.
	useEffect(() => {
		const url = new URL(window.location.href);
		if (!url.searchParams.has("from")) return;
		url.searchParams.delete("from");
		window.history.replaceState(null, "", url);
	}, []);

	return active ? <RecordingPublisher {...publisher} onDone={done} /> : null;
}
