import { describe, expect, it } from "vitest";
import { bindCaptionTrackCueText } from "@/app/s/[videoId]/_components/caption-tracks";

type Listener = () => void;

class FakeEventTarget {
	private listeners = new Map<string, Set<Listener>>();

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? new Set<Listener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener();
		}
	}
}

class FakeTextTrack extends FakeEventTarget {
	mode: TextTrackMode = "disabled";

	constructor(
		readonly kind: TextTrackKind,
		readonly activeCues: TextTrackCueList | null,
	) {
		super();
	}
}

class FakeTextTrackList extends FakeEventTarget {
	private tracks: FakeTextTrack[] = [];

	get length(): number {
		return this.tracks.length;
	}

	addSilently(track: FakeTextTrack): void {
		this.tracks.push(track);
		(this as unknown as Record<number, FakeTextTrack>)[this.tracks.length - 1] =
			track;
	}
}

class FakeTrackElement extends FakeEventTarget {
	readyState = 0;
}

class FakeVideo extends FakeEventTarget {
	constructor(
		readonly textTracks: FakeTextTrackList,
		private trackElements: FakeTrackElement[],
	) {
		super();
	}

	querySelectorAll(selector: string): FakeTrackElement[] {
		return selector === "track" ? this.trackElements : [];
	}
}

function createCueList(text: string): TextTrackCueList {
	return {
		length: 1,
		item: () => ({ startTime: 1, text }),
		getCueById: () => null,
	} as unknown as TextTrackCueList;
}

function createVideo(
	textTracks: FakeTextTrackList,
	trackElements: FakeTrackElement[],
): HTMLVideoElement {
	return new FakeVideo(
		textTracks,
		trackElements,
	) as unknown as HTMLVideoElement;
}

describe("bindCaptionTrackCueText", () => {
	it("initializes caption cues when a track element loads after metadata", () => {
		const textTracks = new FakeTextTrackList();
		const trackElement = new FakeTrackElement();
		const video = createVideo(textTracks, [trackElement]);
		const captionTrack = new FakeTextTrack(
			"captions",
			createCueList("Loaded caption"),
		);
		const cueTexts: string[] = [];

		const cleanup = bindCaptionTrackCueText(video, (text) => {
			cueTexts.push(text);
		});

		video.dispatch("loadedmetadata");
		textTracks.addSilently(captionTrack);
		trackElement.readyState = 2;
		trackElement.dispatch("load");
		captionTrack.dispatch("cuechange");

		expect(captionTrack.mode).toBe("hidden");
		expect(cueTexts.at(-1)).toBe("Loaded caption");

		cleanup();
	});
});
