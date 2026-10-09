"use client";

import { detectRecordingModeFromTrack } from "@cap/recorder-core/recorder-utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { RecordingMode } from "./recording-mode";

export type ScreenSurface = Exclude<RecordingMode, "camera">;

export type SharedScreen = {
	stream: MediaStream;
	surface: ScreenSurface;
};

const stopStream = (stream: MediaStream | null) => {
	for (const track of stream?.getTracks() ?? []) track.stop();
};

/**
 * The browser's screen picker can still be open when the recorder closes. A
 * capture it returns for that earlier visit is stopped instead of kept, so
 * it can't be shared or recorded behind a closed recorder.
 */
export const useScreenShare = ({
	open,
	acquire,
}: {
	open: boolean;
	acquire: () => Promise<MediaStream>;
}) => {
	const [sharedScreen, setSharedScreen] = useState<SharedScreen | null>(null);
	const sharedScreenRef = useRef<SharedScreen | null>(null);
	const [sharePending, setSharePending] = useState(false);
	const visitRef = useRef(0);

	const replaceSharedScreen = useCallback((next: SharedScreen | null) => {
		sharedScreenRef.current = next;
		setSharedScreen(next);
	}, []);

	const stopSharing = useCallback(() => {
		stopStream(sharedScreenRef.current?.stream ?? null);
		replaceSharedScreen(null);
	}, [replaceSharedScreen]);

	useEffect(() => {
		if (open) return;
		visitRef.current += 1;
		setSharePending(false);
	}, [open]);

	useEffect(
		() => () => {
			visitRef.current += 1;
			stopStream(sharedScreenRef.current?.stream ?? null);
			sharedScreenRef.current = null;
		},
		[],
	);

	// The recorder takes ownership of the shared screen when it starts, so it
	// is forgotten here rather than stopped.
	const takeSharedDisplayStream = useCallback(() => {
		const shared = sharedScreenRef.current;
		replaceSharedScreen(null);
		const live = shared?.stream
			.getVideoTracks()
			.some((track) => track.readyState === "live");
		return live ? (shared?.stream ?? null) : null;
	}, [replaceSharedScreen]);

	const shareScreen = useCallback(async () => {
		const visit = visitRef.current;
		setSharePending(true);
		try {
			const stream = await acquire();
			if (visit !== visitRef.current) {
				stopStream(stream);
				return false;
			}
			stopStream(sharedScreenRef.current?.stream ?? null);
			const track = stream.getVideoTracks()[0] ?? null;
			const shared: SharedScreen = {
				stream,
				surface: detectRecordingModeFromTrack(track) ?? "fullscreen",
			};
			track?.addEventListener("ended", () => {
				if (sharedScreenRef.current === shared) replaceSharedScreen(null);
			});
			replaceSharedScreen(shared);
			return true;
		} catch (error) {
			if (
				visit === visitRef.current &&
				!(error instanceof DOMException && error.name === "NotAllowedError")
			) {
				console.error("Screen share failed", error);
				toast.error("Couldn't share your screen. Try again.");
			}
			return false;
		} finally {
			if (visit === visitRef.current) setSharePending(false);
		}
	}, [acquire, replaceSharedScreen]);

	return {
		sharedScreen,
		sharedScreenRef,
		sharePending,
		shareScreen,
		stopSharing,
		takeSharedDisplayStream,
	};
};
