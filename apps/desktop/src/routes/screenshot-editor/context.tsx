import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { debounce } from "@solid-primitives/scheduled";
import { createEffect, createResource, createSignal, on } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { createImageDataWS, createLazySignal } from "~/utils/socket";
import {
	type AspectRatio,
	type AudioConfiguration,
	type BackgroundConfiguration,
	type Camera,
	type CameraPosition,
	type CursorConfiguration,
	commands,
	type HotkeysConfiguration,
	type ProjectConfiguration,
	type XY,
} from "~/utils/tauri";

export type ScreenshotProject = ProjectConfiguration;

export type CurrentDialog =
	| { type: "createPreset" }
	| { type: "renamePreset"; presetIndex: number }
	| { type: "deletePreset"; presetIndex: number }
	| { type: "crop"; position: XY<number>; size: XY<number> }
	| { type: "export" };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

const DEFAULT_CAMERA: Camera = {
	hide: false,
	mirror: false,
	position: { x: "right", y: "bottom" },
	size: 30,
	zoom_size: 60,
	rounding: 0,
	shadow: 0,
	advancedShadow: null,
	shape: "square",
	roundingType: "squircle",
};

const DEFAULT_AUDIO: AudioConfiguration = {
	mute: false,
	improve: false,
	micVolumeDb: 0,
	micStereoMode: "stereo",
	systemVolumeDb: 0,
};

const DEFAULT_CURSOR: CursorConfiguration = {
	hide: false,
	hideWhenIdle: false,
	hideWhenIdleDelay: 2,
	size: 100,
	type: "pointer",
	animationStyle: "mellow",
	tension: 120,
	mass: 1.1,
	friction: 18,
	raw: false,
	motionBlur: 0,
	useSvg: true,
};

const DEFAULT_HOTKEYS: HotkeysConfiguration = {
	show: false,
};

const DEFAULT_PROJECT: ScreenshotProject = {
	background: {
		source: {
			type: "wallpaper",
			path: "macOS/sequoia-dark",
		},
		blur: 0,
		padding: 20,
		rounding: 10,
		roundingType: "squircle",
		inset: 0,
		crop: null,
		shadow: 0,
		advancedShadow: null,
		border: null,
	},
	aspectRatio: null,
	camera: DEFAULT_CAMERA,
	audio: DEFAULT_AUDIO,
	cursor: DEFAULT_CURSOR,
	hotkeys: DEFAULT_HOTKEYS,
	timeline: null,
	captions: null,
	clips: [],
};

export const [ScreenshotEditorProvider, useScreenshotEditorContext] =
	createContextProvider(() => {
		const [project, setProject] =
			createStore<ScreenshotProject>(DEFAULT_PROJECT);
		const [dialog, setDialog] = createSignal<DialogState>({
			open: false,
		});

		const [latestFrame, setLatestFrame] = createLazySignal<{
			width: number;
			data: ImageData;
		}>();

		const [editorInstance] = createResource(async () => {
			// @ts-expect-error - types not updated yet
			const instance = await commands.createScreenshotEditorInstance();

			if (instance.config) {
				setProject(reconcile(instance.config));
			}

			const [_ws, isConnected] = createImageDataWS(
				instance.framesSocketUrl,
				setLatestFrame,
			);

			return instance;
		});

		const saveConfig = debounce((config: ProjectConfiguration) => {
			// @ts-expect-error - command signature update
			commands.updateScreenshotConfig(config, true);
		}, 1000);

		createEffect(
			on([() => trackStore(project), editorInstance], async ([, instance]) => {
				if (!instance) return;

				const config = unwrap(project);

				// @ts-expect-error - command signature update
				commands.updateScreenshotConfig(config, false);
				saveConfig(config);
			}),
		);

		// Mock history for now or implement if needed
		const projectHistory = {
			pause: () => () => {},
			resume: () => {},
			undo: () => {},
			redo: () => {},
			canUndo: () => false,
			canRedo: () => false,
			isPaused: () => false,
		};

		return {
			get path() {
				return editorInstance()?.path ?? "";
			},
			project,
			setProject,
			projectHistory,
			dialog,
			setDialog,
			latestFrame,
			editorInstance,
		};
	}, null!);
