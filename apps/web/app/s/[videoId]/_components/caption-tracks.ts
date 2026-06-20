import { getActiveCaptionText } from "./caption-cues";

const loadedTrackReadyState = 2;

function isCaptionTextTrack(
	track: TextTrack | null | undefined,
): track is TextTrack {
	return track?.kind === "captions" || track?.kind === "subtitles";
}

function getTextTracks(video: HTMLVideoElement): TextTrack[] {
	const tracks: TextTrack[] = [];

	for (let index = 0; index < video.textTracks.length; index++) {
		const track = video.textTracks[index];
		if (track) tracks.push(track);
	}

	return tracks;
}

export function bindCaptionTrackCueText(
	video: HTMLVideoElement,
	onCueTextChange: (text: string) => void,
): () => void {
	let currentTrack: TextTrack | null = null;
	const cueTracks = new Set<TextTrack>();
	const trackLoadHandlers = new Map<HTMLTrackElement, () => void>();

	const updateCueText = (): void => {
		onCueTextChange(getActiveCaptionText(currentTrack?.activeCues));
	};

	const syncTracks = (): void => {
		const tracks = getTextTracks(video);

		for (const track of cueTracks) {
			if (!tracks.includes(track)) {
				track.removeEventListener("cuechange", updateCueText);
				cueTracks.delete(track);
			}
		}

		currentTrack = null;

		for (const track of tracks) {
			if (!isCaptionTextTrack(track)) continue;

			if (!currentTrack) currentTrack = track;
			if (track.mode !== "hidden") track.mode = "hidden";

			if (!cueTracks.has(track)) {
				track.addEventListener("cuechange", updateCueText);
				cueTracks.add(track);
			}
		}

		updateCueText();
	};

	const bindTrackElementLoads = (): void => {
		for (const trackElement of video.querySelectorAll("track")) {
			if (trackLoadHandlers.has(trackElement)) continue;

			const handleTrackLoad = (): void => {
				syncTracks();
			};

			trackElement.addEventListener("load", handleTrackLoad);
			trackLoadHandlers.set(trackElement, handleTrackLoad);

			if (trackElement.readyState === loadedTrackReadyState) {
				syncTracks();
			}
		}
	};

	const handleTrackUpdate = (): void => {
		bindTrackElementLoads();
		syncTracks();
	};

	let mutationObserver: MutationObserver | null = null;

	if (typeof MutationObserver !== "undefined") {
		mutationObserver = new MutationObserver(handleTrackUpdate);
		mutationObserver.observe(video, { childList: true });
	}

	video.addEventListener("loadedmetadata", handleTrackUpdate);
	video.textTracks.addEventListener("change", handleTrackUpdate);
	video.textTracks.addEventListener("addtrack", handleTrackUpdate);
	video.textTracks.addEventListener("removetrack", handleTrackUpdate);

	handleTrackUpdate();

	return () => {
		mutationObserver?.disconnect();
		video.removeEventListener("loadedmetadata", handleTrackUpdate);
		video.textTracks.removeEventListener("change", handleTrackUpdate);
		video.textTracks.removeEventListener("addtrack", handleTrackUpdate);
		video.textTracks.removeEventListener("removetrack", handleTrackUpdate);

		for (const [trackElement, handleTrackLoad] of trackLoadHandlers) {
			trackElement.removeEventListener("load", handleTrackLoad);
		}

		for (const track of cueTracks) {
			track.removeEventListener("cuechange", updateCueText);
		}
	};
}
