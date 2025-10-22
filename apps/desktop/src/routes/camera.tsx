import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { listen } from "@tauri-apps/api/event";
import {
	currentMonitor,
	getCurrentWindow,
	LogicalPosition,
	LogicalSize,
} from "@tauri-apps/api/window";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createResource,
	createSignal,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import {
	type CameraPreviewState,
	CameraPreviewSurface,
	computeCameraPreviewGeometry,
	createCameraPreviewState,
	createCameraPreviewStream,
} from "~/components/camera/camera-preview";
import { generalSettingsStore } from "~/store";
import { createCameraMutation } from "~/utils/queries";
import { commands } from "~/utils/tauri";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "./(window-chrome)/OptionsContext";

namespace CameraWindow {
	export type Size = CameraPreviewState["size"];
	export type Shape = CameraPreviewState["shape"];
	export type State = CameraPreviewState;
}

type CameraWindowStage = "overlay" | "recording" | "default";

type CameraWindowBoundsPayload = {
	stage: CameraWindowStage;
	bounds?: {
		position: { x: number; y: number };
		size: { width: number; height: number };
		barHeight: number;
	};
};

export default function () {
	document.documentElement.classList.toggle("dark", true);

	const generalSettings = generalSettingsStore.createQuery();
	const isNativePreviewEnabled =
		generalSettings.data?.enableNativeCameraPreview || false;

	return (
		<RecordingOptionsProvider>
			<Show
				when={isNativePreviewEnabled}
				fallback={<LegacyCameraPreviewPage />}
			>
				<NativeCameraPreviewPage />
			</Show>
		</RecordingOptionsProvider>
	);
}

function NativeCameraPreviewPage() {
	const [state, setState] = createCameraPreviewState();
	const [, setStage] = createSignal<CameraWindowStage>("default");

	createEffect(() => commands.setCameraPreviewState(state));

	const [cameraPreviewReady] = createResource(() =>
		commands.awaitCameraPreviewReady(),
	);

	const setCamera = createCameraMutation();

	const applyStage = async (payload: CameraWindowBoundsPayload) => {
		const window = getCurrentWindow();
		if (payload.stage === "overlay" || payload.stage === "recording") {
			setStage(payload.stage);
			if (payload.bounds) {
				const totalHeight =
					payload.bounds.size.height + payload.bounds.barHeight;
				await window.setSize(
					new LogicalSize(payload.bounds.size.width, totalHeight),
				);
				await window.setPosition(
					new LogicalPosition(
						payload.bounds.position.x,
						payload.bounds.position.y,
					),
				);
			}
			await window.setAlwaysOnTop(payload.stage === "overlay");
			return;
		}

		setStage("default");
		await window.setAlwaysOnTop(false);
	};

	onMount(() => {
		const promise = listen<CameraWindowBoundsPayload>(
			"camera-window:set-bounds",
			(event) => {
				void applyStage(event.payload);
			},
		);
		onCleanup(() => {
			promise.then((unlisten) => unlisten());
		});
	});

	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-col w-screen h-screen cursor-move group"
		>
			<div class="h-13">
				<div class="flex flex-row justify-center items-center">
					<div class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10">
						<ControlButton onClick={() => setCamera.mutate(null)}>
							<IconCapCircleX class="size-5.5" />
						</ControlButton>
						<ControlButton
							pressed={state.size === "lg"}
							onClick={() => {
								setState("size", (s) => (s === "sm" ? "lg" : "sm"));
							}}
						>
							<IconCapEnlarge class="size-5.5" />
						</ControlButton>
						<ControlButton
							pressed={state.shape !== "round"}
							onClick={() =>
								setState("shape", (s) =>
									s === "round" ? "square" : s === "square" ? "full" : "round",
								)
							}
						>
							{state.shape === "round" && <IconCapCircle class="size-5.5" />}
							{state.shape === "square" && <IconCapSquare class="size-5.5" />}
							{state.shape === "full" && (
								<IconLucideRectangleHorizontal class="size-5.5" />
							)}
						</ControlButton>
						<ControlButton
							pressed={state.mirrored}
							onClick={() => setState("mirrored", (m) => !m)}
						>
							<IconCapArrows class="size-5.5" />
						</ControlButton>
					</div>
				</div>
			</div>

			{/* The camera preview is rendered in Rust by wgpu */}
			<Show when={cameraPreviewReady.loading}>
				<div class="w-full flex-1 flex items-center justify-center">
					<div class="text-gray-11">Loading camera...</div>
				</div>
			</Show>
		</div>
	);
}

function ControlButton(
	props: Omit<ComponentProps<typeof KToggleButton>, "type" | "class"> & {
		active?: boolean;
	},
) {
	return (
		<KToggleButton
			type="button"
			class="p-2 rounded-lg ui-pressed:bg-gray-3 ui-pressed:text-gray-12"
			{...props}
		/>
	);
}

// Legacy stuff below

function LegacyCameraPreviewPage() {
	const { rawOptions } = useRecordingOptions();

	const [state, setState] = createCameraPreviewState();
	const [stage, setStage] = createSignal<CameraWindowStage>("default");
	const [isExternallyManaged, setExternallyManaged] = createSignal(false);

	const { latestFrame, frameDimensions, setCanvasRef } =
		createCameraPreviewStream();

	const [_windowSize] = createResource(
		() =>
			[
				state.size,
				state.shape,
				frameDimensions()?.width,
				frameDimensions()?.height,
				isExternallyManaged(),
			] as const,
		async ([, , frameWidth, frameHeight, externallyManaged]) => {
			if (externallyManaged) return;
			const monitor = await currentMonitor();
			if (!monitor) return;

			const geometry = computeCameraPreviewGeometry(
				state,
				frameWidth && frameHeight
					? { width: frameWidth, height: frameHeight }
					: null,
			);
			const BAR_HEIGHT = 56;
			const totalHeight = geometry.windowHeight + BAR_HEIGHT;

			const scalingFactor = monitor.scaleFactor;
			const width =
				monitor.size.width / scalingFactor - geometry.windowWidth - 100;
			const height = monitor.size.height / scalingFactor - totalHeight - 100;

			const currentWindow = getCurrentWindow();
			currentWindow.setSize(new LogicalSize(geometry.windowWidth, totalHeight));
			currentWindow.setPosition(
				new LogicalPosition(
					width + monitor.position.toLogical(scalingFactor).x,
					height + monitor.position.toLogical(scalingFactor).y,
				),
			);

			return {
				width,
				height,
				size: geometry.base,
				windowWidth: geometry.windowWidth,
				windowHeight: geometry.windowHeight,
			};
		},
	);

	const setCamera = createCameraMutation();

	const applyStage = async (payload: CameraWindowBoundsPayload) => {
		const window = getCurrentWindow();
		if (payload.stage === "overlay" || payload.stage === "recording") {
			setStage(payload.stage);
			setExternallyManaged(true);
			if (payload.bounds) {
				const totalHeight =
					payload.bounds.size.height + payload.bounds.barHeight;
				await window.setSize(
					new LogicalSize(payload.bounds.size.width, totalHeight),
				);
				await window.setPosition(
					new LogicalPosition(
						payload.bounds.position.x,
						payload.bounds.position.y,
					),
				);
			}
			await window.setAlwaysOnTop(payload.stage === "overlay");
			return;
		}

		setStage("default");
		setExternallyManaged(false);
		await window.setAlwaysOnTop(false);
	};

	onMount(() => {
		const promise = listen<CameraWindowBoundsPayload>(
			"camera-window:set-bounds",
			(event) => {
				void applyStage(event.payload);
			},
		);
		onCleanup(() => {
			promise.then((unlisten) => unlisten());
		});
	});

	createEffect(
		on(
			() => rawOptions.cameraLabel,
			(label) => {
				if (label === null) getCurrentWindow().close();
			},
			{ defer: true },
		),
	);

	onMount(() => getCurrentWindow().show());

	return (
		<div
			data-tauri-drag-region
			class="flex relative flex-col w-screen h-screen cursor-move group"
			style={{ "border-radius": cameraBorderRadius(state) }}
		>
			<div class="h-14">
				<div class="flex flex-row justify-center items-center">
					<div class="flex flex-row gap-[0.25rem] p-[0.25rem] opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 rounded-xl transition-[opacity,transform] bg-gray-1 border border-white-transparent-20 text-gray-10">
						<ControlButton onClick={() => setCamera.mutate(null)}>
							<IconCapCircleX class="size-5.5" />
						</ControlButton>
						<ControlButton
							pressed={state.size === "lg"}
							onClick={() => {
								setState("size", (s) => (s === "sm" ? "lg" : "sm"));
							}}
						>
							<IconCapEnlarge class="size-5.5" />
						</ControlButton>
						<ControlButton
							pressed={state.shape !== "round"}
							onClick={() =>
								setState("shape", (s) =>
									s === "round" ? "square" : s === "square" ? "full" : "round",
								)
							}
						>
							{state.shape === "round" && <IconCapCircle class="size-5.5" />}
							{state.shape === "square" && <IconCapSquare class="size-5.5" />}
							{state.shape === "full" && (
								<IconLucideRectangleHorizontal class="size-5.5" />
							)}
						</ControlButton>
						<ControlButton
							pressed={state.mirrored}
							onClick={() => setState("mirrored", (m) => !m)}
						>
							<IconCapArrows class="size-5.5" />
						</ControlButton>
					</div>
				</div>
			</div>
			<div
				class={cx(
					"flex flex-col flex-1 relative overflow-hidden pointer-events-none border-none shadow-lg bg-gray-1 text-gray-12",
					state.shape === "round" ? "rounded-full" : "rounded-3xl",
				)}
				data-tauri-drag-region
			>
				<CameraPreviewSurface
					state={state}
					latestFrame={latestFrame}
					frameDimensions={frameDimensions}
					setCanvasRef={setCanvasRef}
				/>
			</div>
		</div>
	);
}

function cameraBorderRadius(state: CameraWindow.State) {
	if (state.shape === "round") return "9999px";
	if (state.size === "sm") return "3rem";
	return "4rem";
}
