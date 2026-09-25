"use client";

import type { MediaState } from "media-chrome/react/media-store";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	CORNER_CARD_DELAY_SECONDS,
	type ShareCallToAction,
	shouldShowCornerCard,
} from "@/lib/share-call-to-action";
import { useMediaPlayer, useMediaPlayerStore } from "../video/media-player";
import {
	CallToActionCornerCard,
	CallToActionEndScreen,
	type CallToActionScale,
} from "./CallToActionSurfaces";

type MediaSnapshot = Partial<MediaState>;

const selectEnded = (state: MediaSnapshot) => state.mediaEnded ?? false;
const selectPastIntro = (state: MediaSnapshot) =>
	(state.mediaCurrentTime ?? 0) >= CORNER_CARD_DELAY_SECONDS;

const dismissedKey = (videoId: string) => `cap:cta-dismissed:${videoId}`;

function readDismissed(videoId: string) {
	try {
		return window.sessionStorage.getItem(dismissedKey(videoId)) === "1";
	} catch {
		return false;
	}
}

function writeDismissed(videoId: string) {
	try {
		window.sessionStorage.setItem(dismissedKey(videoId), "1");
	} catch {}
}

function scaleForWidth(width: number): CallToActionScale {
	if (width < 480) return "compact";
	if (width < 960) return "regular";
	return "large";
}

export function CallToActionOverlay({
	cta,
	videoId,
	controlsDocked = false,
}: {
	cta: ShareCallToAction;
	videoId: string;
	controlsDocked?: boolean;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [dismissed, setDismissed] = useState(false);
	const ended = useMediaPlayer(selectEnded);
	const pastIntro = useMediaPlayer(selectPastIntro);
	const controlsVisible = useMediaPlayerStore((state) => state.controlsVisible);

	useEffect(() => {
		setDismissed(readDismissed(videoId));
	}, [videoId]);

	useEffect(() => {
		const element = rootRef.current;
		if (!element) return;
		const update = () => {
			const rect = element.getBoundingClientRect();
			setSize((previous) =>
				previous.width === rect.width && previous.height === rect.height
					? previous
					: { width: rect.width, height: rect.height },
			);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const findVideo = useCallback(
		() =>
			rootRef.current?.parentElement?.querySelector<HTMLVideoElement>(
				"video",
			) ?? null,
		[],
	);

	const handleReplay = useCallback(() => {
		const video = findVideo();
		if (!video) return;
		video.currentTime = 0;
		void video.play().catch(() => {});
	}, [findVideo]);

	const handleOpen = useCallback(() => {
		const video = findVideo();
		if (video && !video.paused) video.pause();
	}, [findVideo]);

	const handleDismiss = useCallback(() => {
		setDismissed(true);
		writeDismissed(videoId);
	}, [videoId]);

	const showCornerCard = shouldShowCornerCard({
		cta,
		width: size.width,
		height: size.height,
		dismissed,
		pastIntro,
		ended,
	});
	const liftAboveControls = controlsVisible && !controlsDocked;

	return (
		<div
			ref={rootRef}
			data-slot="cta-overlay"
			className="pointer-events-none absolute inset-0 z-[45] rounded-[inherit]"
		>
			<AnimatePresence>
				{ended && size.width > 0 && (
					<div key="end" className="pointer-events-auto absolute inset-0">
						<CallToActionEndScreen
							cta={cta}
							scale={scaleForWidth(size.width)}
							controlsInset={!controlsDocked}
							onReplay={handleReplay}
							onOpen={handleOpen}
						/>
					</div>
				)}
			</AnimatePresence>
			<div
				className="absolute right-4 transition-[bottom] duration-300 ease-out"
				style={{ bottom: liftAboveControls ? 92 : 16 }}
			>
				<AnimatePresence>
					{showCornerCard && (
						<CallToActionCornerCard
							key="corner"
							cta={cta}
							className="pointer-events-auto"
							onDismiss={handleDismiss}
							onOpen={handleOpen}
						/>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}
