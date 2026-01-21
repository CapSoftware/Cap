export interface EditorState {
	previewTime: number;
	playbackTime: number;
	playing: boolean;

	timeline: {
		interactMode: "seek" | "split";
		selection: ClipSelection | null;
		transform: TimelineTransform;
		hoveredTrack: "clip" | "zoom" | null;
	};
}

export interface ClipSelection {
	type: "clip";
	indices: number[];
}

export interface TimelineTransform {
	position: number;
	zoom: number;
}

export const DEFAULT_EDITOR_STATE: EditorState = {
	previewTime: 0,
	playbackTime: 0,
	playing: false,
	timeline: {
		interactMode: "seek",
		selection: null,
		transform: { position: 0, zoom: 10 },
		hoveredTrack: null,
	},
};
