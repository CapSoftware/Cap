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

const SQUIRCLE_CLIP_PATH =
	"path('M100.0000% 50.0000% L99.9699% 38.9244% L99.8795% 34.3462% L99.7287% 30.8473% L99.5173% 27.9155% L99.2451% 25.3535% L98.9117% 23.0610% L98.5166% 20.9789% L98.0593% 19.0693% L97.5392% 17.3062% L96.9553% 15.6708% L96.3068% 14.1495% L95.5925% 12.7317% L94.8109% 11.4092% L93.9605% 10.1756% L93.0393% 9.0256% L92.0448% 7.9552% L90.9744% 6.9607% L89.8244% 6.0395% L88.5908% 5.1891% L87.2683% 4.4075% L85.8505% 3.6932% L84.3292% 3.0447% L82.6938% 2.4608% L80.9307% 1.9407% L79.0211% 1.4834% L76.9390% 1.0883% L74.6465% 0.7549% L72.0845% 0.4827% L69.1527% 0.2713% L65.6538% 0.1205% L61.0756% 0.0301% L50.0000% 0.0000% L38.9244% 0.0301% L34.3462% 0.1205% L30.8473% 0.2713% L27.9155% 0.4827% L25.3535% 0.7549% L23.0610% 1.0883% L20.9789% 1.4834% L19.0693% 1.9407% L17.3062% 2.4608% L15.6708% 3.0447% L14.1495% 3.6932% L12.7317% 4.4075% L11.4092% 5.1891% L10.1756% 6.0395% L9.0256% 6.9607% L7.9552% 7.9552% L6.9607% 9.0256% L6.0395% 10.1756% L5.1891% 11.4092% L4.4075% 12.7317% L3.6932% 14.1495% L3.0447% 15.6708% L2.4608% 17.3062% L1.9407% 19.0693% L1.4834% 20.9789% L1.0883% 23.0610% L0.7549% 25.3535% L0.4827% 27.9155% L0.2713% 30.8473% L0.1205% 34.3462% L0.0301% 38.9244% L0.0000% 50.0000% L0.0301% 61.0756% L0.1205% 65.6538% L0.2713% 69.1527% L0.4827% 72.0845% L0.7549% 74.6465% L1.0883% 76.9390% L1.4834% 79.0211% L1.9407% 80.9307% L2.4608% 82.6938% L3.0447% 84.3292% L3.6932% 85.8505% L4.4075% 87.2683% L5.1891% 88.5908% L6.0395% 89.8244% L6.9607% 90.9744% L7.9552% 92.0448% L9.0256% 93.0393% L10.1756% 93.9605% L11.4092% 94.8109% L12.7317% 95.5925% L14.1495% 96.3068% L15.6708% 96.9553% L17.3062% 97.5392% L19.0693% 98.0593% L20.9789% 98.5166% L23.0610% 98.9117% L25.3535% 99.2451% L27.9155% 99.5173% L30.8473% 99.7287% L34.3462% 99.8795% L38.9244% 99.9699% L50.0000% 100.0000% L61.0756% 99.9699% L65.6538% 99.8795% L69.1527% 99.7287% L72.0845% 99.5173% L74.6465% 99.2451% L76.9390% 98.9117% L79.0211% 98.5166% L80.9307% 98.0593% L82.6938% 97.5392% L84.3292% 96.9553% L85.8505% 96.3068% L87.2683% 95.5925% L88.5908% 94.8109% L89.8244% 93.9605% L90.9744% 93.0393% L92.0448% 92.0448% L93.0393% 90.9744% L93.9605% 89.8244% L94.8109% 88.5908% L95.5925% 87.2683% L96.3068% 85.8505% L96.9553% 84.3292% L97.5392% 82.6938% L98.0593% 80.9307% L98.5166% 79.0211% L98.9117% 76.9390% L99.2451% 74.6465% L99.5173% 72.0845% L99.7287% 69.1527% L99.8795% 65.6538% L99.9699% 61.0756% L100.0000% 50.0000% Z')";

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
					state.shape === "round"
						? "rounded-full"
						: state.shape === "square"
							? ""
							: "rounded-3xl",
				)}
				style={{
					"clip-path":
						state.shape === "square" ? SQUIRCLE_CLIP_PATH : undefined,
					"-webkit-clip-path":
						state.shape === "square" ? SQUIRCLE_CLIP_PATH : undefined,
				}}
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
