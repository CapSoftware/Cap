import { getActiveCaptionText } from "./caption-cues";

const loadedTrackReadyState = 2;

const nativeViewEvents = [
	"enterpictureinpicture",
	"leavepictureinpicture",
	"webkitbeginfullscreen",
	"webkitendfullscreen",
] as const;

type NativeViewVideo = HTMLVideoElement & {
	webkitDisplayingFullscreen?: boolean;
};

// Picture in picture and the video's own full screen on iPhone cannot show
// the cue text the page draws, so there the browser shows the track instead.
function isNativeView(video: HTMLVideoElement): boolean {
	return (
		(video as NativeViewVideo).webkitDisplayingFullscreen === true ||
		(typeof document !== "undefined" &&
			document.pictureInPictureElement === video)
	);
}

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
		onCueTextChange(
			isNativeView(video) ? "" : getActiveCaptionText(currentTrack?.activeCues),
		);
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
			if (track.mode !== "hidden" && !isNativeView(video)) {
				track.mode = "hidden";
			}

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

	const handleNativeViewChange = (): void => {
		syncTracks();
		if (currentTrack) {
			currentTrack.mode = isNativeView(video) ? "showing" : "hidden";
		}
		updateCueText();
	};

	let mutationObserver: MutationObserver | null = null;

	if (typeof MutationObserver !== "undefined") {
		mutationObserver = new MutationObserver(handleTrackUpdate);
		mutationObserver.observe(video, { childList: true });
	}

	video.addEventListener("loadedmetadata", handleTrackUpdate);
	for (const name of nativeViewEvents) {
		video.addEventListener(name, handleNativeViewChange);
	}
	video.textTracks.addEventListener("change", handleTrackUpdate);
	video.textTracks.addEventListener("addtrack", handleTrackUpdate);
	video.textTracks.addEventListener("removetrack", handleTrackUpdate);

	handleTrackUpdate();

	return () => {
		mutationObserver?.disconnect();
		video.removeEventListener("loadedmetadata", handleTrackUpdate);
		for (const name of nativeViewEvents) {
			video.removeEventListener(name, handleNativeViewChange);
		}
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
