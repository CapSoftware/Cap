"use client";

import type { Video } from "@cap/web-domain";
import { useEffect, useRef } from "react";
import { EditorHostBridge } from "../edit/studio/editor-host";

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
}: {
	videoId: Video.VideoId;
	userId: string;
	captionsEnabled: boolean;
	savedAt: string | null;
}) {
	const bridgeRef = useRef<EditorHostBridge | null>(null);
	const savedAtRef = useRef(savedAt);

	useEffect(() => {
		// A reload or refresh shows the share page, not another publish. A null
		// state is what lets the router adopt the new URL.
		const url = new URL(window.location.href);
		url.searchParams.delete("from");
		window.history.replaceState(null, "", url);
		return () => {
			bridgeRef.current?.dispose();
			bridgeRef.current = null;
		};
	}, []);

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
