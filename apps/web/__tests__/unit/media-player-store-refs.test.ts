// @vitest-environment jsdom

import { MediaActionTypes, MediaContext } from "media-chrome/react/media-store";
import {
	act,
	type ContextType,
	createElement,
	useContext,
	useEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MediaPlayer,
	MediaPlayerAudio,
	MediaPlayerVideo,
} from "@/app/s/[videoId]/_components/video/media-player";

vi.mock("@cap/ui", () => ({}));

type MediaStore = NonNullable<ContextType<typeof MediaContext>>;

function StoreProbe({ capture }: { capture: (store: MediaStore) => void }) {
	const store = useContext(MediaContext);
	useEffect(() => {
		if (store) capture(store);
	}, [capture, store]);
	return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(
		HTMLMediaElement.prototype as HTMLMediaElement & { audioTracks: unknown },
		"audioTracks",
		"get",
	).mockReturnValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, "textTracks", "get").mockReturnValue(
		Object.assign(new EventTarget(), {
			length: 0,
			onaddtrack: null,
			onremovetrack: null,
			onchange: null,
			getTrackById: () => null,
			[Symbol.iterator]: () => ([] as TextTrack[])[Symbol.iterator](),
		}) as unknown as TextTrackList,
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("media player store ownership", () => {
	it.each(["video", "audio"] as const)(
		"retains the %s and fullscreen elements across renders",
		async (kind) => {
			const capture = vi.fn<(store: MediaStore) => void>();
			const render = (className: string, key = "initial") =>
				act(async () => {
					root.render(
						createElement(
							MediaPlayer,
							{ className },
							kind === "video"
								? createElement(MediaPlayerVideo, { key })
								: createElement(MediaPlayerAudio, { key }),
							createElement(StoreProbe, { capture }),
						),
					);
				});

			await render("initial");
			const store = capture.mock.calls[0]?.[0];
			if (!store) throw new Error("Expected a media store");
			const dispatch = vi.spyOn(store, "dispatch");
			const media = container.querySelector(kind);
			expect(media).not.toBeNull();

			await render("updated");

			expect(container.querySelector(kind)).toBe(media);
			expect(
				dispatch.mock.calls.filter(
					([action]) =>
						action.type === MediaActionTypes.MEDIA_ELEMENT_CHANGE_REQUEST ||
						action.type === MediaActionTypes.FULLSCREEN_ELEMENT_CHANGE_REQUEST,
				),
			).toEqual([]);

			await render("updated", "replacement");
			const replacement = container.querySelector(kind);
			expect(replacement).not.toBeNull();
			expect(replacement).not.toBe(media);
			expect(
				dispatch.mock.calls
					.filter(
						([action]) =>
							action.type === MediaActionTypes.MEDIA_ELEMENT_CHANGE_REQUEST,
					)
					.map(([action]) => action.detail),
			).toEqual([null, replacement]);

			dispatch.mockClear();
			await act(async () => root.render(null));
			expect(dispatch).toHaveBeenCalledWith({
				type: MediaActionTypes.MEDIA_ELEMENT_CHANGE_REQUEST,
				detail: null,
			});
			expect(dispatch).toHaveBeenCalledWith({
				type: MediaActionTypes.FULLSCREEN_ELEMENT_CHANGE_REQUEST,
				detail: null,
			});
		},
	);
});
