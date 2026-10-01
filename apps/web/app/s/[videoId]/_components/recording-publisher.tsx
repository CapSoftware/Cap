"use client";

import type { Video } from "@cap/web-domain";
import { useEffect, useRef } from "react";
import { EditorHostBridge } from "../edit/studio/editor-host";
import { useRenderSaveStatus } from "./render-save-status";

// A publish that hasn't started rendering by now isn't going to.
const START_TIMEOUT_MS = 60_000;

/**
 * Straight after a recording, with nothing rendering it yet, the owner's
 * browser publishes it in its default look from an editor this page never
 * shows. The share page shows its progress like any other render.
 */
export function RecordingPublisher({
	videoId,
	userId,
	captionsEnabled,
	savedAt,
	onDone,
}: {
	videoId: Video.VideoId;
	userId: string;
	captionsEnabled: boolean;
	savedAt: string | null;
	onDone: () => void;
}) {
	const bridgeRef = useRef<EditorHostBridge | null>(null);
	const savedAtRef = useRef(savedAt);
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

	useEffect(
		() => () => {
			bridgeRef.current?.dispose();
			bridgeRef.current = null;
		},
		[],
	);

	const connect = (iframe: HTMLIFrameElement) => {
		const frameDocument = iframe.contentDocument;
		if (
			bridgeRef.current ||
			!frameDocument ||
			new URL(frameDocument.URL).pathname !== "/editor-solid/index.html"
		)
			return;
		const bridge = new EditorHostBridge(
			videoId,
			`browser-${videoId}`,
			userId,
			() => undefined,
			(cause) => console.warn("Cap could not publish the recording:", cause),
			undefined,
			undefined,
			undefined,
			captionsEnabled,
			undefined,
			(savedAt) => {
				savedAtRef.current = savedAt;
			},
			() => savedAtRef.current,
			true,
		);
		bridgeRef.current = bridge;
		void bridge.connect(iframe).catch((cause: unknown) => {
			console.warn("Cap could not publish the recording:", cause);
		});
	};

	return (
		<iframe
			title="Cap publishing"
			aria-hidden
			tabIndex={-1}
			src={`/editor-solid/index.html?videoId=${encodeURIComponent(videoId)}&publish=recording`}
			className="pointer-events-none fixed top-0 left-[-10000px] h-[720px] w-[1280px] border-0 opacity-0"
			onLoad={(event) => connect(event.currentTarget)}
		/>
	);
}
