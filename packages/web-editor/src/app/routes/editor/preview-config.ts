import {
	serializeProjectConfiguration,
	type useEditorContext,
} from "./context";

export function getPreviewProjectConfig(
	project: ReturnType<typeof useEditorContext>["project"],
	editorState: ReturnType<typeof useEditorContext>["editorState"],
) {
	const config = serializeProjectConfiguration(project);

	if (!editorState.timeline.tracks.caption && config.captions) {
		config.captions = {
			...config.captions,
			settings: {
				...config.captions.settings,
				enabled: false,
			},
		};
	}

	if (!editorState.timeline.tracks.keyboard && config.keyboard) {
		config.keyboard = {
			...config.keyboard,
			settings: {
				...config.keyboard.settings,
				enabled: false,
			},
		};
	}

	if (!editorState.timeline.tracks["3d"] && config.timeline) {
		config.timeline = {
			...config.timeline,
			camera3dSegments: [],
		};
	}

	return config;
}
