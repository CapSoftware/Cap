import { createContextProvider } from "@solid-primitives/context";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { AspectRatio, BackgroundConfiguration, XY } from "~/utils/tauri";
import {
	DEFAULT_GRADIENT_FROM,
	DEFAULT_GRADIENT_TO,
} from "../editor/projectConfig";

export type ScreenshotProject = {
	background: BackgroundConfiguration;
	aspectRatio: AspectRatio | null;
};

export type CurrentDialog =
	| { type: "createPreset" }
	| { type: "renamePreset"; presetIndex: number }
	| { type: "deletePreset"; presetIndex: number }
	| { type: "crop"; position: XY<number>; size: XY<number> }
	| { type: "export" };

export type DialogState = { open: false } | ({ open: boolean } & CurrentDialog);

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
};

export const [ScreenshotEditorProvider, useScreenshotEditorContext] =
	createContextProvider((props: { path: string }) => {
		const [project, setProject] =
			createStore<ScreenshotProject>(DEFAULT_PROJECT);
		const [dialog, setDialog] = createSignal<DialogState>({
			open: false,
		});

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
			path: props.path,
			project,
			setProject,
			projectHistory,
			dialog,
			setDialog,
		};
	}, null!);
