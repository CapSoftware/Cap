import { ToggleButton as KToggleButton } from "@kobalte/core/toggle-button";
import { makePersisted } from "@solid-primitives/storage";
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
	Suspense,
} from "solid-js";
import { createStore } from "solid-js/store";
import { generalSettingsStore } from "~/store";
import { createCameraMutation } from "~/utils/queries";
import { createImageDataWS, createLazySignal } from "~/utils/socket";
import { commands } from "~/utils/tauri";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "./(window-chrome)/OptionsContext";

namespace CameraWindow {
	export type Size = "sm" | "lg";
	export type Shape = "round" | "square" | "full";
	export type State = {
		size: Size;
		shape: Shape;
		mirrored: boolean;
	};
}

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
	const { rawOptions } = useRecordingOptions();

	const [state, setState] = makePersisted(
		createStore<CameraWindow.State>({
			size: "sm",
			shape: "round",
			mirrored: false,
		}),
		{ name: "cameraWindowState" },
	);

	createEffect(() => commands.setCameraPreviewState(state));

	const [cameraPreviewReady] = createResource(() =>
		commands.awaitCameraPreviewReady(),
	);

	const setCamera = createCameraMutation();

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

	const [state, setState] = makePersisted(
		createStore<CameraWindow.State>({
			size: "sm",
			shape: "round",
			mirrored: false,
		}),
		{ name: "cameraWindowState" },
	);

	const [latestFrame, setLatestFrame] = createLazySignal<{
		width: number;
		data: ImageData;
	} | null>();

	const [frameDimensions, setFrameDimensions] = createSignal<{
		width: number;
		height: number;
	} | null>(null);

	function imageDataHandler(imageData: { width: number; data: ImageData }) {
		setLatestFrame(imageData);

		const currentDimensions = frameDimensions();
		if (
			!currentDimensions ||
			currentDimensions.width !== imageData.data.width ||
			currentDimensions.height !== imageData.data.height
		) {
			setFrameDimensions({
				width: imageData.data.width,
				height: imageData.data.height,
			});
		}

		const ctx = cameraCanvasRef?.getContext("2d");
		ctx?.putImageData(imageData.data, 0, 0);
	}

	const { cameraWsPort } = (window as any).__CAP__;
	const [ws, isConnected] = createImageDataWS(
		`ws://localhost:${cameraWsPort}`,
		imageDataHandler,
	);

	const reconnectInterval = setInterval(() => {
		if (!isConnected()) {
			console.log("Attempting to reconnect...");
			ws.close();

			const newWs = createImageDataWS(
				`ws://localhost:${cameraWsPort}`,
				imageDataHandler,
			);
			Object.assign(ws, newWs[0]);
		}
	}, 5000);

	onCleanup(() => {
		clearInterval(reconnectInterval);
		ws.close();
	});

	const [windowSize] = createResource(
		() =>
			[
				state.size,
				state.shape,
				frameDimensions()?.width,
				frameDimensions()?.height,
			] as const,
		async ([size, shape, frameWidth, frameHeight]) => {
			const monitor = await currentMonitor();

			const BAR_HEIGHT = 56;
			const base = size === "sm" ? 230 : 400;
			const aspect = frameWidth && frameHeight ? frameWidth / frameHeight : 1;
			const windowWidth =
				shape === "full" ? (aspect >= 1 ? base * aspect : base) : base;
			const windowHeight =
				shape === "full" ? (aspect >= 1 ? base : base / aspect) : base;
			const totalHeight = windowHeight + BAR_HEIGHT;

			if (!monitor) return;

			const scalingFactor = monitor.scaleFactor;
			const width = monitor.size.width / scalingFactor - windowWidth - 100;
			const height = monitor.size.height / scalingFactor - totalHeight - 100;

			const currentWindow = getCurrentWindow();
			currentWindow.setSize(new LogicalSize(windowWidth, totalHeight));
			currentWindow.setPosition(
				new LogicalPosition(
					width + monitor.position.toLogical(scalingFactor).x,
					height + monitor.position.toLogical(scalingFactor).y,
				),
			);

			return { width, height, size: base, windowWidth, windowHeight };
		},
	);

	let cameraCanvasRef: HTMLCanvasElement | undefined;

	const setCamera = createCameraMutation();

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
				<Suspense fallback={<CameraLoadingState />}>
					<Show when={latestFrame()}>
						{(latestFrame) => {
							const style = () => {
								const aspectRatio =
									latestFrame().data.width / latestFrame().data.height;

								const base = windowSize.latest?.size ?? 0;
								const winWidth = windowSize.latest?.windowWidth ?? base;
								const winHeight = windowSize.latest?.windowHeight ?? base;

								if (state.shape === "full") {
									return {
										width: `${winWidth}px`,
										height: `${winHeight}px`,
										transform: state.mirrored ? "scaleX(-1)" : "scaleX(1)",
									};
								}

								const size = (() => {
									if (aspectRatio > 1)
										return {
											width: base * aspectRatio,
											height: base,
										};
									else
										return {
											width: base,
											height: base * aspectRatio,
										};
								})();

								const left = aspectRatio > 1 ? (size.width - base) / 2 : 0;
								const top = aspectRatio > 1 ? 0 : (base - size.height) / 2;

								return {
									width: `${size.width}px`,
									height: `${size.height}px`,
									left: `-${left}px`,
									top: `-${top}px`,
									transform: state.mirrored ? "scaleX(-1)" : "scaleX(1)",
								};
							};

							return (
								<canvas
									data-tauri-drag-region
									class={cx("absolute")}
									style={style()}
									width={latestFrame().data.width}
									height={latestFrame().data.height}
									ref={cameraCanvasRef!}
								/>
							);
						}}
					</Show>
				</Suspense>
			</div>
		</div>
	);
}

function CameraLoadingState() {
	return (
		<div class="w-full flex-1 flex items-center justify-center">
			<div class="text-gray-11">Loading camera...</div>
		</div>
	);
}

function cameraBorderRadius(state: CameraWindow.State) {
	if (state.shape === "round") return "9999px";
	if (state.size === "sm") return "3rem";
	return "4rem";
}
