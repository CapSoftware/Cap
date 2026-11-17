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
	webkitDisplayingFullscreen = false;

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

		(video as unknown as FakeVideo).dispatch("loadedmetadata");
		textTracks.addSilently(captionTrack);
		trackElement.readyState = 2;
		trackElement.dispatch("load");
		captionTrack.dispatch("cuechange");

		expect(captionTrack.mode).toBe("hidden");
		expect(cueTexts.at(-1)).toBe("Loaded caption");

		cleanup();
	});

	it("lets the browser show captions in the video's own full screen", () => {
		const textTracks = new FakeTextTrackList();
		const captionTrack = new FakeTextTrack(
			"captions",
			createCueList("Full screen caption"),
		);
		textTracks.addSilently(captionTrack);
		const video = createVideo(textTracks, []);
		const fakeVideo = video as unknown as FakeVideo;
		const cueTexts: string[] = [];

		const cleanup = bindCaptionTrackCueText(video, (text) => {
			cueTexts.push(text);
		});

		expect(captionTrack.mode).toBe("hidden");
		expect(cueTexts.at(-1)).toBe("Full screen caption");

		fakeVideo.webkitDisplayingFullscreen = true;
		fakeVideo.dispatch("webkitbeginfullscreen");

		expect(captionTrack.mode).toBe("showing");
		expect(cueTexts.at(-1)).toBe("");

		fakeVideo.webkitDisplayingFullscreen = false;
		fakeVideo.dispatch("webkitendfullscreen");

		expect(captionTrack.mode).toBe("hidden");
		expect(cueTexts.at(-1)).toBe("Full screen caption");

		cleanup();
	});

	it("keeps captions the viewer turns off in native full screen off", () => {
		const textTracks = new FakeTextTrackList();
		const captionTrack = new FakeTextTrack(
			"captions",
			createCueList("Full screen caption"),
		);
		textTracks.addSilently(captionTrack);
		const video = createVideo(textTracks, []);
		const fakeVideo = video as unknown as FakeVideo;

		const cleanup = bindCaptionTrackCueText(video, () => undefined);

		fakeVideo.webkitDisplayingFullscreen = true;
		fakeVideo.dispatch("webkitbeginfullscreen");
		captionTrack.mode = "disabled";
		textTracks.dispatch("change");

		expect(captionTrack.mode).toBe("disabled");

		cleanup();
		fakeVideo.dispatch("webkitendfullscreen");

		expect(captionTrack.mode).toBe("disabled");
	});
});
