import { Button } from "@cap/ui-solid";
import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { useSearchParams } from "@solidjs/router";
import { createQuery } from "@tanstack/solid-query";
import { emit } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, Submenu } from "@tauri-apps/api/menu";
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
	Suspense,
	Switch,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import ModeSelect from "~/components/ModeSelect";
import { authStore, generalSettingsStore } from "~/store";
import { createOptionsQuery } from "~/utils/queries";
import {
	commands,
	type DisplayId,
	events,
	type ScreenCaptureTarget,
	type TargetUnderCursor,
} from "~/utils/tauri";
import {
	RecordingOptionsProvider,
	useRecordingOptions,
} from "./(window-chrome)/OptionsContext";

const capitalize = (str: string) => {
	return str.charAt(0).toUpperCase() + str.slice(1);
};

export default function () {
	return (
		<RecordingOptionsProvider>
			<Inner />
		</RecordingOptionsProvider>
	);
}

function Inner() {
	const [params] = useSearchParams<{ displayId: DisplayId }>();
	const { rawOptions, setOptions } = createOptionsQuery();
	const [toggleModeSelect, setToggleModeSelect] = createSignal(false);

	const [targetUnderCursor, setTargetUnderCursor] =
		createStore<TargetUnderCursor>({
			display_id: null,
			window: null,
		});

	const unsubTargetUnderCursor = events.targetUnderCursor.listen((event) => {
		setTargetUnderCursor(reconcile(event.payload));
	});
	onCleanup(() => unsubTargetUnderCursor.then((unsub) => unsub()));

	const selectedWindow = createQuery(() => ({
		queryKey: ["selectedWindow", rawOptions.captureTarget],
		queryFn: async () => {
			if (rawOptions.captureTarget.variant !== "window") return null;
			const windowId = rawOptions.captureTarget.id;

			const windows = await commands.listCaptureWindows();
			const window = windows.find((w) => w.id === windowId);

			if (!window) return null;

			return {
				id: window.id,
				app_name: window.owner_name || window.name || "Unknown",
				bounds: window.bounds,
			};
		},
		enabled:
			rawOptions.captureTarget.variant === "window" &&
			rawOptions.targetMode === "window",
		staleTime: 5 * 1000,
	}));

	const windowToShow = () => {
		const hoveredWindow = targetUnderCursor.window;
		if (hoveredWindow) return hoveredWindow;
		if (rawOptions.captureTarget.variant === "window") {
			const selected = selectedWindow.data;
			if (selected) return selected;
		}
		return hoveredWindow;
	};

	const windowIcon = createQuery(() => ({
		queryKey: ["windowIcon", windowToShow()?.id],
		queryFn: async () => {
			const window = windowToShow();
			if (!window?.id) return null;
			return await commands.getWindowIcon(window.id.toString());
		},
		enabled: !!windowToShow()?.id,
		staleTime: 5 * 60 * 1000,
	}));

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
			params.displayId !== undefined && rawOptions.targetMode === "display",
	}));

	const [bounds, _setBounds] = createStore({
		position: { x: 0, y: 0 },
		size: { width: 400, height: 300 },
	});

	const setBounds = (newBounds: typeof bounds) => {
		const clampedBounds = {
			position: {
				x: Math.max(0, newBounds.position.x),
				y: Math.max(0, newBounds.position.y),
			},
			size: {
				width: Math.max(
					150,
					Math.min(
						window.innerWidth - Math.max(0, newBounds.position.x),
						newBounds.size.width,
					),
				),
				height: Math.max(
					150,
					Math.min(
						window.innerHeight - Math.max(0, newBounds.position.y),
						newBounds.size.height,
					),
				),
			},
		};

		_setBounds(clampedBounds);
	};

	// We do this so any Cap window, (or external in the case of a bug) that are focused can trigger the close shortcut
	const unsubOnEscapePress = events.onEscapePress.listen(() =>
		setOptions("targetMode", null),
	);
	onCleanup(() => unsubOnEscapePress.then((f) => f()));

	// This prevents browser keyboard shortcuts from firing.
	// Eg. on Windows Ctrl+P would open the print dialog without this
	createEventListener(document, "keydown", (e) => e.preventDefault());

	return (
		<Switch>
			<Match when={rawOptions.targetMode === "display"}>
				{(_) => (
					<div
						data-over={targetUnderCursor.display_id === params.displayId}
						class="relative w-screen h-screen flex flex-col items-center justify-center data-[over='true']:bg-blue-600/40 transition-colors"
					>
						<div class="absolute inset-0 bg-black/50 -z-10" />

						<Show when={displayInformation.data} keyed>
							{(display) => (
								<>
									<span class="mb-2 text-3xl font-semibold text-white">
										{display.name || "Monitor"}
									</span>
									<Show when={display.physical_size}>
										{(size) => (
											<span class="mb-2 text-xs text-white">
												{`${size().width}x${size().height} · ${display.refresh_rate}FPS`}
											</span>
										)}
									</Show>
								</>
							)}
						</Show>

						<Show when={toggleModeSelect()}>
							{/* Transparent overlay to capture outside clicks */}
							<div
								class="absolute inset-0 z-10"
								onClick={() => setToggleModeSelect(false)}
							/>
							<ModeSelect
								standalone
								onClose={() => setToggleModeSelect(false)}
							/>
						</Show>

						<RecordingControls
							setToggleModeSelect={setToggleModeSelect}
							target={{ variant: "display", id: params.displayId! }}
						/>
						<ShowCapFreeWarning isInstantMode={rawOptions.mode === "instant"} />
					</div>
				)}
			</Match>
			<Match
				when={
					rawOptions.targetMode === "window" &&
					(targetUnderCursor.display_id === params.displayId ||
						(rawOptions.captureTarget.variant === "window" &&
							selectedWindow.data))
				}
			>
				<Show when={windowToShow()} keyed>
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
								<div class="flex flex-col justify-center items-center text-white">
									<div class="w-32 h-32">
										<Suspense>
											<Show when={windowIcon.data}>
												{(icon) => (
													<img
														src={icon()}
														alt={`${windowUnderCursor.app_name} icon`}
														class="mb-3 w-full h-full rounded-lg animate-in fade-in"
													/>
												)}
											</Show>
										</Suspense>
									</div>
									<span class="mb-2 text-3xl font-semibold">
										{windowUnderCursor.app_name}
									</span>
									<span class="mb-2 text-xs">
										{`${windowUnderCursor.bounds.size.width}x${windowUnderCursor.bounds.size.height}`}
									</span>
								</div>
								<RecordingControls
									setToggleModeSelect={setToggleModeSelect}
									target={{
										variant: "window",
										id: windowUnderCursor.id,
									}}
								/>

								<Button
									variant="dark"
									size="sm"
									onClick={() => {
										setBounds(windowUnderCursor.bounds);
										setOptions({
											targetMode: "area",
										});
									}}
								>
									Adjust recording area
								</Button>
								<ShowCapFreeWarning
									isInstantMode={rawOptions.mode === "instant"}
								/>
							</div>
						</div>
					)}
				</Show>
			</Match>
			<Match when={rawOptions.targetMode === "area"}>
				{(_) => (
					<Show
						when={targetUnderCursor.display_id === params.displayId}
						fallback={
							<div class="w-screen h-screen flex flex-col items-center justify-center data-[over='true']:bg-blue-600/40 transition-colors relative cursor-crosshair bg-black/50" />
						}
					>
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

									let animationFrame: number | null = null;

									createRoot((dispose) => {
										createEventListenerMap(window, {
											mouseup: () => {
												if (animationFrame)
													cancelAnimationFrame(animationFrame);
												dispose();
											},
											mousemove: (moveEvent) => {
												if (animationFrame)
													cancelAnimationFrame(animationFrame);

												animationFrame = requestAnimationFrame(() => {
													onDrag(startBounds, {
														x: moveEvent.clientX - downEvent.clientX, // Remove Math.max constraint
														y: moveEvent.clientY - downEvent.clientY, // Remove Math.max constraint
													});
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
														width: Math.max(
															150,
															startBounds.size.width + delta.x,
														),
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
															newPosition.x =
																window.innerWidth - bounds.size.width;
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
													screen: params.displayId!,
													bounds,
												}}
											/>
											<ShowCapFreeWarning
												isInstantMode={rawOptions.mode === "instant"}
											/>
										</div>
									</div>

									<ResizeHandles />

									<p class="z-10 text-xl">Click and drag area to record</p>
								</div>
							);
						}}
					</Show>
				)}
			</Match>
		</Switch>
	);
}

function RecordingControls(props: {
	target: ScreenCaptureTarget;
	setToggleModeSelect?: (value: boolean) => void;
}) {
	const auth = authStore.createQuery();
	const { setOptions, rawOptions } = useRecordingOptions();

	const generalSetings = generalSettingsStore.createQuery();

	const menuModes = async () =>
		await Menu.new({
			items: [
				await CheckMenuItem.new({
					text: "Studio Mode",
					action: () => {
						setOptions("mode", "studio");
					},
					checked: rawOptions.mode === "studio",
				}),
				await CheckMenuItem.new({
					text: "Instant Mode",
					action: () => {
						setOptions("mode", "instant");
					},
					checked: rawOptions.mode === "instant",
				}),
			],
		});

	const countdownMenu = async () =>
		await Submenu.new({
			text: "Recording Countdown",
			items: [
				await CheckMenuItem.new({
					text: "Off",
					action: () => generalSettingsStore.set({ recordingCountdown: 0 }),
					checked:
						!generalSetings.data?.recordingCountdown ||
						generalSetings.data?.recordingCountdown === 0,
				}),
				await CheckMenuItem.new({
					text: "3 seconds",
					action: () => generalSettingsStore.set({ recordingCountdown: 3 }),
					checked: generalSetings.data?.recordingCountdown === 3,
				}),
				await CheckMenuItem.new({
					text: "5 seconds",
					action: () => generalSettingsStore.set({ recordingCountdown: 5 }),
					checked: generalSetings.data?.recordingCountdown === 5,
				}),
				await CheckMenuItem.new({
					text: "10 seconds",
					action: () => generalSettingsStore.set({ recordingCountdown: 10 }),
					checked: generalSetings.data?.recordingCountdown === 10,
				}),
			],
		});

	const preRecordingMenu = async () => {
		return await Menu.new({ items: [await countdownMenu()] });
	};

	return (
		<>
			<div class="flex gap-2.5 items-center p-2.5 my-2.5 rounded-xl border min-w-fit w-fit bg-gray-2 border-gray-4">
				<div
					onClick={() => setOptions("targetMode", null)}
					class="flex justify-center items-center rounded-full transition-opacity bg-gray-12 size-9 hover:opacity-80"
				>
					<IconCapX class="invert will-change-transform size-3 dark:invert-0" />
				</div>
				<div
					data-inactive={rawOptions.mode === "instant" && !auth.data}
					class="flex overflow-hidden flex-row h-11 rounded-full bg-blue-9 group"
					onClick={() => {
						if (rawOptions.mode === "instant" && !auth.data) {
							emit("start-sign-in");
							return;
						}

						commands.startRecording({
							capture_target: props.target,
							mode: rawOptions.mode,
							capture_system_audio: rawOptions.captureSystemAudio,
						});
					}}
				>
					<div class="flex items-center py-1 pl-4 transition-colors hover:bg-blue-10">
						{rawOptions.mode === "studio" ? (
							<IconCapFilmCut class="size-4" />
						) : (
							<IconCapInstant class="size-4" />
						)}
						<div class="flex flex-col mr-2 ml-3">
							<span class="text-sm font-medium text-white text-nowrap">
								{rawOptions.mode === "instant" && !auth.data
									? "Sign In To Use"
									: "Start Recording"}
							</span>
							<span class="text-xs flex items-center text-nowrap gap-1 transition-opacity duration-200 text-white font-light -mt-0.5 opacity-90">
								{`${capitalize(rawOptions.mode)} Mode`}
							</span>
						</div>
					</div>
					<div
						class="pl-2.5 group-hover:bg-blue-10 transition-colors pr-3 py-1.5 flex items-center"
						onClick={(e) => {
							e.stopPropagation();
							menuModes().then((menu) => menu.popup());
						}}
					>
						<IconCapCaretDown class="focus:rotate-90" />
					</div>
				</div>
				<div
					onClick={(e) => {
						e.stopPropagation();
						preRecordingMenu().then((menu) => menu.popup());
					}}
					class="flex justify-center items-center rounded-full border transition-opacity bg-gray-6 text-gray-12 size-9 hover:opacity-80"
				>
					<IconCapGear class="will-change-transform size-5" />
				</div>
			</div>
			<div
				onClick={() => props.setToggleModeSelect?.(true)}
				class="flex gap-1 items-center mb-5 transition-opacity duration-200 hover:opacity-60"
			>
				<IconCapInfo class="opacity-70 will-change-transform size-3" />
				<p class="text-sm text-white">
					<span class="opacity-70">What is </span>
					<span class="font-medium">{capitalize(rawOptions.mode)} Mode</span>?
				</p>
			</div>
		</>
	);
}

function ShowCapFreeWarning(props: { isInstantMode: boolean }) {
	const auth = authStore.createQuery();

	return (
		<Suspense>
			<Show when={props.isInstantMode && auth.data?.plan?.upgraded === false}>
				<p class="text-sm text-center text-white max-w-64">
					Instant Mode recordings are limited to 5 mins,{" "}
					<button
						class="underline"
						onClick={() => commands.showWindow("Upgrade")}
					>
						Upgrade to Pro
					</button>
				</p>
			</Show>
		</Suspense>
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
