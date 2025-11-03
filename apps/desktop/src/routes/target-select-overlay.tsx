import { Button } from "@cap/ui-solid";
import { createEventListener } from "@solid-primitives/event-listener";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import { useSearchParams } from "@solidjs/router";
import { useQuery } from "@tanstack/solid-query";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emit } from "@tauri-apps/api/event";
import {
	CheckMenuItem,
	Menu,
	MenuItem,
	PredefinedMenuItem,
} from "@tauri-apps/api/menu";
import { type as ostype } from "@tauri-apps/plugin-os";
import {
	createMemo,
	createSignal,
	Match,
	mergeProps,
	onCleanup,
	Show,
	Suspense,
	Switch,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import Cropper, {
	CROP_ZERO,
	type CropBounds,
	type CropperRef,
	createCropOptionsMenuItems,
	type Ratio,
} from "~/components/Cropper";
import ModeSelect from "~/components/ModeSelect";
import { authStore, generalSettingsStore } from "~/store";
import { createOptionsQuery, createOrganizationsQuery } from "~/utils/queries";
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

function useOptions() {
	const { rawOptions: _rawOptions, setOptions } = createOptionsQuery();

	const organizations = createOrganizationsQuery();
	const options = mergeProps(_rawOptions, () => {
		const ret: Partial<typeof _rawOptions> = {};

		if (
			(!_rawOptions.organizationId && organizations().length > 0) ||
			(_rawOptions.organizationId &&
				organizations().every((o) => o.id !== _rawOptions.organizationId) &&
				organizations().length > 0)
		)
			ret.organizationId = organizations()[0]?.id;

		return ret;
	});

	return [options, setOptions] as const;
}

function Inner() {
	const [params] = useSearchParams<{
		displayId: DisplayId;
		isHoveredDisplay: string;
	}>();
	const [options, setOptions] = useOptions();

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

	const windowIcon = useQuery(() => ({
		queryKey: ["windowIcon", targetUnderCursor.window?.id],
		queryFn: async () => {
			if (!targetUnderCursor.window?.id) return null;
			return await commands.getWindowIcon(
				targetUnderCursor.window.id.toString(),
			);
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

	const [initialAreaBounds, setInitialAreaBounds] = createSignal<
		CropBounds | undefined
	>(undefined);

	const unsubOnEscapePress = events.onEscapePress.listen(() => {
		setOptions("targetMode", null);
		commands.closeTargetSelectOverlays();
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
							target={{ variant: "display", id: displayId() }}
						/>
						<ShowCapFreeWarning isInstantMode={options.mode === "instant"} />
					</div>
				)}
			</Match>
			<Match
				when={
					options.targetMode === "window" &&
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
									target={{
										variant: "window",
										id: windowUnderCursor.id,
									}}
								/>

								<Button
									variant="dark"
									size="sm"
									onClick={() => {
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
									Adjust recording area
								</Button>
								<ShowCapFreeWarning
									isInstantMode={options.mode === "instant"}
								/>
							</div>
						</div>
					)}
				</Show>
			</Match>
			<Match when={options.targetMode === "area" && params.displayId}>
				{(displayId) => {
					let controlsEl: HTMLDivElement | undefined;
					let cropperRef: CropperRef | undefined;

					const [aspect, setAspect] = createSignal<Ratio | null>(null);
					const [snapToRatioEnabled, setSnapToRatioEnabled] =
						createSignal(true);

					async function showCropOptionsMenu(e: UIEvent) {
						e.preventDefault();
						const items = [
							{
								text: "Reset selection",
								action: () => {
									cropperRef?.reset();
									setAspect(null);
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

					const [controlsSize, setControlsSize] = createStore({
						width: 0,
						height: 0,
					});
					createResizeObserver(
						() => controlsEl,
						({ width, height }) => {
							setControlsSize({ width, height });
						},
					);

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

					const controlsStyle = createMemo(() => {
						const bounds = crop();
						const size = controlsSize;

						if (size.width === 0 || bounds.width === 0) {
							return { transform: "translate(-1000px, -1000px)" }; // Hide off-screen initially
						}

						const centerX = bounds.x + bounds.width / 2;
						let finalY: number;

						// Try below the crop
						const belowY = bounds.y + bounds.height + MARGIN_BELOW;
						if (belowY + size.height <= window.innerHeight) {
							finalY = belowY;
						} else {
							// Try above the crop with a larger top margin
							const aboveY = bounds.y - size.height - MARGIN_TOP_OUTSIDE;
							if (aboveY >= TOP_SAFE_MARGIN) {
								finalY = aboveY;
							} else {
								// Default to inside
								finalY = bounds.y + MARGIN_TOP_INSIDE;
							}
						}

						const finalX = Math.max(
							SIDE_MARGIN,
							Math.min(
								centerX - size.width / 2,
								window.innerWidth - size.width - SIDE_MARGIN,
							),
						);

						return {
							transform: `translate(${finalX}px, ${finalY}px)`,
						};
					});

					return (
						<div class="w-screen h-screen fixed">
							<div
								ref={controlsEl}
								class="fixed z-50 transition-opacity"
								style={controlsStyle()}
							>
								<RecordingControls
									target={{
										variant: "area",
										screen: displayId(),
										bounds: {
											position: { x: crop().x, y: crop().y },
											size: { width: crop().width, height: crop().height },
										},
									}}
								/>
								<ShowCapFreeWarning
									isInstantMode={options.mode === "instant"}
								/>
							</div>

							<Cropper
								ref={cropperRef}
								onCropChange={setCrop}
								initialCrop={initialAreaBounds()}
								minSize={{ x: 150, y: 150 }}
								showBounds={true}
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

	const countdownItems = async () => [
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
	];

	const preRecordingMenu = async () => {
		return await Menu.new({
			items: [
				await MenuItem.new({
					text: "Recording Countdown",
					enabled: false,
				}),
				...(await countdownItems()),
			],
		});
	};

	function showMenu(menu: Promise<Menu>, e: UIEvent) {
		e.stopPropagation();
		const rect = (e.target as HTMLDivElement).getBoundingClientRect();
		menu.then((menu) => menu.popup(new LogicalPosition(rect.x, rect.y + 40)));
	}

	return (
		<>
			<div class="flex gap-2.5 items-center p-2.5 my-2.5 rounded-xl border min-w-fit w-fit bg-gray-2 shadow-sm border-gray-4">
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
						onMouseDown={(e) => showMenu(menuModes(), e)}
						onClick={(e) => showMenu(menuModes(), e)}
					>
						<IconCapCaretDown class="focus:rotate-90 pointer-events-none" />
					</div>
				</div>
				<div
					class="flex justify-center items-center rounded-full border transition-opacity bg-gray-6 text-gray-12 size-9 hover:opacity-80"
					onMouseDown={(e) => showMenu(preRecordingMenu(), e)}
					onClick={(e) => showMenu(preRecordingMenu(), e)}
				>
					<IconCapGear class="will-change-transform size-5 pointer-events-none" />
				</div>
			</div>
			<div
				onClick={() => props.setToggleModeSelect?.(true)}
				class="flex gap-1 items-center justify-center mb-5 transition-opacity duration-200 hover:opacity-60"
			>
				<IconCapInfo class="opacity-70 will-change-transform size-3" />
				<p class="text-sm text-white drop-shadow-lg">
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
				<p class="text-sm text-center max-w-64">
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
