import { createContextProvider } from "@solid-primitives/context";
import { trackStore } from "@solid-primitives/deep";
import { createEffect, createResource, createSignal, on } from "solid-js";
import { createStore } from "solid-js/store";
import { createImageDataWS, createLazySignal } from "~/utils/socket";
import {
	type AspectRatio,
	type BackgroundConfiguration,
	commands,
	type XY,
} from "~/utils/tauri";
import {
	normalizeProject,
	serializeProjectConfiguration,
} from "../editor/context";
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

		const [latestFrame, setLatestFrame] = createLazySignal<{
			width: number;
			data: ImageData;
		}>();

		const [editorInstance] = createResource(async () => {
			const instance = await commands.createScreenshotEditorInstance(
				props.path,
			);

			const [_ws, isConnected] = createImageDataWS(
				instance.framesSocketUrl,
				setLatestFrame,
			);

			return instance;
		});

		createEffect(
			on(
				() => trackStore(project),
				async () => {
					const instance = editorInstance();
					if (!instance) return;

					// Convert ScreenshotProject to ProjectConfiguration
					// We need to construct a full ProjectConfiguration from the partial ScreenshotProject
					// For now, we can use a default one and override background
					const config = serializeProjectConfiguration({
						...normalizeProject({
							// @ts-expect-error - partial config
							background: project.background,
							// @ts-expect-error - partial config
							camera: {
								source: { type: "none" },
							},
						}),
						// @ts-expect-error
						aspectRatio: project.aspectRatio,
					});

					await commands.updateScreenshotConfig(instance, config);
				},
				{ defer: true },
			),
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
			path: props.path,
			project,
			setProject,
			projectHistory,
			dialog,
			setDialog,
			latestFrame,
			editorInstance,
		};
	}, null!);
