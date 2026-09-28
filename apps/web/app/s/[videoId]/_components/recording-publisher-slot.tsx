"use client";

import type { Video } from "@cap/web-domain";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";

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
	return active ? <RecordingPublisher {...publisher} onDone={done} /> : null;
}
