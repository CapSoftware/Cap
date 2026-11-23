"use client";

import type { Video } from "@cap/web-domain";
import { useEffect, useRef } from "react";
import { useRenderSaveStatus } from "./render-save-status";

const START_TIMEOUT_MS = 60_000;

export function RecordingPublisher({
	videoId,
	onDone,
}: {
	videoId: Video.VideoId;
	onDone: () => void;
}) {
	const started = useRef(false);
	const status = useRenderSaveStatus(videoId, true, !started.current, true);

	useEffect(() => {
		if (status?.state === "rendering") started.current = true;
		else if (started.current || status?.state === "ready") onDone();
	}, [status, onDone]);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!started.current) onDone();
		}, START_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [onDone]);

	return (
		<iframe
			title="Cap publishing"
			aria-hidden
			tabIndex={-1}
			src={`/s/${encodeURIComponent(videoId)}/edit/studio?publish=recording`}
			className="pointer-events-none fixed top-0 left-[-10000px] h-[720px] w-[1280px] border-0 opacity-0"
		/>
	);
}
