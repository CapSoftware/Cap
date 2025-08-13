import { Button } from "@cap/ui-solid";
import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { useSearchParams } from "@solidjs/router";
import { createQuery } from "@tanstack/solid-query";
import { Menu, Submenu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createRoot,
	createSignal,
	type JSX,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { createOptionsQuery } from "~/utils/queries";
import {
	commands,
	events,
	type ScreenCaptureTarget,
	type TargetUnderCursor,
} from "~/utils/tauri";
import DisplayArt from "../assets/illustrations/display.png";

export default function () {
	const [params] = useSearchParams<{ displayId: string }>();
	const { rawOptions, setOptions } = createOptionsQuery();

	const [targetUnderCursor, setTargetUnderCursor] =
		createStore<TargetUnderCursor>({
			display_id: null,
			window: null,
		});

	const unsubTargetUnderCursor = events.targetUnderCursor.listen((event) => {
		setTargetUnderCursor(reconcile(event.payload));
	});
	onCleanup(() => unsubTargetUnderCursor.then((unsub) => unsub()));

	const displayInformation = createQuery(() => ({
		queryKey: ["displayId", params.displayId],
		queryFn: async () => {
			if (!params.displayId) return null;
			try {
				const info = await commands.displayInformation(params.displayId);
				return info;
			} catch (error) {
				console.error("Failed to fetch screen information:", error);
				return null;
			}
		},
		enabled:
			params.displayId !== undefined && rawOptions.targetMode === "screen",
	}));

	const [bounds, _setBounds] = createStore({
		position: { x: 0, y: 0 },
		size: { width: 400, height: 300 },
	});

	const setBounds = (newBounds: typeof bounds) => {
		newBounds.position.x = Math.max(0, newBounds.position.x);
		newBounds.position.y = Math.max(0, newBounds.position.y);
		newBounds.size.width = Math.min(
			window.innerWidth - newBounds.position.x,
			newBounds.size.width,
		);
		newBounds.size.height = Math.min(
			window.innerHeight - newBounds.position.y,
			newBounds.size.height,
		);

		_setBounds(newBounds);
	};

	// We do this so any Cap window, (or external in the case of a bug) that are focused can trigger the close shortcut
	const unsubOnEscapePress = events.onEscapePress.listen(() =>
		setOptions("targetMode", null),
	);
	onCleanup(() => unsubOnEscapePress.then((f) => f()));

	createEffect(() => {
		if (rawOptions.captureTarget === undefined) getCurrentWindow().close();
	});

	// This prevents browser keyboard shortcuts from firing.
	// Eg. on Windows Ctrl+P would open the print dialog without this
	createEventListener(document, "keydown", (e) => e.preventDefault());

	return (
		<Switch>
			<Match when={rawOptions.targetMode === "screen"}>
				{(_) => (
					<Show when={displayInformation.data} keyed>
						{(display) => (
							<div
								data-over="true"
								class="w-screen h-screen flex flex-col items-center justify-center bg-black/50 data-[over='true']:bg-blue-600/30 transition-colors"
							>
								<img src={DisplayArt} class="w-full max-w-[160px] mb-5" />
								<p class="mb-2 text-3xl font-semibold">{display.name}</p>
								<p class="mb-2 text-base">
									{`${display.physical_size.width}x${display.physical_size.height} · ${display.refresh_rate}FPS`}
								</p>

								<RecordingControls
									target={{
										variant: "screen",
										id: getDisplayId(params.displayId),
									}}
								/>
							</div>
						)}
					</Show>
				)}
			</Match>
			<Match
				when={
					rawOptions.targetMode === "window" &&
					targetUnderCursor.display_id === params.displayId
				}
			>
				<Show when={targetUnderCursor.window} keyed>
					{(windowUnderCursor) => (
						<div
							data-over={targetUnderCursor.display_id === params.displayId}
							class="relative w-screen h-screen bg-black/50"
						>
							<div
								class="flex absolute flex-col justify-center items-center bg-blue-600/40"
								style={{
									width: `${windowUnderCursor.bounds.size.width}px`,
									height: `${windowUnderCursor.bounds.size.height}px`,
									left: `${windowUnderCursor.bounds.position.x}px`,
									top: `${windowUnderCursor.bounds.position.y}px`,
								}}
							>
								<div class="flex flex-col justify-center items-center">
									<Show when={windowUnderCursor.icon}>
										{(icon) => (
											<img
												src={icon()}
												alt={`${windowUnderCursor.app_name} icon`}
												class="mb-3 w-32 h-32 rounded-lg"
											/>
										)}
									</Show>
									<span class="mb-2 text-3xl font-semibold">
										{windowUnderCursor.app_name}
									</span>
									<span class="mb-2 text-xs">
										{`${windowUnderCursor.bounds.size.width}x${windowUnderCursor.bounds.size.height}`}
									</span>
								</div>
								<RecordingControls
									target={{
										variant: "window",
										id: Number(windowUnderCursor.id),
									}}
								/>

								<Button
									variant="primary"
									size="sm"
									class="mt-4"
									onClick={() => {
										setBounds(windowUnderCursor.bounds);
										setOptions({
											targetMode: "area",
										});
									}}
								>
									Adjust recording area
								</Button>
							</div>
						</div>
					)}
				</Show>
			</Match>
			<Match when={rawOptions.targetMode === "area"}>
				{(_) => {
					const [dragging, setDragging] = createSignal(false);
					// Track whether the controls should be placed above the selection to avoid window bottom overflow
					const [placeControlsAbove, setPlaceControlsAbove] =
						createSignal(false);
					let controlsEl: HTMLDivElement | undefined;

					// Recompute placement when bounds change or window resizes
					createEffect(() => {
						// Read reactive dependencies
						const top = bounds.position.y;
						const height = bounds.size.height;
						// Measure controls height (fallback to 64px if not yet mounted)
						const ctrlH = controlsEl?.offsetHeight ?? 64;
						const margin = 16;

						const wouldOverflow =
							top + height + margin + ctrlH > window.innerHeight;
						setPlaceControlsAbove(wouldOverflow);
					});

					// Handle window resize to keep placement responsive
					createRoot((dispose) => {
						const onResize = () => {
							const ctrlH = controlsEl?.offsetHeight ?? 64;
							const margin = 16;
							const wouldOverflow =
								bounds.position.y + bounds.size.height + margin + ctrlH >
								window.innerHeight;
							setPlaceControlsAbove(wouldOverflow);
						};
						window.addEventListener("resize", onResize);
						onCleanup(() => {
							window.removeEventListener("resize", onResize);
							dispose();
						});
					});

					function createOnMouseDown(
						onDrag: (
							startBounds: typeof bounds,
							delta: { x: number; y: number },
						) => void,
					) {
						return (downEvent: MouseEvent) => {
							const startBounds = {
								position: { ...bounds.position },
								size: { ...bounds.size },
							};

							createRoot((dispose) => {
								createEventListenerMap(window, {
									mouseup: () => dispose(),
									mousemove: (moveEvent) => {
										onDrag(startBounds, {
											x: Math.max(
												-startBounds.position.x,
												moveEvent.clientX - downEvent.clientX,
											),
											y: Math.max(
												-startBounds.position.y,
												moveEvent.clientY - downEvent.clientY,
											),
										});
									},
								});
							});
						};
					}

					function ResizeHandles() {
						return (
							<>
								{/* Top Left Button */}
								<ResizeHandle
									class="cursor-nw-resize"
									style={{
										left: `${bounds.position.x + 1}px`,
										top: `${bounds.position.y + 1}px`,
									}}
									onMouseDown={createOnMouseDown((startBounds, delta) => {
										const width = startBounds.size.width - delta.x;
										const limitedWidth = Math.max(width, 150);

										const height = startBounds.size.height - delta.y;
										const limitedHeight = Math.max(height, 150);

										setBounds({
											position: {
												x:
													startBounds.position.x +
													delta.x -
													(limitedWidth - width),
												y:
													startBounds.position.y +
													delta.y -
													(limitedHeight - height),
											},
											size: {
												width: limitedWidth,
												height: limitedHeight,
											},
										});
									})}
								/>

								{/* Top Right Button */}
								<ResizeHandle
									class="cursor-ne-resize"
									style={{
										left: `${bounds.position.x + bounds.size.width - 1}px`,
										top: `${bounds.position.y + 1}px`,
									}}
									onMouseDown={createOnMouseDown((startBounds, delta) => {
										const width = startBounds.size.width + delta.x;
										const limitedWidth = Math.max(width, 150);

										const height = startBounds.size.height - delta.y;
										const limitedHeight = Math.max(height, 150);

										setBounds({
											position: {
												x: startBounds.position.x,
												y:
													startBounds.position.y +
													delta.y -
													(limitedHeight - height),
											},
											size: {
												width: limitedWidth,
												height: limitedHeight,
											},
										});
									})}
								/>

								{/* Bottom Left Button */}
								<ResizeHandle
									class="cursor-sw-resize"
									style={{
										left: `${bounds.position.x + 1}px`,
										top: `${bounds.position.y + bounds.size.height - 1}px`,
									}}
									onMouseDown={createOnMouseDown((startBounds, delta) => {
										const width = startBounds.size.width - delta.x;
										const limitedWidth = Math.max(width, 150);

										const height = startBounds.size.height + delta.y;
										const limitedHeight = Math.max(height, 150);

										setBounds({
											position: {
												x:
													startBounds.position.x +
													delta.x -
													(limitedWidth - width),
												y: startBounds.position.y,
											},
											size: {
												width: limitedWidth,
												height: limitedHeight,
											},
										});
									})}
								/>

								{/* Bottom Right Button */}
								<ResizeHandle
									class="cursor-se-resize"
									style={{
										left: `${bounds.position.x + bounds.size.width - 1}px`,
										top: `${bounds.position.y + bounds.size.height - 1}px`,
									}}
									onMouseDown={createOnMouseDown((startBounds, delta) => {
										const width = startBounds.size.width + delta.x;
										const limitedWidth = Math.max(width, 150);

										const height = startBounds.size.height + delta.y;
										const limitedHeight = Math.max(height, 150);

										setBounds({
											position: {
												x: startBounds.position.x,
												y: startBounds.position.y,
											},
											size: {
												width: limitedWidth,
												height: limitedHeight,
											},
										});
									})}
								/>

								{/* Top Edge Button */}
								<ResizeHandle
									class="cursor-n-resize"
									style={{
										left: `${bounds.position.x + bounds.size.width / 2}px`,
										top: `${bounds.position.y + 1}px`,
									}}
									onMouseDown={createOnMouseDown((startBounds, delta) => {
										const height = startBounds.size.height - delta.y;
										const limitedHeight = Math.max(height, 150);

										setBounds({
											position: {
												x: startBounds.position.x,
												y:
													startBounds.position.y +
													delta.y -
													(limitedHeight - height),
											},
											size: {
												width: startBounds.size.width,
												height: limitedHeight,
											},
										});
									})}
								/>

								{/* Right Edge Button */}
								<ResizeHandle
									class="cursor-e-resize"
									style={{
										left: `${bounds.position.x + bounds.size.width - 1}px`,
										top: `${bounds.position.y + bounds.size.height / 2}px`,
									}}
									onMouseDown={createOnMouseDown((startBounds, delta) => {
										setBounds({
											position: {
												x: startBounds.position.x,
												y: startBounds.position.y,
											},
											size: {
												width: Math.max(150, startBounds.size.width + delta.x),
												height: startBounds.size.height,
											},
										});
									})}
								/>

								{/* Bottom Edge Button */}
								<ResizeHandle
									class="cursor-s-resize"
									style={{
										left: `${bounds.position.x + bounds.size.width / 2}px`,
										top: `${bounds.position.y + bounds.size.height - 1}px`,
									}}
									onMouseDown={createOnMouseDown((startBounds, delta) => {
										setBounds({
											position: {
												x: startBounds.position.x,
												y: startBounds.position.y,
											},
											size: {
												width: startBounds.size.width,
												height: Math.max(
													150,
													startBounds.size.height + delta.y,
												),
											},
										});
									})}
								/>

								{/* Left Edge Button */}
								<ResizeHandle
									class="cursor-w-resize"
									style={{
										left: `${bounds.position.x + 1}px`,
										top: `${bounds.position.y + bounds.size.height / 2}px`,
									}}
									onMouseDown={createOnMouseDown((startBounds, delta) => {
										const width = startBounds.size.width - delta.x;
										const limitedWidth = Math.max(150, width);

										setBounds({
											position: {
												x:
													startBounds.position.x +
													delta.x -
													(limitedWidth - width),
												y: startBounds.position.y,
											},
											size: {
												width: limitedWidth,
												height: startBounds.size.height,
											},
										});
									})}
								/>
							</>
						);
					}

					function Occluders() {
						return (
							<>
								{/* Left */}
								<div
									class="absolute top-0 bottom-0 left-0 bg-black/50"
									style={{ width: `${bounds.position.x}px` }}
								/>
								{/* Right */}
								<div
									class="absolute top-0 right-0 bottom-0 bg-black/50"
									style={{
										width: `${
											window.innerWidth -
											(bounds.size.width + bounds.position.x)
										}px`,
									}}
								/>
								{/* Top center */}
								<div
									class="absolute top-0 bg-black/50"
									style={{
										left: `${bounds.position.x}px`,
										width: `${bounds.size.width}px`,
										height: `${bounds.position.y}px`,
									}}
								/>
								{/* Bottom center */}
								<div
									class="absolute bottom-0 bg-black/50"
									style={{
										left: `${bounds.position.x}px`,
										width: `${bounds.size.width}px`,
										height: `${
											window.innerHeight -
											(bounds.size.height + bounds.position.y)
										}px`,
									}}
								/>
							</>
						);
					}

					return (
						<div class="w-screen h-screen flex flex-col items-center justify-center data-[over='true']:bg-blue-600/40 transition-colors relative cursor-crosshair">
							<Occluders />

							<div
								class={cx(
									"flex absolute flex-col items-center",
									dragging() ? "cursor-grabbing" : "cursor-grab",
								)}
								style={{
									width: `${bounds.size.width}px`,
									height: `${bounds.size.height}px`,
									left: `${bounds.position.x}px`,
									top: `${bounds.position.y}px`,
								}}
								onMouseDown={(downEvent) => {
									setDragging(true);
									const startPosition = { ...bounds.position };

									createRoot((dispose) => {
										createEventListenerMap(window, {
											mousemove: (moveEvent) => {
												const newPosition = {
													x:
														startPosition.x +
														moveEvent.clientX -
														downEvent.clientX,
													y:
														startPosition.y +
														moveEvent.clientY -
														downEvent.clientY,
												};

												if (newPosition.x < 0) newPosition.x = 0;
												if (newPosition.y < 0) newPosition.y = 0;
												if (
													newPosition.x + bounds.size.width >
													window.innerWidth
												)
													newPosition.x = window.innerWidth - bounds.size.width;
												if (
													newPosition.y + bounds.size.height >
													window.innerHeight
												)
													newPosition.y =
														window.innerHeight - bounds.size.height;

												_setBounds("position", newPosition);
											},
											mouseup: () => {
												setDragging(false);
												dispose();
											},
										});
									});
								}}
							>
								<div
									ref={controlsEl}
									class={cx(
										"flex absolute flex-col items-center m-2",
										placeControlsAbove() ? "bottom-full" : "top-full",
									)}
									style={{ width: `${bounds.size.width}px` }}
								>
									<RecordingControls
										target={{
											variant: "area",
											screen: Number(params.displayId),
											bounds: {
												x: bounds.position.x,
												y: bounds.position.y,
												width: bounds.size.width,
												height: bounds.size.height,
											},
										}}
									/>
								</div>
							</div>

							<ResizeHandles />

							<p class="z-10 text-xl">Click and drag area to record</p>
						</div>
					);
				}}
			</Match>
		</Switch>
	);
}

function RecordingControls(props: { target: ScreenCaptureTarget }) {
	const { rawOptions, setOptions } = createOptionsQuery();

	const capitalize = (str: string) => {
		return str.charAt(0).toUpperCase() + str.slice(1);
	};

	const menuModes = async () => {
		return await Menu.new({
			items: [
				{
					id: "studio",
					text: "Studio Mode",
					action: () => {
						setOptions("mode", "studio");
					},
				},
				{
					id: "instant",
					text: "Instant Mode",
					action: () => {
						setOptions("mode", "instant");
					},
				},
			],
		});
	};

	const countdownMenu = async () =>
		await Submenu.new({
			text: "Recording Countdown",
			items: [
				{
					id: "countdown-three",
					text: "3 seconds",
					action: () => {
						console.log("Countdown 3 clicked");
					},
				},
				{
					id: "countdown-five",
					text: "5 seconds",
					action: () => {
						console.log("Countdown 5 clicked");
					},
				},
				{
					id: "countdown-ten",
					text: "10 seconds",
					action: () => {
						console.log("Countdown 10 clicked");
					},
				},
			],
		});
	const preRecordingMenu = async () => {
		return await Menu.new({
			items: [await countdownMenu()],
		});
	};

	return (
		<div class="flex gap-2.5 items-center p-3 my-4 rounded-xl border min-w-fit w-fit bg-gray-2 border-gray-4">
			<div
				onClick={() => setOptions("targetMode", null)}
				class="flex justify-center items-center bg-white rounded-full transition-opacity cursor-pointer size-9 hover:opacity-80"
			>
				<IconCapX class="will-change-transform size-3" />
			</div>
			<div
				class="flex items-center px-4 py-2 rounded-full transition-colors cursor-pointer bg-blue-9 hover:bg-blue-10"
				onClick={() => {
					commands.startRecording({
						capture_target: props.target,
						mode: rawOptions.mode,
						capture_system_audio: rawOptions.captureSystemAudio,
					});
				}}
			>
				{rawOptions.mode === "studio" ? (
					<IconCapFilmCut class="mr-2 size-4" />
				) : (
					<IconCapInstant class="mr-2 size-4" />
				)}
				<p class="text-sm text-white text-nowrap">
					<span class="font-medium">Start Recording</span>:
				</p>
				<div
					onClick={(e) => {
						e.stopPropagation();
						menuModes().then((menu) => menu.popup());
					}}
					class="flex gap-1.5 items-center"
				>
					<p class="pl-0.5 text-sm text-nowrap text-white">
						{capitalize(rawOptions.mode) + " Mode"}
					</p>
					<IconCapCaretDown class="focus:rotate-90" />
				</div>
			</div>
			<div
				onClick={(e) => {
					e.stopPropagation();
					preRecordingMenu().then((menu) => menu.popup());
				}}
				class="flex justify-center items-center rounded-full border transition-opacity cursor-pointer bg-gray-6 border-gray-7 size-9 hover:opacity-80"
			>
				<IconCapGear class="will-change-transform size-5" />
			</div>
		</div>
	);
}

function ResizeHandle(
	props: Omit<ComponentProps<"button">, "style"> & {
		style?: JSX.CSSProperties;
	},
) {
	return (
		<button
			{...props}
			class={cx(
				"size-3 bg-black rounded-full absolute border-[1.2px] border-white",
				props.class,
			)}
			style={{ ...props.style, transform: "translate(-50%, -50%)" }}
		/>
	);
}

function getDisplayId(displayId: string | undefined) {
	const id = Number(displayId);
	if (Number.isNaN(id)) return 0;
	return id;
}
