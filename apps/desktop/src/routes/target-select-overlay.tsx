import { Button } from "@cap/ui-solid";
import { createEventListener } from "@solid-primitives/event-listener";
import { createElementSize } from "@solid-primitives/resize-observer";
import { useSearchParams } from "@solidjs/router";
import { createMutation, useQuery } from "@tanstack/solid-query";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, type PhysicalPosition, type PhysicalSize } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type as ostype } from "@tauri-apps/plugin-os";
import {
	createEffect,
	createMemo,
	createSignal,
	Match,
	mergeProps,
	onCleanup,
	onMount,
	Show,
	Suspense,
	Switch,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import toast from "solid-toast";
import {
	CROP_ZERO,
	type CropBounds,
	Cropper,
	type CropperRef,
	createCropOptionsMenuItems,
	type Ratio,
} from "~/components/Cropper";
import ModeSelect from "~/components/ModeSelect";
import SelectionHint from "~/components/selection-hint";
import { authStore, generalSettingsStore } from "~/store";
import { ArrowUpRight, DoubleArrowSwitcher, RecordFill } from "~/icons";
import {
	createCameraMutation,
	createOptionsQuery,
	createOrganizationsQuery,
	createWorkspacesQuery,
	listAudioDevices,
	listVideoDevices,
} from "~/utils/queries";
import {
	type CameraInfo,
	commands,
	type DeviceOrModelID,
	type DisplayId,
	events,
	type ScreenCaptureTarget,
	type TargetUnderCursor,
} from "~/utils/tauri";
import CameraSelect from "./(window-chrome)/new-main/CameraSelect";
import MicrophoneSelect from "./(window-chrome)/new-main/MicrophoneSelect";
import { RecordingOptionsProvider, useRecordingOptions } from "./(window-chrome)/OptionsContext";

const MIN_SIZE = { width: 150, height: 150 };

const capitalize = (str: string) => {
	return str.charAt(0).toUpperCase() + str.slice(1);
};

const findCamera = (cameras: CameraInfo[], id?: DeviceOrModelID | null) => {
	if (!id) return undefined;
	return cameras.find((camera) =>
		"DeviceID" in id ? camera.device_id === id.DeviceID : camera.model_id === id.ModelID
	);
};

export default function () {
	return (
		<RecordingOptionsProvider>
			<Inner />
		</RecordingOptionsProvider>
	);
}

function useOptions() {
	const { rawOptions: _rawOptions, setOptions } = createOptionsQuery();

	// const organizations = createOrganizationsQuery();
	const workspaces = createWorkspacesQuery();

	createEffect(() => {
		// if (
		// 	(!_rawOptions.organizationId && organizations().length > 0) ||
		// 	(_rawOptions.organizationId &&
		// 		organizations().every((o) => o.id !== _rawOptions.organizationId) &&
		// 		organizations().length > 0)
		// ) {
		// 	setOptions("organizationId", organizations()[0]?.id);
		// }

		if (
			(!_rawOptions.workspaceId && workspaces().length > 0) ||
			(_rawOptions.workspaceId &&
				workspaces().every((w) => w.id !== _rawOptions.workspaceId) &&
				workspaces().length > 0)
		) {
			setOptions("workspaceId", workspaces()[0]?.id);
		}
	});

	return [_rawOptions, setOptions] as const;
}

function Inner() {
	const [params] = useSearchParams<{
		displayId: DisplayId;
		isHoveredDisplay: string;
	}>();
	const [options, setOptions] = useOptions();

	const [toggleModeSelect, setToggleModeSelect] = createSignal(false);

	const [targetUnderCursor, setTargetUnderCursor] = createStore<TargetUnderCursor>({
		display_id: null,
		window: null,
	});

	const unsubTargetUnderCursor = events.targetUnderCursor.listen((event) => {
		setTargetUnderCursor(reconcile(event.payload));
	});
	onCleanup(() => unsubTargetUnderCursor.then((unsub) => unsub()));

	const windowIcon = useQuery(() => ({
		queryKey: ["windowIcon", targetUnderCursor.window?.id],
		queryFn: async () => {
			if (!targetUnderCursor.window?.id) return null;
			return await commands.getWindowIcon(targetUnderCursor.window.id.toString());
		},
		enabled: !!targetUnderCursor.window?.id,
		staleTime: 5 * 60 * 1000, // Cache for 5 minutes
	}));

	const displayInformation = useQuery(() => ({
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
		enabled: params.displayId !== undefined && options.targetMode === "display",
	}));

	const [crop, setCrop] = createSignal<CropBounds>(CROP_ZERO);
	type AreaTarget = Extract<ScreenCaptureTarget, { variant: "area" }>;
	const [pendingAreaTarget, setPendingAreaTarget] = createSignal<AreaTarget | null>(null);
	const [initialAreaBounds, setInitialAreaBounds] = createSignal<CropBounds | undefined>(undefined);

	createEffect(() => {
		const target = options.captureTarget;
		if (target.variant === "area" && params.displayId && target.screen === params.displayId) {
			setPendingAreaTarget({
				variant: "area",
				screen: target.screen,
				bounds: {
					position: {
						x: target.bounds.position.x,
						y: target.bounds.position.y,
					},
					size: {
						width: target.bounds.size.width,
						height: target.bounds.size.height,
					},
				},
			});
		}
	});

	createEffect((prevMode: "display" | "window" | "area" | null | undefined) => {
		const mode = options.targetMode ?? null;
		if (prevMode === "area" && mode !== "area") {
			const target = pendingAreaTarget();
			if (target) {
				setOptions(
					"captureTarget",
					reconcile({
						variant: "area",
						screen: target.screen,
						bounds: {
							position: {
								x: target.bounds.position.x,
								y: target.bounds.position.y,
							},
							size: {
								width: target.bounds.size.width,
								height: target.bounds.size.height,
							},
						},
					})
				);
			}
			setPendingAreaTarget(null);
			setInitialAreaBounds(undefined);
		}
		return mode;
	});

	const unsubOnEscapePress = events.onEscapePress.listen(() => {
		setOptions("targetMode", null);
		commands.closeTargetSelectOverlays();

		// We can't easily access `revertCamera` here because it's inside the Match.
		// However, if we close overlays, the camera might stay moved?
		// The user request says "if the user cancels the selection".
		// Pressing Escape cancels the selection mode entirely.
		// Ideally we should revert the camera position if we moved it.
		// But `revertCamera` is scoped to `Inner` -> `Match`.
		// We can rely on the fact that `originalCameraBounds` state is local to that Match block.
		// If the block unmounts, we might want to revert?
		// `onCleanup` inside the Match block is the right place.
	});
	onCleanup(() => unsubOnEscapePress.then((f) => f()));

	// This prevents browser keyboard shortcuts from firing.
	// Eg. on Windows Ctrl+P would open the print dialog without this
	createEventListener(document, "keydown", (e) => e.preventDefault());

	return (
		<Switch>
			<Match when={options.targetMode === "display" && params.displayId}>
				{(displayId) => (
					<div
						data-over={targetUnderCursor.display_id === displayId()}
						class="relative w-screen h-screen flex flex-col items-center justify-center data-[over='true']:bg-blue-600/40 transition-colors"
					>
						<div class="absolute inset-0 bg-black/60 -z-10" />

						<Show when={displayInformation.data} keyed>
							{(display) => (
								<div class="flex flex-col items-center text-white">
									<IconCapMonitor class="size-20 mb-3" />
									<span class="mb-2 text-3xl font-semibold">{display.name || "Monitor"}</span>
									<Show when={display.physical_size}>
										{(size) => (
											<span class="mb-2 text-xs">
												{`${size().width}x${size().height} · ${display.refresh_rate}FPS`}
											</span>
										)}
									</Show>
								</div>
							)}
						</Show>

						<Show when={toggleModeSelect()}>
							{/* Transparent overlay to capture outside clicks */}
							<div class="absolute inset-0 z-10" onClick={() => setToggleModeSelect(false)} />
							<ModeSelect standalone onClose={() => setToggleModeSelect(false)} />
						</Show>

						<RecordingControls
							setToggleModeSelect={setToggleModeSelect}
							target={{ variant: "display", id: displayId() }}
						/>
						{/* <ShowCapFreeWarning isInstantMode={options.mode === "instant"} /> */}
					</div>
				)}
			</Match>
			<Match when={options.targetMode === "window" && targetUnderCursor.display_id === params.displayId}>
				<Show when={targetUnderCursor.window} keyed>
					{(windowUnderCursor) => (
						<div
							data-over={targetUnderCursor.display_id === params.displayId}
							class="relative w-screen h-screen bg-black/70"
						>
							<div
								class="flex absolute flex-col justify-center items-center bg-blue-600/40"
								style={{
									width: `${windowUnderCursor.bounds.size.width}px`,
									height: `${windowUnderCursor.bounds.size.height}px`,
									left: `${windowUnderCursor.bounds.position.x}px`,
									top: `${windowUnderCursor.bounds.position.y}px`,
								}}
								onClick={() => {
									setOptions(
										"captureTarget",
										reconcile({
											variant: "window",
											id: windowUnderCursor.id,
										})
									);
									setOptions("targetMode", null);
									commands.closeTargetSelectOverlays();
								}}
							>
								<div class="flex flex-col justify-center items-center text-white">
									<div class="w-24 h-24">
										<Suspense>
											<Show when={windowIcon.data}>
												{(icon) => (
													<img
														src={icon()}
														alt={`${windowUnderCursor.app_name} icon`}
														class="mb-5 w-full h-full rounded-lg animate-in fade-in"
													/>
												)}
											</Show>
										</Suspense>
									</div>
									<span class="mb-2 text-3xl font-semibold">{windowUnderCursor.app_name}</span>
									<span class="mb-3 text-xs">
										{`${windowUnderCursor.bounds.size.width}x${windowUnderCursor.bounds.size.height}`}
									</span>
								</div>
								<button
									class="flex flex-row items-center gap-1 pl-1 pr-2 h-6 rounded-[8px] bg-black/30 hover:bg-black/50 text-xs cursor-pointer text-white opacity-80 hover:opacity-100 transition-opacity"
									onClick={(e) => {
										e.stopPropagation();
										setInitialAreaBounds({
											x: windowUnderCursor.bounds.position.x,
											y: windowUnderCursor.bounds.position.y,
											width: windowUnderCursor.bounds.size.width,
											height: windowUnderCursor.bounds.size.height,
										});
										setOptions({
											targetMode: "area",
										});
										commands.openTargetSelectOverlays(null);
									}}
								>
									<IconCapCrop class="size-4" />
									Adjust area
								</button>

								<RecordingControls
									target={{
										variant: "window",
										id: windowUnderCursor.id,
									}}
								/>

								{/* <Button
									variant="dark"
									size="sm"
									onClick={(e) => {
										e.stopPropagation();
										setInitialAreaBounds({
											x: windowUnderCursor.bounds.position.x,
											y: windowUnderCursor.bounds.position.y,
											width: windowUnderCursor.bounds.size.width,
											height: windowUnderCursor.bounds.size.height,
										});
										const screenId = params.displayId;
										if (screenId) {
											setPendingAreaTarget({
												variant: "area",
												screen: screenId,
												bounds: {
													position: {
														x: windowUnderCursor.bounds.position.x,
														y: windowUnderCursor.bounds.position.y,
													},
													size: {
														width: windowUnderCursor.bounds.size.width,
														height: windowUnderCursor.bounds.size.height,
													},
												},
											});
										}
										setOptions({
											targetMode: "area",
										});
										commands.openTargetSelectOverlays(null);
									}}
								>
									Adjust recording area
								</Button> */}
								{/* <ShowCapFreeWarning isInstantMode={options.mode === "instant"} /> */}
							</div>
						</div>
					)}
				</Show>
			</Match>
			<Match when={options.targetMode === "area" && params.displayId}>
				{(displayId) => {
					let controlsEl: HTMLDivElement | undefined;
					let cropperRef: CropperRef | undefined;

					const [cameraWindow, setCameraWindow] = createSignal<WebviewWindow | null>(null);
					const [originalCameraBounds, setOriginalCameraBounds] = createSignal<{
						position: PhysicalPosition;
						size: PhysicalSize;
					} | null>(null);
					const [cachedScaleFactor, setCachedScaleFactor] = createSignal<number | null>(null);

					onMount(async () => {
						const win = await WebviewWindow.getByLabel("camera");
						if (win) setCameraWindow(win);
					});

					const [aspect, setAspect] = createSignal<Ratio | null>(null);
					const [snapToRatioEnabled, setSnapToRatioEnabled] = createSignal(true);
					const [isInteracting, setIsInteracting] = createSignal(false);
					const shouldShowSelectionHint = createMemo(() => {
						if (initialAreaBounds() !== undefined) return false;
						const bounds = crop();
						return bounds.width <= 1 && bounds.height <= 1 && !isInteracting();
					});

					const isValid = createMemo(() => {
						const b = crop();
						return b.width >= MIN_SIZE.width && b.height >= MIN_SIZE.height;
					});

					const [targetState, setTargetState] = createSignal<{
						x: number;
						y: number;
						width: number;
						height: number;
					} | null>(null);

					let lastApplied: {
						x: number;
						y: number;
						width: number;
						height: number;
					} | null = null;

					onMount(() => {
						let processing = false;
						let raf: number;

						const loop = async () => {
							const target = targetState();
							if (target && !processing) {
								const changed =
									!lastApplied ||
									Math.abs(lastApplied.x - target.x) > 1 ||
									Math.abs(lastApplied.y - target.y) > 1 ||
									Math.abs(lastApplied.width - target.width) > 1 ||
									Math.abs(lastApplied.height - target.height) > 1;

								if (changed) {
									processing = true;
									try {
										await invoke("update_camera_overlay_bounds", {
											x: target.x,
											y: target.y,
											width: target.width,
											height: target.height,
										});
										lastApplied = target;
									} catch (e) {
										console.error("Failed to update camera window", e);
									}
									processing = false;
								}
							}
							raf = requestAnimationFrame(loop);
						};
						raf = requestAnimationFrame(loop);
						onCleanup(() => cancelAnimationFrame(raf));
					});

					createEffect(async () => {
						if (options.mode === "screenshot") return;
						const bounds = crop();
						const interacting = isInteracting();

						// Find the camera window if we haven't yet
						let win = cameraWindow();
						if (!win) {
							// Try to find it
							try {
								win = await WebviewWindow.getByLabel("camera");
								if (!win) {
									// Fallback: check all windows
									const all = await WebviewWindow.getAll();
									win = all.find((w) => w.label.includes("camera")) ?? null;
								}
								if (win) setCameraWindow(win);
							} catch (e) {
								console.error("Failed to find camera window", e);
							}
						}

						if (!win || !interacting) return;

						// Initialize data
						if (!originalCameraBounds() || cachedScaleFactor() === null) {
							try {
								const pos = await win.outerPosition();
								const size = await win.outerSize();
								const factor = await win.scaleFactor();
								setOriginalCameraBounds({ position: pos, size });
								setCachedScaleFactor(factor);
							} catch (e) {
								console.error("Failed to init camera bounds", e);
							}
							return;
						}

						const original = originalCameraBounds();
						const scaleFactor = cachedScaleFactor() ?? 1;

						if (!original) return;

						const originalLogicalSize = original.size.toLogical(scaleFactor);

						const padding = 16;
						const selectionMinDim = Math.min(bounds.width, bounds.height);
						const targetMaxDim = Math.max(
							150,
							Math.min(Math.max(originalLogicalSize.width, originalLogicalSize.height), selectionMinDim * 0.5)
						);

						const originalMaxDim = Math.max(originalLogicalSize.width, originalLogicalSize.height);
						const scale = targetMaxDim / originalMaxDim;

						const newWidth = Math.round(originalLogicalSize.width * scale);
						const newHeight = Math.round(originalLogicalSize.height * scale);

						if (bounds.width > newWidth + padding * 2 && bounds.height > newHeight + padding * 2) {
							const newX = Math.round(bounds.x + bounds.width - newWidth - padding);
							const newY = Math.round(bounds.y + bounds.height - newHeight - padding);

							setTargetState({
								x: newX * scaleFactor,
								y: newY * scaleFactor,
								width: newWidth * scaleFactor,
								height: newHeight * scaleFactor,
							});
						}
					});

					async function revertCamera() {
						const original = originalCameraBounds();
						const win = cameraWindow();
						if (original && win) {
							await win.setPosition(original.position);
							await win.setSize(original.size);
							setOriginalCameraBounds(null);
							setTargetState(null);
							lastApplied = null;
						}
					}

					onCleanup(() => {
						revertCamera();
					});

					async function showCropOptionsMenu(e: UIEvent) {
						e.preventDefault();
						const items = [
							{
								text: "Reset selection",
								action: () => {
									cropperRef?.reset();
									setAspect(null);
									setPendingAreaTarget(null);
									revertCamera();
								},
							},
							await PredefinedMenuItem.new({
								item: "Separator",
							}),
							...createCropOptionsMenuItems({
								aspect: aspect(),
								snapToRatioEnabled: snapToRatioEnabled(),
								onAspectSet: setAspect,
								onSnapToRatioSet: setSnapToRatioEnabled,
							}),
						];
						const menu = await Menu.new({ items });
						await menu.popup();
						await menu.close();
					}

					// Spacing rules:
					// Prefer below the crop (smaller margin)
					// If no space below, place above the crop (larger top margin)
					// Otherwise, place inside at the top of the crop (small inner margin)
					const macos = ostype() === "macos";
					const SIDE_MARGIN = 16;
					const MARGIN_BELOW = 16;
					const MARGIN_TOP_OUTSIDE = 16;
					const MARGIN_TOP_INSIDE = macos ? 40 : 28;
					const TOP_SAFE_MARGIN = macos ? 40 : 10; // keep clear of notch on MacBooks

					const controlsSize = createElementSize(() => controlsEl);
					const [controllerInside, _setControllerInside] = createSignal(false);

					// This is required due to the use of a ResizeObserver within the createElementSize function
					// Otherwise there will be an infinite loop: ResizeObserver loop completed with undelivered notifications.
					let raf: number | null = null;
					function setControllerInside(value: boolean) {
						if (raf) cancelAnimationFrame(raf);
						raf = requestAnimationFrame(() => _setControllerInside(value));
					}
					onCleanup(() => {
						if (raf) cancelAnimationFrame(raf);
					});

					const controlsStyle = createMemo(() => {
						const bounds = crop();
						const size = controlsSize;
						if (!size?.width || !size?.height) return undefined;

						if (size.width === 0 || bounds.width === 0) {
							return { transform: "translate(-1000px, -1000px)" }; // Hide off-screen initially
						}

						const centerX = bounds.x + bounds.width / 2;
						let finalY: number;

						// Try below the crop
						const belowY = bounds.y + bounds.height + MARGIN_BELOW;
						if (belowY + size.height <= window.innerHeight) {
							finalY = belowY;
							setControllerInside(false);
						} else {
							// Try above the crop with a larger top margin
							const aboveY = bounds.y - size.height - MARGIN_TOP_OUTSIDE;
							if (aboveY >= TOP_SAFE_MARGIN) {
								finalY = aboveY;
								setControllerInside(false);
							} else {
								// Default to inside
								finalY = bounds.y + MARGIN_TOP_INSIDE;
								setControllerInside(true);
							}
						}

						const finalX = Math.max(
							SIDE_MARGIN,
							Math.min(centerX - size.width / 2, window.innerWidth - size.width - SIDE_MARGIN)
						);

						return {
							transform: `translate(${finalX}px, ${finalY}px)`,
						};
					});

					createEffect(() => {
						if (isInteracting()) return;
						if (!isValid()) return;
						const screenId = displayId();
						if (!screenId) return;
						const bounds = crop();
						setPendingAreaTarget({
							variant: "area",
							screen: screenId,
							bounds: {
								position: { x: bounds.x, y: bounds.y },
								size: { width: bounds.width, height: bounds.height },
							},
						});
					});

					const [wasInteracting, setWasInteracting] = createSignal(false);
					createEffect(async () => {
						const interacting = isInteracting();
						const was = wasInteracting();
						setWasInteracting(interacting);

						if (was && !interacting) {
							if (options.mode === "screenshot" && isValid()) {
								const target: ScreenCaptureTarget = {
									variant: "area",
									screen: displayId(),
									bounds: {
										position: {
											x: crop().x,
											y: crop().y,
										},
										size: {
											width: crop().width,
											height: crop().height,
										},
									},
								};

								try {
									const path = await invoke<string>("take_screenshot", {
										target,
									});
									await commands.showWindow({ ScreenshotEditor: { path } });
									await commands.closeTargetSelectOverlays();
								} catch (e) {
									const message = e instanceof Error ? e.message : String(e);
									toast.error(`Failed to take screenshot: ${message}`);
									console.error("Failed to take screenshot", e);
								}
							}
						}
					});

					return (
						<div class="fixed w-screen h-screen bg-black/60">
							<div ref={controlsEl} class="fixed z-50 transition-opacity" style={controlsStyle()}>
								<div class="flex flex-col items-center">
									<Show when={options.mode !== "screenshot"}>
										<RecordingControls
											target={{
												variant: "area",
												screen: displayId(),
												bounds: {
													position: {
														x: crop().x,
														y: crop().y,
													},
													size: {
														width: crop().width,
														height: crop().height,
													},
												},
											}}
											disabled={!isValid()}
											showBackground={controllerInside()}
											onRecordingStart={() => setOriginalCameraBounds(null)}
										/>
									</Show>
									<Show when={!isValid()}>
										<div class="flex flex-col gap-1 items-center p-2.5 my-2 rounded-xl border min-w-fit w-fit bg-red-2 shadow-sm border-red-4 text-sm">
											<p>Minimum size is 150 x 150</p>
											<small>
												<code>
													{crop().width} x {crop().height}
												</code>{" "}
												is too small
											</small>
										</div>
									</Show>
									<Show when={isValid()}>
										<ShowCapFreeWarning isInstantMode={options.mode === "instant"} />
									</Show>
								</div>
							</div>

							<SelectionHint show={shouldShowSelectionHint()} />

							<Cropper
								ref={cropperRef}
								onInteraction={setIsInteracting}
								onCropChange={setCrop}
								initialCrop={() => initialAreaBounds() ?? CROP_ZERO}
								showBounds={isValid()}
								aspectRatio={aspect() ?? undefined}
								snapToRatioEnabled={snapToRatioEnabled()}
								onContextMenu={(e) => showCropOptionsMenu(e)}
							/>
						</div>
					);
				}}
			</Match>
		</Switch>
	);
}

function RecordingControls(props: {
	target: ScreenCaptureTarget;
	setToggleModeSelect?: (value: boolean) => void;
	showBackground?: boolean;
	disabled?: boolean;
	onRecordingStart?: () => void;
}) {
	const auth = authStore.createQuery();
	const { setOptions, rawOptions } = useRecordingOptions();

	// const generalSetings = generalSettingsStore.createQuery();

	const workspaces = createMemo(() => auth.data?.workspaces ?? []);
	const selectedWorkspace = createMemo(() => {
		if (!rawOptions.workspaceId && workspaces().length > 0) {
			return workspaces()[0];
		}
		return workspaces().find((w) => w.id === rawOptions.workspaceId) ?? workspaces()[0];
	});

	const workspacesMenu = async () =>
		await Menu.new({
			items: await Promise.all(
				workspaces().map((workspace) =>
					CheckMenuItem.new({
						text: workspace.name,
						action: () => {
							setOptions("workspaceId", workspace.id);
						},
						checked: selectedWorkspace()?.id === workspace.id,
					})
				)
			),
		});

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
				await CheckMenuItem.new({
					text: "Screenshot Mode",
					action: () => {
						setOptions("mode", "screenshot");
					},
					checked: rawOptions.mode === "screenshot",
				}),
			],
		});

	// const countdownItems = async () => [
	// 	await CheckMenuItem.new({
	// 		text: "Off",
	// 		action: () => generalSettingsStore.set({ recordingCountdown: 0 }),
	// 		checked: !generalSetings.data?.recordingCountdown || generalSetings.data?.recordingCountdown === 0,
	// 	}),
	// 	await CheckMenuItem.new({
	// 		text: "3 seconds",
	// 		action: () => generalSettingsStore.set({ recordingCountdown: 3 }),
	// 		checked: generalSetings.data?.recordingCountdown === 3,
	// 	}),
	// 	await CheckMenuItem.new({
	// 		text: "5 seconds",
	// 		action: () => generalSettingsStore.set({ recordingCountdown: 5 }),
	// 		checked: generalSetings.data?.recordingCountdown === 5,
	// 	}),
	// 	await CheckMenuItem.new({
	// 		text: "10 seconds",
	// 		action: () => generalSettingsStore.set({ recordingCountdown: 10 }),
	// 		checked: generalSetings.data?.recordingCountdown === 10,
	// 	}),
	// ];

	// const preRecordingMenu = async () => {
	// 	return await Menu.new({
	// 		items: [
	// 			await MenuItem.new({
	// 				text: "Recording Countdown",
	// 				enabled: false,
	// 			}),
	// 			...(await countdownItems()),
	// 		],
	// 	});
	// };

	function showMenu(menu: Promise<Menu>, e: UIEvent) {
		e.stopPropagation();
		const rect = (e.target as HTMLDivElement).getBoundingClientRect();
		menu.then((menu) => menu.popup(new LogicalPosition(rect.x, rect.y + 40)));
	}

	const startDisabled = () => !!props.disabled;

	return (
		<>
			<div class="flex gap-2 items-center p-2 my-5 rounded-[18px] border border-white/15 min-w-fit w-fit bg-neutral-950 shadow-sm">
				{/* <div
					onClick={() => {
						setOptions("targetMode", null);
						commands.closeTargetSelectOverlays();
					}}
					class="flex justify-center items-center rounded-full transition-opacity bg-gray-12 size-9 hover:opacity-80"
				>
					<IconCapX class="invert will-change-transform size-3 dark:invert-0" />
				</div> */}
				<Show when={auth.data && workspaces().length > 0}>
					<div
						class="flex items-center gap-1.5 px-3 h-10 rounded-[12px] transition-colors cursor-pointer hover:bg-white/5"
						onMouseDown={(e) => showMenu(workspacesMenu(), e)}
						onClick={(e) => showMenu(workspacesMenu(), e)}
					>
						<Show when={selectedWorkspace()?.avatarUrl && selectedWorkspace()?.avatarUrl !== null}>
							<img src={selectedWorkspace()?.avatarUrl ?? ""} alt="" class="size-5 rounded-full object-cover" />
						</Show>
						<span class="text-sm text-gray-12">{selectedWorkspace()?.name}</span>
						<DoubleArrowSwitcher class="size-3 text-gray-11" />
					</div>
				</Show>
				<Show when={!auth.data}>
					<span class="text-white text-[14px] px-2">Log In to Record</span>
				</Show>
				<div
					data-inactive={rawOptions.mode === "instant" && !auth.data}
					class="flex overflow-hidden flex-row h-10 rounded-[12px] bg-blue-9 group border border-white/15"
					onClick={() => {
						if (rawOptions.mode === "instant" && !auth.data) {
							emit("start-sign-in");
							return;
						}

						commands.startRecording({
							capture_target: props.target,
							mode: rawOptions.mode,
							capture_system_audio: rawOptions.captureSystemAudio,
							workspace_id: rawOptions.workspaceId,
						});
					}}
				>
					<div class="flex items-center gap-1 py-1 px-3 transition-colors hover:bg-blue-10 cursor-pointer">
						{auth.data && <RecordFill class="size-4" />}
						<div class="text-sm font-medium text-white text-nowrap px-1">
							{!auth.data ? "Open Inflight" : "Start Recording"}
						</div>
						{!auth.data && <ArrowUpRight class="size-4" />}
					</div>
					{/* <div class="flex items-center py-1 pl-4 transition-colors hover:bg-blue-10">
						{rawOptions.mode === "studio" ? <IconCapFilmCut class="size-4" /> : <IconCapInstant class="size-4" />}
						<div class="flex flex-col mr-2 ml-3">
							<span class="text-sm font-medium text-white text-nowrap">
								{rawOptions.mode === "instant" && !auth.data ? "Sign In To Use" : "Start Recording"}
							</span>
							<span class="text-xs flex items-center text-nowrap gap-1 transition-opacity duration-200 text-white font-light -mt-0.5 opacity-90">
								{`${capitalize(rawOptions.mode)} Mode`}
							</span>
						</div>
					</div>
					<div
						class="pl-2.5 group-hover:bg-blue-10 transition-colors pr-3 py-1.5 flex items-center"
						onMouseDown={(e) => showMenu(menuModes(), e)}
						onClick={(e) => showMenu(menuModes(), e)}
					>
						<IconCapCaretDown class="pointer-events-none focus:rotate-90" />
					</div> */}
				</div>
				{/* <Show when={(rawOptions.mode as string) !== "screenshot"}>
					<div class="p-3 rounded-2xl border border-white/30 dark:border-white/10 bg-white/70 dark:bg-gray-2/70 shadow-lg backdrop-blur-xl">
						<div class="grid grid-cols-2 gap-2 w-full">
							<CameraSelect
								disabled={cameras.isPending}
								options={cameras.data ?? []}
								value={selectedCamera() ?? null}
								onChange={(camera) => {
									if (!camera) setCamera.mutate(null);
									else if (camera.model_id)
										setCamera.mutate({ ModelID: camera.model_id });
									else setCamera.mutate({ DeviceID: camera.device_id });
								}}
							/>
							<MicrophoneSelect
								disabled={mics.isPending}
								options={mics.isPending ? [] : (mics.data ?? [])}
								value={
									mics.isPending
										? (rawOptions.micName ?? null)
										: selectedMicName()
								}
								onChange={(value) => setMicInput.mutate(value)}
							/>
						</div>
					</div>
				</Show> */}
			</div>
			{/* <div class="flex justify-center items-center w-full">
				<div
					onClick={() => props.setToggleModeSelect?.(true)}
					class="flex gap-1 justify-center items-center self-center mb-5 transition-opacity duration-200 w-fit hover:opacity-60"
					classList={{
						"bg-black/50 p-2 rounded-lg border border-white/10 hover:bg-black/50 hover:opacity-80":
							props.showBackground,
						"hover:opacity-60": !props.showBackground,
					}}
				>
					<IconCapInfo class="opacity-70 will-change-transform size-3" />
					<p class="text-sm text-white drop-shadow-md">
						<span class="opacity-70">What is </span>
						<span class="font-medium">{capitalize(rawOptions.mode)} Mode</span>?
					</p>
				</div>
			</div> */}
		</>
	);
}

function ShowCapFreeWarning(props: { isInstantMode: boolean }) {
	const auth = authStore.createQuery();

	return (
		<Suspense>
			<Show when={props.isInstantMode && auth.data?.plan?.upgraded === false}>
				<p class="text-sm text-center max-w-64">
					Instant Mode recordings are limited to 5 mins,{" "}
					<button class="underline" onClick={() => commands.showWindow("Upgrade")}>
						Upgrade to Pro
					</button>
				</p>
			</Show>
		</Suspense>
	);
}
