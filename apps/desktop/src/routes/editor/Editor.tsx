import { Button } from "@cap/ui-solid";
import { NumberField } from "@kobalte/core/number-field";
import { createElementBounds } from "@solid-primitives/bounds";
import { trackDeep } from "@solid-primitives/deep";
import { debounce, throttle } from "@solid-primitives/scheduled";
import { makePersisted } from "@solid-primitives/storage";
import { createMutation } from "@tanstack/solid-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu } from "@tauri-apps/api/menu";
import {
	createEffect,
	createMemo,
	createSignal,
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { createStore } from "solid-js/store";
import { Transition } from "solid-transition-group";
import {
	CROP_ZERO,
	type CropBounds,
	Cropper,
	type CropperRef,
	createCropOptionsMenuItems,
	type Ratio,
} from "~/components/Cropper";
import { Toggle } from "~/components/Toggle";
import { composeEventHandlers } from "~/utils/composeEventHandlers";
import { createTauriEventListener } from "~/utils/createEventListener";
import { commands, events } from "~/utils/tauri";
import { ConfigSidebar } from "./ConfigSidebar";
import {
	EditorContextProvider,
	EditorInstanceContextProvider,
	FPS,
	serializeProjectConfiguration,
	useEditorContext,
	useEditorInstanceContext,
} from "./context";
import { ExportPage } from "./ExportPage";
import { Header } from "./Header";
import { PlayerContent } from "./Player";
import { Timeline } from "./Timeline";
import { Dialog, DialogContent, EditorButton, Input, Subfield } from "./ui";

const DEFAULT_TIMELINE_HEIGHT = 260;
const MIN_PLAYER_CONTENT_HEIGHT = 320;
const MIN_TIMELINE_HEIGHT = 240;
const RESIZE_HANDLE_HEIGHT = 8;
const MIN_PLAYER_HEIGHT = MIN_PLAYER_CONTENT_HEIGHT + RESIZE_HANDLE_HEIGHT;

export function Editor() {
	return (
		<EditorInstanceContextProvider>
			<Show
				when={(() => {
					const ctx = useEditorInstanceContext();
					const editorInstance = ctx.editorInstance();

					if (!editorInstance || !ctx.metaQuery.data) return;

					return {
						editorInstance,
						meta() {
							const d = ctx.metaQuery.data;
							if (!d)
								throw new Error(
									"metaQuery.data is undefined - how did this happen?",
								);
							return d;
						},
						refetchMeta: async () => {
							await ctx.metaQuery.refetch();
						},
					};
				})()}
			>
				{(values) => (
					<EditorContextProvider {...values()}>
						<Inner />
					</EditorContextProvider>
				)}
			</Show>
		</EditorInstanceContextProvider>
	);
}

function Inner() {
	const {
		project,
		editorState,
		setEditorState,
		previewResolutionBase,
		dialog,
		canvasControls,
	} = useEditorContext();

	const isExportMode = () => {
		const d = dialog();
		return "type" in d && d.type === "export" && d.open;
	};

	const [layoutRef, setLayoutRef] = createSignal<HTMLDivElement>();
	const layoutBounds = createElementBounds(layoutRef);
	const [storedTimelineHeight, setStoredTimelineHeight] = makePersisted(
		createSignal(DEFAULT_TIMELINE_HEIGHT),
		{ name: "editorTimelineHeight" },
	);
	const [isResizingTimeline, setIsResizingTimeline] = createSignal(false);

	const clampTimelineHeight = (value: number) => {
		const available = layoutBounds.height ?? 0;
		const maxHeight =
			available > 0
				? Math.max(MIN_TIMELINE_HEIGHT, available - MIN_PLAYER_HEIGHT)
				: Number.POSITIVE_INFINITY;
		const upperBound = Number.isFinite(maxHeight)
			? maxHeight
			: Math.max(value, MIN_TIMELINE_HEIGHT);
		return Math.min(Math.max(value, MIN_TIMELINE_HEIGHT), upperBound);
	};

	const timelineHeight = createMemo(() =>
		Math.round(clampTimelineHeight(storedTimelineHeight())),
	);

	const handleTimelineResizeStart = (event: MouseEvent) => {
		if (event.button !== 0) return;
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = timelineHeight();
		setIsResizingTimeline(true);

		const handleMove = (moveEvent: MouseEvent) => {
			const delta = moveEvent.clientY - startY;
			setStoredTimelineHeight(clampTimelineHeight(startHeight - delta));
		};

		const handleUp = () => {
			setIsResizingTimeline(false);
			window.removeEventListener("mousemove", handleMove);
			window.removeEventListener("mouseup", handleUp);
		};

		window.addEventListener("mousemove", handleMove);
		window.addEventListener("mouseup", handleUp);
	};

	createEffect(() => {
		const available = layoutBounds.height;
		if (!available) return;
		setStoredTimelineHeight((height) => clampTimelineHeight(height));
	});

	createTauriEventListener(events.editorStateChanged, (payload) => {
		throttledRenderFrame.clear();
		trailingRenderFrame.clear();
		setEditorState("playbackTime", payload.playhead_position / FPS);
	});

	const emitRenderFrame = (time: number) => {
		if (!editorState.playing) {
			events.renderFrameEvent.emit({
				frame_number: Math.max(Math.floor(time * FPS), 0),
				fps: FPS,
				resolution_base: previewResolutionBase(),
			});
		}
	};

	const throttledRenderFrame = throttle(emitRenderFrame, 1000 / FPS);

	const trailingRenderFrame = debounce(emitRenderFrame, 1000 / FPS + 16);

	const renderFrame = (time: number) => {
		throttledRenderFrame(time);
		trailingRenderFrame(time);
	};

	const frameNumberToRender = createMemo(() => {
		const preview = editorState.previewTime;
		if (preview !== null) return preview;
		return editorState.playbackTime;
	});

	createEffect(
		on(
			() => [frameNumberToRender(), previewResolutionBase()],
			([number]) => {
				if (editorState.playing) return;
				renderFrame(number as number);
			},
			{ defer: false },
		),
	);

	createEffect(
		on(isExportMode, (exportMode, prevExportMode) => {
			if (prevExportMode === true && exportMode === false) {
				emitRenderFrame(frameNumberToRender());
			}
		}),
	);

	const doConfigUpdate = async (time: number) => {
		const config = serializeProjectConfiguration(project);
		await commands.updateProjectConfigInMemory(config);
		canvasControls()?.resetFrameState();
		renderFrame(time);
	};
	const throttledConfigUpdate = throttle(doConfigUpdate, 1000 / FPS);
	const trailingConfigUpdate = debounce(doConfigUpdate, 1000 / FPS + 16);
	const updateConfigAndRender = (time: number) => {
		throttledConfigUpdate(time);
		trailingConfigUpdate(time);
	};
	createEffect(
		on(
			() => trackDeep(project),
			() => {
				updateConfigAndRender(editorState.playbackTime);
			},
		),
	);

	return (
		<Show when={!isExportMode()} fallback={<ExportPage />}>
			<div class="flex flex-col flex-1 min-h-0 animate-in fade-in duration-300">
				<Header />
				<div
					class="flex overflow-y-hidden flex-col flex-1 gap-2 pb-4 w-full min-h-0 leading-5"
					data-tauri-drag-region
				>
					<div
						ref={setLayoutRef}
						class="flex overflow-hidden flex-col flex-1 min-h-0"
					>
						<div
							class="flex overflow-y-hidden flex-row flex-1 min-h-0 gap-2 px-2"
							style={{
								"min-height": `${MIN_PLAYER_HEIGHT}px`,
							}}
						>
							<div class="flex flex-col flex-1 rounded-xl border bg-gray-1 dark:bg-gray-2 border-gray-3 overflow-hidden">
								<PlayerContent />
								<div
									role="separator"
									aria-orientation="horizontal"
									class="flex-none transition-colors hover:bg-gray-3/30"
									style={{ height: `${RESIZE_HANDLE_HEIGHT}px` }}
								>
									<div
										class="flex justify-center items-center h-full cursor-row-resize select-none group"
										classList={{ "bg-gray-3/50": isResizingTimeline() }}
										onMouseDown={handleTimelineResizeStart}
									>
										<div
											class="h-1 w-12 rounded-full bg-gray-4 transition-colors group-hover:bg-gray-6"
											classList={{ "bg-gray-7": isResizingTimeline() }}
										/>
									</div>
								</div>
							</div>
							<ConfigSidebar />
						</div>
						<div
							class="flex-none min-h-0 px-2 pb-0.5 overflow-hidden relative"
							style={{ height: `${timelineHeight()}px` }}
						>
							<div class="h-full">
								<Timeline />
							</div>
						</div>
					</div>
					<Dialogs />
				</div>
			</div>
		</Show>
	);
}

function Dialogs() {
	const { dialog, setDialog, presets, project } = useEditorContext();

	return (
		<Dialog.Root
			size={(() => {
				const d = dialog();
				if ("type" in d && d.type === "crop") return "lg";
				return "sm";
			})()}
			contentClass={(() => {
				const d = dialog();
				if ("type" in d && d.type === "export") return "max-w-[740px]";
				return "";
			})()}
			open={dialog().open}
			onOpenChange={(o) => {
				if (!o) setDialog((d) => ({ ...d, open: false }));
			}}
		>
			<Show
				when={(() => {
					const d = dialog();
					if ("type" in d && d.type !== "export") return d;
				})()}
			>
				{(dialog) => (
					<Switch>
						<Match when={dialog().type === "createPreset"}>
							{(_) => {
								const [form, setForm] = createStore({
									name: "",
									default: false,
								});

								const createPreset = createMutation(() => ({
									mutationFn: async () => {
										await presets.createPreset({ ...form, config: project });
									},
									onSuccess: () => {
										setDialog((d) => ({ ...d, open: false }));
									},
								}));

								return (
									<DialogContent
										title="Create Preset"
										confirm={
											<Dialog.ConfirmButton
												disabled={createPreset.isPending}
												onClick={() => createPreset.mutate()}
											>
												Create
											</Dialog.ConfirmButton>
										}
									>
										<Subfield name="Name" required />
										<Input
											class="mt-2"
											value={form.name}
											placeholder="Enter preset name..."
											onInput={(e) => setForm("name", e.currentTarget.value)}
										/>
										<Subfield name="Set as default" class="mt-4">
											<Toggle
												checked={form.default}
												onChange={(checked) => setForm("default", checked)}
											/>
										</Subfield>
									</DialogContent>
								);
							}}
						</Match>
						<Match
							when={(() => {
								const d = dialog();
								if (d.type === "renamePreset") return d;
							})()}
						>
							{(dialog) => {
								const [name, setName] = createSignal(
									presets.query.data?.presets[dialog().presetIndex].name!,
								);

								const renamePreset = createMutation(() => ({
									mutationFn: async () =>
										presets.renamePreset(dialog().presetIndex, name()),
									onSuccess: () => {
										setDialog((d) => ({ ...d, open: false }));
									},
								}));

								return (
									<DialogContent
										title="Rename Preset"
										confirm={
											<Dialog.ConfirmButton
												disabled={renamePreset.isPending}
												onClick={() => renamePreset.mutate()}
											>
												Rename
											</Dialog.ConfirmButton>
										}
									>
										<Subfield name="Name" required />
										<Input
											class="mt-2"
											value={name()}
											onInput={(e) => setName(e.currentTarget.value)}
										/>
									</DialogContent>
								);
							}}
						</Match>
						<Match
							when={(() => {
								const d = dialog();
								if (d.type === "deletePreset") return d;
							})()}
						>
							{(dialog) => {
								const deletePreset = createMutation(() => ({
									mutationFn: async () => {
										await presets.deletePreset(dialog().presetIndex);
										await presets.query.refetch();
									},
									onSuccess: () => {
										setDialog((d) => ({ ...d, open: false }));
									},
								}));

								return (
									<DialogContent
										title="Delete Preset"
										confirm={
											<Dialog.ConfirmButton
												variant="destructive"
												onClick={() => deletePreset.mutate()}
												disabled={deletePreset.isPending}
											>
												Delete
											</Dialog.ConfirmButton>
										}
									>
										<p class="text-gray-11">
											Are you sure you want to delete this preset?
										</p>
									</DialogContent>
								);
							}}
						</Match>
						<Match
							when={(() => {
								const d = dialog();
								if (d.type === "crop") return d;
							})()}
						>
							{(dialog) => {
								const { setProject: setState, editorInstance } =
									useEditorContext();
								const display = editorInstance.recordings.segments[0].display;

								let cropperRef: CropperRef | undefined;
								const [crop, setCrop] = createSignal(CROP_ZERO);
								const [aspect, setAspect] = createSignal<Ratio | null>(null);

								const [frameBlobUrl, setFrameBlobUrl] = createSignal<
									string | null
								>(null);

								const playerCanvas = document.getElementById(
									"canvas",
								) as HTMLCanvasElement | null;
								if (playerCanvas) {
									playerCanvas.toBlob((blob) => {
										if (blob) {
											const url = URL.createObjectURL(blob);
											setFrameBlobUrl(url);
										}
									}, "image/png");
								}

								onCleanup(() => {
									const url = frameBlobUrl();
									if (url) {
										URL.revokeObjectURL(url);
									}
								});

								const initialBounds = {
									x: dialog().position.x,
									y: dialog().position.y,
									width: dialog().size.x,
									height: dialog().size.y,
								};

								const [snapToRatio, setSnapToRatioEnabled] = makePersisted(
									createSignal(true),
									{ name: "editorCropSnapToRatio" },
								);

								async function showCropOptionsMenu(
									e: UIEvent,
									positionAtCursor = false,
								) {
									e.preventDefault();
									const items = createCropOptionsMenuItems({
										aspect: aspect(),
										snapToRatioEnabled: snapToRatio(),
										onAspectSet: setAspect,
										onSnapToRatioSet: setSnapToRatioEnabled,
									});
									const menu = await Menu.new({ items });
									let pos: LogicalPosition | undefined;
									if (!positionAtCursor) {
										const rect = (
											e.target as HTMLDivElement
										).getBoundingClientRect();
										pos = new LogicalPosition(rect.x, rect.y + 40);
									}
									await menu.popup(pos);
									await menu.close();
								}

								function BoundInput(props: {
									field: keyof CropBounds;
									min?: number;
									max?: number;
								}) {
									return (
										<NumberField
											value={crop()[props.field]}
											minValue={props.min}
											maxValue={props.max}
											onRawValueChange={(v) => {
												cropperRef?.setCropProperty(props.field, v);
											}}
											changeOnWheel={true}
											format={false}
										>
											<NumberField.Input
												class="rounded-[0.5rem] bg-gray-2 hover:ring-1 py-[18px] hover:ring-gray-5 h-[2rem] font-normal placeholder:text-black-transparent-40 text-xs caret-gray-500 transition-shadow duration-200 focus:ring-offset-1 focus:bg-gray-3 focus:ring-offset-gray-100 focus:ring-1 focus:ring-gray-10 px-[0.5rem] w-full text-[0.875rem] outline-none text-gray-12"
												onKeyDown={composeEventHandlers<HTMLInputElement>([
													(e) => e.stopPropagation(),
												])}
											/>
										</NumberField>
									);
								}

								return (
									<>
										<Dialog.Header>
											<div class="flex flex-row space-x-[2rem]">
												<div class="flex flex-row items-center space-x-[0.75rem] text-gray-11">
													<span>Size</span>
													<div class="w-[3.25rem]">
														<BoundInput field="width" max={display.width} />
													</div>
													<span>×</span>
													<div class="w-[3.25rem]">
														<BoundInput field="height" max={display.height} />
													</div>
												</div>
												<div class="flex flex-row items-center space-x-[0.75rem] text-gray-11">
													<span>Position</span>
													<div class="w-[3.25rem]">
														<BoundInput field="x" />
													</div>
													<span>×</span>
													<div class="w-[3.25rem]">
														<BoundInput field="y" />
													</div>
												</div>
											</div>
											<div class="flex flex-row gap-3 justify-end items-center w-full">
												<div class="flex flex-row items-center space-x-[0.5rem] text-gray-11"></div>

												<Button
													variant="white"
													size="xs"
													class="flex items-center justify-center text-center rounded-full h-[2rem] w-[2rem] border focus:border-blue-9"
													onMouseDown={showCropOptionsMenu}
													onClick={showCropOptionsMenu}
												>
													<div class="relative pointer-events-none size-4">
														<Show when={!aspect()}>
															<IconLucideRatio class="group-active:scale-90 transition-transform size-4 pointer-events-none *:pointer-events-none" />
														</Show>
														<Transition
															enterClass="scale-50 opacity-0 blur-md"
															enterActiveClass="duration-200 [transition-timing-function:cubic-bezier(0.215,0.61,0.355,1)]"
															enterToClass="scale-100 opacity-100 blur-0"
															exitClass="opacity-0"
															exitActiveClass="duration-0"
															exitToClass="opacity-0"
														>
															<Show when={aspect()} keyed>
																{(ratio) => (
																	<span class="flex absolute inset-0 justify-center items-center text-xs font-medium tracking-tight leading-none pointer-events-none text text-blue-10">
																		{ratio[0]}:{ratio[1]}
																	</span>
																)}
															</Show>
														</Transition>
													</div>
												</Button>

												<EditorButton
													leftIcon={<IconLucideMaximize />}
													onClick={() => cropperRef?.fill()}
													disabled={
														crop().width === display.width &&
														crop().height === display.height
													}
												>
													Full
												</EditorButton>
												<EditorButton
													leftIcon={<IconCapCircleX />}
													onClick={() => {
														cropperRef?.reset();
														setAspect(null);
													}}
													disabled={
														crop().x === dialog().position.x &&
														crop().y === dialog().position.y &&
														crop().width === dialog().size.x &&
														crop().height === dialog().size.y
													}
												>
													Reset
												</EditorButton>
											</div>
										</Dialog.Header>
										<Dialog.Content>
											<div class="flex flex-row justify-center">
												<div class="rounded divide-black-transparent-10">
													<Cropper
														ref={cropperRef}
														onCropChange={setCrop}
														aspectRatio={aspect() ?? undefined}
														targetSize={{ x: display.width, y: display.height }}
														initialCrop={initialBounds}
														snapToRatioEnabled={snapToRatio()}
														useBackdropFilter={true}
														allowLightMode={true}
														onContextMenu={(e) => showCropOptionsMenu(e, true)}
													>
														<img
															class="shadow pointer-events-none max-h-[70vh]"
															alt="Current frame"
															src={
																frameBlobUrl() ??
																convertFileSrc(
																	`${editorInstance.path}/screenshots/display.jpg`,
																)
															}
														/>
													</Cropper>
												</div>
											</div>
										</Dialog.Content>
										<Dialog.Footer>
											<Button
												onClick={() => {
													const bounds = crop();
													setState("background", "crop", {
														position: {
															x: bounds.x,
															y: bounds.y,
														},
														size: {
															x: bounds.width,
															y: bounds.height,
														},
													});
													setDialog((d) => ({ ...d, open: false }));
												}}
											>
												Save
											</Button>
										</Dialog.Footer>
									</>
								);
							}}
						</Match>
					</Switch>
				)}
			</Show>
		</Dialog.Root>
	);
}
