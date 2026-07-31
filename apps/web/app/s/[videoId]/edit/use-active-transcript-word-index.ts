import { type RefObject, useEffect, useRef, useState } from "react";
import {
	type EditTranscriptWord,
	findActiveTranscriptWordIndex,
} from "@/lib/edit-transcript";

export function useActiveTranscriptWordIndex(
	videoRef: RefObject<HTMLVideoElement | null>,
	words: readonly EditTranscriptWord[] | null,
) {
	const [activeWordIndex, setActiveWordIndex] = useState(-1);
	const activeWordIndexRef = useRef(-1);

	useEffect(() => {
		if (!words) {
			if (activeWordIndexRef.current !== -1) {
				activeWordIndexRef.current = -1;
				setActiveWordIndex(-1);
			}
			return;
		}

		let boundVideo: HTMLVideoElement | null = null;
		let detachVideoListeners: (() => void) | null = null;

		const attachVideoListeners = () => {
			const video = videoRef.current;
			if (video === boundVideo) return;

			detachVideoListeners?.();
			detachVideoListeners = null;
			boundVideo = video;
			if (!video) return;

			let animationFrameId = 0;
			let videoFrameId = 0;
			const updateActiveWord = (timeSeconds = video.currentTime) => {
				const nextIndex = findActiveTranscriptWordIndex(
					words,
					timeSeconds * 1000,
				);
				if (activeWordIndexRef.current === nextIndex) return;
				activeWordIndexRef.current = nextIndex;
				setActiveWordIndex(nextIndex);
			};
			const stopPlaybackFrames = () => {
				cancelAnimationFrame(animationFrameId);
				animationFrameId = 0;
				if (videoFrameId) {
					video.cancelVideoFrameCallback(videoFrameId);
					videoFrameId = 0;
				}
			};
			const schedulePlaybackFrame = () => {
				if (typeof video.requestVideoFrameCallback === "function") {
					videoFrameId = video.requestVideoFrameCallback((_now, metadata) => {
						videoFrameId = 0;
						updateActiveWord(metadata.mediaTime);
						if (!video.paused && !video.ended) {
							schedulePlaybackFrame();
						}
					});
					return;
				}
				animationFrameId = requestAnimationFrame(() => {
					animationFrameId = 0;
					updateActiveWord();
					if (!video.paused && !video.ended) {
						schedulePlaybackFrame();
					}
				});
			};
			const handlePlay = () => {
				stopPlaybackFrames();
				schedulePlaybackFrame();
			};
			const handlePause = () => {
				stopPlaybackFrames();
				updateActiveWord();
			};
			const handleTimeChange = () => updateActiveWord();

			updateActiveWord();
			video.addEventListener("play", handlePlay);
			video.addEventListener("pause", handlePause);
			video.addEventListener("seeked", handleTimeChange);
			video.addEventListener("timeupdate", handleTimeChange);
			if (!video.paused) handlePlay();

			detachVideoListeners = () => {
				stopPlaybackFrames();
				video.removeEventListener("play", handlePlay);
				video.removeEventListener("pause", handlePause);
				video.removeEventListener("seeked", handleTimeChange);
				video.removeEventListener("timeupdate", handleTimeChange);
			};
		};

		const videoObserver = new MutationObserver(attachVideoListeners);
		videoObserver.observe(document.body, {
			childList: true,
			subtree: true,
		});
		attachVideoListeners();

		return () => {
			videoObserver.disconnect();
			detachVideoListeners?.();
		};
	}, [videoRef, words]);

	return activeWordIndex;
}
