// A <video> rendered into the server HTML starts loading before React hydrates,
// so loadedmetadata, loadeddata, canplay, an autoplay start or an error can all
// fire before any effect has added its listener. Replaying the ones the element
// has already reached, once every hydration effect has subscribed, gives each
// listener the same events it would get from a video mounted on the client.

type ReplayableVideo = Pick<
	HTMLVideoElement,
	| "addEventListener"
	| "removeEventListener"
	| "dispatchEvent"
	| "readyState"
	| "paused"
	| "error"
>;

const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

const REPLAYABLE_EVENTS: ReadonlyArray<
	readonly [type: string, reached: (video: ReplayableVideo) => boolean]
> = [
	["loadedmetadata", (video) => video.readyState >= HAVE_METADATA],
	["loadeddata", (video) => video.readyState >= HAVE_CURRENT_DATA],
	["canplay", (video) => video.readyState >= HAVE_FUTURE_DATA],
	["play", (video) => !video.paused],
	["error", (video) => video.error != null],
];

export function replayMissedMediaEvents(
	video: ReplayableVideo,
	schedule: (replay: () => void) => () => void = (replay) => {
		const timer = setTimeout(replay, 0);
		return () => clearTimeout(timer);
	},
): () => void {
	const seen = new Set<string>();
	const markSeen = (event: Event) => {
		seen.add(event.type);
	};
	for (const [type] of REPLAYABLE_EVENTS) {
		video.addEventListener(type, markSeen);
	}
	const stopListening = () => {
		for (const [type] of REPLAYABLE_EVENTS) {
			video.removeEventListener(type, markSeen);
		}
	};

	// Scheduled rather than run inline so listeners added by effects that run
	// after this one, in parent components, are subscribed first.
	const cancel = schedule(() => {
		stopListening();
		for (const [type, reached] of REPLAYABLE_EVENTS) {
			if (!seen.has(type) && reached(video)) {
				video.dispatchEvent(new Event(type));
			}
		}
	});

	return () => {
		cancel();
		stopListening();
	};
}
